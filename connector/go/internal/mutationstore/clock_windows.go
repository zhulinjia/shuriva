//go:build windows

package mutationstore

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	"golang.org/x/sys/windows"
	"runtime"
	"sync"
	"unsafe"
)

type SystemClock struct {
	mu     sync.Mutex
	proc   *windows.LazyProc
	epoch  string
	last   uint64
	failed bool
}

// NewClock is created once per Connector process and shared by all attempts.
// Its epoch/100ns count are never reconstructed from persisted UTC timestamps.
func NewClock() (*SystemClock, error) {
	if runtime.GOARCH != "amd64" || windows.RtlGetVersion().MajorVersion < 10 {
		return nil, errors.New("mutation clock requires Windows 10+ amd64")
	}
	proc := windows.NewLazySystemDLL("api-ms-win-core-realtime-l1-1-1.dll").NewProc("QueryInterruptTimePrecise")
	if proc.Find() != nil {
		return nil, errors.New("sleep-inclusive mutation clock unavailable")
	}
	var boot [32]byte
	if _, err := rand.Read(boot[:]); err != nil {
		return nil, err
	}
	c := &SystemClock{proc: proc, epoch: hex.EncodeToString(boot[:])}
	if _, err := c.Read(); err != nil {
		return nil, err
	}
	return c, nil
}
func (c *SystemClock) Read() (mutationrunner.Reading, error) {
	if c == nil || c.proc == nil {
		return mutationrunner.Reading{}, ErrJournal
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.failed {
		return mutationrunner.Reading{}, ErrJournal
	}
	var count uint64
	c.proc.Call(uintptr(unsafe.Pointer(&count)))
	runtime.KeepAlive(&count)
	if count == 0 || count < c.last {
		c.failed = true
		return mutationrunner.Reading{}, ErrJournal
	}
	c.last = count
	return mutationrunner.Reading{Epoch: c.epoch, Ticks: count}, nil
}
