package g2

// This experiment defines the measurable authorization boundary: a single
// handoff to Commit while the policy lock is held. It does not make a user-mode
// process a real-time scheduler or promise when the server receives a packet.
// The final clock sample is the qualification linearization point under the
// lock, not the later instruction that assigns used or invokes the driver.
import (
	"errors"
	"math"
	"sync"
	"time"
)

const timingTick = 100 * time.Nanosecond
const timingPermitTicks = uint64(3 * time.Second / timingTick)
const timingReserveTicks = uint64(100 * time.Millisecond / timingTick)

var errTimingRefused = errors.New("commit handoff clock refused")

type timingReading struct {
	Epoch string
	Ticks uint64
}

type timingSource interface {
	Read() (timingReading, error)
}

type timingDeadline struct {
	Epoch string
	Ticks uint64
}

type timingGate struct {
	mu            sync.Mutex
	clock         timingSource
	epoch         string
	start, last   uint64
	deadline      uint64
	invalid, used bool
}

// The initial read is taken before sending the first permit request. A caller
// must never recreate this object on retry, deserialize it, or reuse it after
// restart. The shorter transaction deadline is from the very same clock epoch.
func newTimingGate(clock timingSource, transaction timingDeadline) (*timingGate, error) {
	if clock == nil {
		return nil, errTimingRefused
	}
	r, err := clock.Read()
	if err != nil || r.Epoch == "" || r.Epoch != transaction.Epoch ||
		r.Ticks > math.MaxUint64-timingPermitTicks {
		return nil, errTimingRefused
	}
	deadline := r.Ticks + timingPermitTicks
	if transaction.Ticks < deadline {
		deadline = transaction.Ticks
	}
	if deadline <= r.Ticks || deadline-r.Ticks <= timingReserveTicks {
		return nil, errTimingRefused
	}
	return &timingGate{clock: clock, epoch: r.Epoch, start: r.Ticks, last: r.Ticks, deadline: deadline}, nil
}

// persistIntent happens BEFORE the final clock read. In production the caller
// must also hold the same policy/cancellation lock and validate the signed
// challenge, binding and current authorization. This clock alone grants none.
//
// handoff is called at most once, even if it reports a lost reply. A handoff
// error means outcome-unknown until an independent database fact proves more.
func (g *timingGate) handoff(persistIntent func() error, commit func() error) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.invalid || g.used || persistIntent == nil || commit == nil {
		return errTimingRefused
	}
	if err := persistIntent(); err != nil {
		g.invalid = true
		return err
	}
	r, err := g.clock.Read()
	if err != nil || r.Epoch != g.epoch || r.Ticks < g.last || r.Ticks < g.start ||
		r.Ticks >= g.deadline || g.deadline-r.Ticks <= timingReserveTicks {
		g.invalid = true
		return errTimingRefused
	}
	g.last = r.Ticks
	g.used = true // records the handoff qualified at the final clock sample above
	return commit()
}
