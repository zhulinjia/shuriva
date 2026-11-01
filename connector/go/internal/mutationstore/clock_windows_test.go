//go:build windows

package mutationstore

import (
	"math"
	"runtime"
	"testing"
	"time"
)

func TestSystemClockUsesPublishedSleepInclusiveAPISafely(t *testing.T) {
	clock, err := NewClock()
	if runtime.GOARCH != "amd64" {
		if err == nil {
			t.Fatal("unsupported architecture admitted")
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	before, err := clock.Read()
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	after, err := clock.Read()
	if err != nil || before.Epoch != after.Epoch || after.Ticks <= before.Ticks {
		t.Fatal("current process clock did not advance")
	}
	other, err := NewClock()
	if err != nil {
		t.Fatal(err)
	}
	reading, err := other.Read()
	if err != nil || reading.Epoch == before.Epoch {
		t.Fatal("clock lifecycle reused an epoch")
	}
	t.Log("ordinary wait probe only; no hardware sleep, wall clock or power settings changed")
}

func TestG4WindowsClockRollbackLatchesFailure(t *testing.T) {
	clock, err := NewClock()
	if err != nil {
		t.Fatal(err)
	}
	clock.last = math.MaxUint64
	if _, err := clock.Read(); err == nil {
		t.Fatal("backward system reading accepted")
	}
	clock.last = 0
	if _, err := clock.Read(); err == nil {
		t.Fatal("a later normal system reading revived a failed clock")
	}
}
