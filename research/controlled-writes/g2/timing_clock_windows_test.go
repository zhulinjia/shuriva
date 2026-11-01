//go:build windows

package g2

import (
	"testing"
	"time"
)

func TestTimingWindowsDocumentedClockAndHandoff(t *testing.T) {
	clock, err := newTimingWindowsClock()
	if err != nil {
		t.Fatal(err)
	}
	start, err := clock.Read()
	if err != nil {
		t.Fatal(err)
	}
	gate, err := newTimingGate(clock, timingDeadline{start.Epoch, start.Ticks + 10*timingPermitTicks})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(40 * time.Millisecond) // ordinary process wait; does not suspend Windows
	end, err := clock.Read()
	if err != nil || end.Epoch != start.Epoch || end.Ticks <= start.Ticks {
		t.Fatal("documented clock did not advance in a stable process epoch")
	}
	if err := gate.handoff(func() error { return nil }, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	restarted, err := newTimingWindowsClock()
	if err != nil || restarted.epoch == clock.epoch {
		t.Fatal("new clock lifecycle reused an old process epoch")
	}
	t.Logf("official API-set safe system loading; elapsed=%v; unique process epoch; final-read handoff passed; real suspend and physical wire deadline NOT asserted", time.Duration(end.Ticks-start.Ticks)*timingTick)
}
