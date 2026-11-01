package g2

import (
	"errors"
	"math"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type timingFakeClock struct {
	reading timingReading
	err     error
	wall    time.Time // deliberately never read by the gate
}

func (c *timingFakeClock) Read() (timingReading, error) { return c.reading, c.err }

func TestTimingHandoffDeadlineVectors(t *testing.T) {
	const start = uint64(100 * time.Second / timingTick)
	for _, tc := range []struct {
		name    string
		elapsed time.Duration
		ok      bool
	}{
		{"within-window", time.Second, true},
		{"one-tick-before-reserve", 2900*time.Millisecond - timingTick, true},
		{"at-reserve", 2900 * time.Millisecond, false},
		{"exact-budget", 3 * time.Second, false},
		{"permit-response-delayed", 7 * time.Second, false},
		{"resume-after-synthetic-suspend", 30 * time.Minute, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			clock := &timingFakeClock{reading: timingReading{"process", start}}
			gate, err := newTimingGate(clock, timingDeadline{"process", start + 10*timingPermitTicks})
			if err != nil {
				t.Fatal(err)
			}
			called := 0
			err = gate.handoff(func() error {
				// Persistence, network and OS scheduling all consume the ORIGINAL
				// counter budget; intent completion does not start a new budget.
				clock.reading.Ticks += uint64(tc.elapsed / timingTick)
				return nil
			}, func() error { called++; return nil })
			if (err == nil) != tc.ok || (called == 1) != tc.ok {
				t.Fatalf("error=%v handoffs=%d expected-allowed=%v", err, called, tc.ok)
			}
			clock.reading.Ticks = start + 1
			if gate.handoff(func() error { return nil }, func() error { called++; return nil }) == nil || called > 1 {
				t.Fatal("retry or recovered clock re-enabled a used/invalid attempt")
			}
		})
	}
}

func TestTimingClockFaultsAndRestartLatchClosed(t *testing.T) {
	for _, fault := range []string{"read-error", "backwards", "new-process", "persist-error"} {
		t.Run(fault, func(t *testing.T) {
			clock := &timingFakeClock{reading: timingReading{"process", 100000000}}
			gate, err := newTimingGate(clock, timingDeadline{"process", 500000000})
			if err != nil {
				t.Fatal(err)
			}
			err = gate.handoff(func() error {
				switch fault {
				case "read-error":
					clock.err = errors.New("clock unavailable")
				case "backwards":
					clock.reading.Ticks--
				case "new-process":
					clock.reading.Epoch = "restarted"
				case "persist-error":
					return errors.New("journal unavailable")
				}
				return nil
			}, func() error { t.Fatal("fault granted handoff"); return nil })
			if err == nil {
				t.Fatal("fault was ignored")
			}
			clock.err, clock.reading = nil, timingReading{"process", 100000001}
			if gate.handoff(func() error { return nil }, func() error { t.Fatal("fault latch reopened"); return nil }) == nil {
				t.Fatal("attempt recovered automatically after clock/persistence fault")
			}
		})
	}
	for _, tc := range []struct {
		reading  timingReading
		deadline timingDeadline
	}{
		{timingReading{"", 1}, timingDeadline{"", timingPermitTicks}},
		{timingReading{"p", math.MaxUint64}, timingDeadline{"p", math.MaxUint64}},
		{timingReading{"p", 1}, timingDeadline{"other", timingPermitTicks}},
		{timingReading{"p", 1}, timingDeadline{"p", timingReserveTicks}},
	} {
		if _, err := newTimingGate(&timingFakeClock{reading: tc.reading}, tc.deadline); err == nil {
			t.Fatal("invalid epoch, overflow or exhausted transaction deadline accepted")
		}
	}
}

func TestTimingWallClockDoesNotExtendAttempt(t *testing.T) {
	for _, wall := range []time.Time{time.Unix(-100000, 0), time.Unix(1<<50, 0)} {
		clock := &timingFakeClock{reading: timingReading{"process", 100000000}, wall: time.Now()}
		gate, err := newTimingGate(clock, timingDeadline{"process", 500000000})
		if err != nil {
			t.Fatal(err)
		}
		clock.wall = wall
		clock.reading.Ticks += timingPermitTicks
		if gate.handoff(func() error { return nil }, func() error { t.Fatal("wall time reset counter deadline"); return nil }) == nil {
			t.Fatal("expired permit accepted")
		}
	}
}

func TestTimingHandoffIsSingleUseAfterLostReplyAndPause(t *testing.T) {
	clock := &timingFakeClock{reading: timingReading{"process", 100000000}}
	gate, err := newTimingGate(clock, timingDeadline{"process", 500000000})
	if err != nil {
		t.Fatal(err)
	}
	var called atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = gate.handoff(func() error { return nil }, func() error {
				called.Add(1)
				// A user-mode pause after handoff cannot safely be relabeled as
				// rollback. Even a lost response must never permit another call.
				clock.reading.Ticks += 100 * timingPermitTicks
				return errors.New("commit response lost; outcome unknown")
			})
		}()
	}
	wg.Wait()
	if called.Load() != 1 || !gate.used {
		t.Fatal("commit handoff was not exactly once")
	}
}

func TestTimingShorterTransactionDeadlineWins(t *testing.T) {
	clock := &timingFakeClock{reading: timingReading{"process", 100000000}}
	gate, err := newTimingGate(clock, timingDeadline{"process", 110000000})
	if err != nil {
		t.Fatal(err)
	}
	clock.reading.Ticks += 9000000 // exactly 100ms reserve before transaction deadline
	if gate.handoff(func() error { return nil }, func() error { t.Fatal("transaction budget exceeded"); return nil }) == nil {
		t.Fatal("permit ignored shorter transaction deadline")
	}
}
