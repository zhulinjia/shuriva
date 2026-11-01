//go:build windows

package g2

import (
	"fmt"
	"runtime"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const protocolRealtimeAPISet = "api-ms-win-core-realtime-l1-1-1.dll"

// This one additional module is explicitly documented for these exports in
// Microsoft's API catalog. Do not enumerate guessed backing DLLs on failure.
// https://github.com/MicrosoftDocs/winrt-related/blob/docs/winrt-related-src/win32-and-com/win32-apis.md
func protocolAPISetInterruptTime(name string) (uint64, error) {
	p := windows.NewLazySystemDLL(protocolRealtimeAPISet).NewProc(name)
	if err := p.Find(); err != nil {
		return 0, fmt.Errorf("documented API-set %s: %w", protocolRealtimeAPISet, err)
	}
	var count uint64
	p.Call(uintptr(unsafe.Pointer(&count))) // documented VOID(PULONGLONG)
	runtime.KeepAlive(&count)
	if count == 0 {
		return 0, fmt.Errorf("%s returned zero", name)
	}
	return count, nil
}

func TestProtocolWindowsAPISetClockCandidateReadOnlyObservation(t *testing.T) {
	t.Logf("toolchain=%s target=%s/%s documented-module=%s", runtime.Version(), runtime.GOOS, runtime.GOARCH, protocolRealtimeAPISet)
	var before [2]uint64
	names := [2]string{"QueryInterruptTimePrecise", "QueryUnbiasedInterruptTimePrecise"}
	for i, name := range names {
		var err error
		before[i], err = protocolAPISetInterruptTime(name)
		if err != nil {
			t.Errorf("API-set candidate capability %s unavailable: %v", name, err)
		}
	}
	if t.Failed() {
		return
	}
	start := time.Now()
	time.Sleep(40 * time.Millisecond) // normal process wait; no OS sleep/hibernate
	for i, name := range names {
		after, err := protocolAPISetInterruptTime(name)
		if err != nil || after <= before[i] {
			t.Errorf("API-set candidate %s failed to advance: %v", name, err)
			continue
		}
		t.Logf("API-set candidate %s ordinary-wait delta=%v", name, time.Duration(after-before[i])*100)
	}
	t.Logf("Go ordinary-wait delta=%v; real suspend/hibernate, wall-clock changes, power transitions and production deadline margin NOT tested", time.Since(start))
	t.Log("Kernel32 candidate failure and its original logs remain unchanged; API-set loading success alone does not pass the suspend/resume admission gate")
}
