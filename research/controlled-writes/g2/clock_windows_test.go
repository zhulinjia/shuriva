//go:build windows

package g2

import (
	"encoding/json"
	"fmt"
	"runtime"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Clock reads only. This does not change timer resolution, power settings, wall
// clock or sleep state. No successful read is evidence of a real suspend test.
func protocolWindowsInterruptTime(name string) (uint64, error) {
	p := windows.NewLazySystemDLL("kernel32.dll").NewProc(name)
	if err := p.Find(); err != nil {
		return 0, err
	}
	var count uint64
	p.Call(uintptr(unsafe.Pointer(&count))) // documented VOID(PULONGLONG)
	runtime.KeepAlive(&count)
	if count == 0 {
		return 0, fmt.Errorf("%s returned zero", name)
	}
	return count, nil
}

func protocolWindowsTickCount() (uint64, error) {
	p := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetTickCount64")
	if err := p.Find(); err != nil {
		return 0, err
	}
	lo, hi, _ := p.Call()
	if runtime.GOARCH == "386" {
		return uint64(lo) | uint64(hi)<<32, nil
	}
	return uint64(lo), nil
}

func TestProtocolWindowsRetiredKernel32ClockCandidate(t *testing.T) {
	t.Logf("toolchain=%s target=%s/%s", runtime.Version(), runtime.GOOS, runtime.GOARCH)
	preciseStart, err := protocolWindowsInterruptTime("QueryInterruptTimePrecise")
	if err != nil {
		// Historical G2 failure is retained in the first-run logs. This export
		// route is retired, not claimed fixed. The selected adapter is separately
		// required to load the published system API-set and enforce the gate.
		t.Logf("retired Kernel32 candidate remains unavailable: %v", err)
		if _, selectedErr := newTimingWindowsClock(); selectedErr != nil {
			t.Fatalf("selected clock also unavailable; writes must remain closed: %v", selectedErr)
		}
		return
	}
	unbiasedStart, err := protocolWindowsInterruptTime("QueryUnbiasedInterruptTimePrecise")
	if err != nil {
		t.Fatal(err)
	}
	tickStart, err := protocolWindowsTickCount()
	if err != nil {
		t.Fatal(err)
	}
	goStart := time.Now()
	time.Sleep(40 * time.Millisecond) // process timer wait, not system sleep
	preciseEnd, err := protocolWindowsInterruptTime("QueryInterruptTimePrecise")
	if err != nil {
		t.Fatal(err)
	}
	unbiasedEnd, err := protocolWindowsInterruptTime("QueryUnbiasedInterruptTimePrecise")
	if err != nil {
		t.Fatal(err)
	}
	tickEnd, err := protocolWindowsTickCount()
	if err != nil {
		t.Fatal(err)
	}
	if preciseEnd <= preciseStart || unbiasedEnd <= unbiasedStart || tickEnd <= tickStart {
		t.Fatal("the observed clock did not advance during a process wait")
	}
	t.Logf("read-only Windows observation: precise=%v unbiased=%v GetTickCount64=%v Go=%v; real system suspend/hibernate and wall-clock adjustment NOT performed",
		time.Duration(preciseEnd-preciseStart)*100, time.Duration(unbiasedEnd-unbiasedStart)*100,
		time.Duration(tickEnd-tickStart)*time.Millisecond, time.Since(goStart))
	// The Go monotonic component cannot be recovered from a serialized timestamp.
	startJSON, err := json.Marshal(goStart)
	if err != nil {
		t.Fatal(err)
	}
	var restored time.Time
	if err := json.Unmarshal(startJSON, &restored); err != nil || !restored.Equal(goStart) {
		t.Fatal("timestamp serialization did not preserve the expected wall-time-only value")
	}
	if restored != restored.Round(0) || goStart == goStart.Round(0) {
		t.Fatal("serialized time unexpectedly retained the current process monotonic component")
	}
	t.Log("official references: https://pkg.go.dev/time#hdr-Monotonic_Clocks ; https://learn.microsoft.com/en-us/windows/win32/sysinfo/interrupt-time ; https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-gettickcount64")
}

// A separate candidate: observing this API does not make the precise-API
// experiment above pass or establish real suspend behavior for either clock.
func TestProtocolWindowsTickCountCandidateReadOnlyObservation(t *testing.T) {
	t.Logf("toolchain=%s target=%s/%s", runtime.Version(), runtime.GOOS, runtime.GOARCH)
	for _, name := range []string{"QueryInterruptTimePrecise", "QueryUnbiasedInterruptTimePrecise"} {
		if _, err := protocolWindowsInterruptTime(name); err != nil {
			t.Logf("candidate capability %s: unsupported (%v)", name, err)
		} else {
			t.Logf("candidate capability %s: available; real suspend NOT tested", name)
		}
	}
	start, err := protocolWindowsTickCount()
	if err != nil {
		t.Fatal(err)
	}
	goStart := time.Now()
	time.Sleep(40 * time.Millisecond) // ordinary process wait, not OS suspend
	end, err := protocolWindowsTickCount()
	if err != nil {
		t.Fatal(err)
	}
	if end <= start || time.Since(goStart) <= 0 {
		t.Fatal("candidate clock did not advance during the observed process wait")
	}
	t.Logf("separate candidate ordinary-wait observation: GetTickCount64=%v Go=%v; real suspend/hibernate, clock adjustment, clock resolution bound and production deadline margin NOT verified",
		time.Duration(end-start)*time.Millisecond, time.Since(goStart))
	encoded, err := json.Marshal(goStart)
	if err != nil {
		t.Fatal(err)
	}
	var restored time.Time
	if err := json.Unmarshal(encoded, &restored); err != nil || !restored.Equal(goStart) || restored != restored.Round(0) || goStart == goStart.Round(0) {
		t.Fatal("Go serialization did not demonstrate the expected loss of its process-local monotonic component")
	}
	t.Log("candidate selection remains gated: documented sleep-inclusive GetTickCount64 has coarse resolution; this process wait is not a substitute for target-system suspend/resume verification")
}
