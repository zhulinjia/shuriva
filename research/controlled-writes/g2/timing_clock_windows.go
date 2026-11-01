//go:build windows

package g2

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"runtime"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Uses the published Windows API-set, loaded only through the OS system-DLL
// search path. No KernelBase guessing, DLL search fallback or Go wall clock.
type timingWindowsClock struct {
	mu     sync.Mutex
	proc   *windows.LazyProc
	epoch  string
	last   uint64
	failed bool
}

func newTimingWindowsClock() (*timingWindowsClock, error) {
	if runtime.GOARCH != "amd64" || windows.RtlGetVersion().MajorVersion < 10 {
		return nil, errors.New("G2 clock supports only Windows 10+ amd64")
	}
	proc := windows.NewLazySystemDLL("api-ms-win-core-realtime-l1-1-1.dll").NewProc("QueryInterruptTimePrecise")
	if err := proc.Find(); err != nil {
		return nil, errors.New("documented sleep-inclusive clock unavailable; write handoff disabled")
	}
	var epoch [32]byte
	if _, err := rand.Read(epoch[:]); err != nil {
		return nil, errors.New("cannot create process clock epoch")
	}
	c := &timingWindowsClock{proc: proc, epoch: hex.EncodeToString(epoch[:])}
	if _, err := c.Read(); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *timingWindowsClock) Read() (timingReading, error) {
	if c == nil || c.proc == nil || c.epoch == "" {
		return timingReading{}, errTimingRefused
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.failed {
		return timingReading{}, errTimingRefused
	}
	var count uint64
	c.proc.Call(uintptr(unsafe.Pointer(&count))) // VOID(PULONGLONG); last-error is unspecified
	runtime.KeepAlive(&count)
	if count == 0 || count < c.last {
		c.failed = true
		return timingReading{}, errTimingRefused
	}
	c.last = count
	return timingReading{Epoch: c.epoch, Ticks: count}, nil
}
