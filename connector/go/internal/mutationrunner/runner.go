package mutationrunner

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sync"
	"time"

	"example.com/ai-database-workspace/connector/internal/mutationguard"
)

const ticksPerSecond uint64 = 10_000_000
const leaseTicks = 120 * ticksPerSecond
const transactionTicks = 15 * ticksPerSecond
const permitTicks = 3 * ticksPerSecond
const reserveTicks = ticksPerSecond / 10

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var generationPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var errorCodePattern = regexp.MustCompile(`^[a-z_]{1,48}$`)

type Config struct {
	Binding     Binding
	Policies    map[string]mutationguard.Policy
	HMACKey     []byte
	Coordinator *Coordinator
}

// Coordinator is shared by every alias of one verified physical catalog.
// Execution and the resulting freeze are serialized together.
type Coordinator struct {
	slot     chan struct{}
	activity chan struct{}
	mu       sync.Mutex
	frozen   bool
}

func NewCoordinator() *Coordinator {
	return &Coordinator{slot: make(chan struct{}, 1), activity: make(chan struct{}, 1)}
}

// TryMaintenance excludes the short registration window while the manager
// snapshots active preview IDs and cleans the shared journal. It never waits
// behind another operation, allowing unrelated targets to be cleaned promptly.
func (c *Coordinator) TryMaintenance(action func() error) (bool, error) {
	select {
	case c.activity <- struct{}{}:
		defer func() { <-c.activity }()
		return true, action()
	default:
		return false, nil
	}
}
func (c *Coordinator) beginRegistration(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case c.activity <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (c *Coordinator) endRegistration() { <-c.activity }
func (c *Coordinator) acquire(ctx context.Context) error {
	select {
	case c.slot <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ErrDenied
	}
}
func (c *Coordinator) release()       { <-c.slot }
func (c *Coordinator) isFrozen() bool { c.mu.Lock(); defer c.mu.Unlock(); return c.frozen }
func (c *Coordinator) freeze()        { c.mu.Lock(); c.frozen = true; c.mu.Unlock() }

type activeExecution struct {
	mu                 sync.Mutex
	execution          Execution
	cancel             context.CancelFunc
	cancelled, handoff bool
}
type Runner struct {
	config      Config
	target      Target
	journal     Journal
	clock       Clock
	platform    Platform
	clockEpoch  string
	mu          sync.Mutex
	active      map[string]*activeExecution
	closed      bool
	frozen      bool
	previewSlot chan struct{}
	workers     sync.WaitGroup
	workCancels map[uint64]context.CancelFunc
	nextWork    uint64
}
type leasePayload struct {
	PreviewID              string              `json:"previewId"`
	Binding                Binding             `json:"binding"`
	Plan                   mutationguard.Plan  `json:"plan"`
	Table                  mutationguard.Table `json:"table"`
	Rows                   []mutationguard.Row `json:"rows"`
	ClockEpoch             string              `json:"clockEpoch"`
	ExpiresTicks           uint64              `json:"expiresTicks"`
	ReconciliationDeadline int64               `json:"reconciliationDeadline"`
}

func validScope(s Scope) bool {
	return uuidPattern.MatchString(s.OwnerID) && uuidPattern.MatchString(s.WorkspaceID) && uuidPattern.MatchString(s.SourceID) && uuidPattern.MatchString(s.ConnectorID)
}
func validBinding(b Binding) bool {
	return validScope(b.Scope) && generationPattern.MatchString(b.APIBoot) && generationPattern.MatchString(b.ConnectorBoot) && b.TargetIdentity != "" && len(b.TargetIdentity) <= 160 && generationPattern.MatchString(b.TargetEpoch) && b.PolicyGeneration != "" && len(b.PolicyGeneration) <= 160 && b.InstallationGeneration != "" && len(b.InstallationGeneration) <= 160
}
func New(config Config, target Target, journal Journal, clock Clock, platform Platform) (*Runner, error) {
	if !validBinding(config.Binding) || len(config.HMACKey) != 32 || target == nil || journal == nil || clock == nil || platform == nil || len(config.Policies) == 0 || len(config.Policies) > 100 {
		return nil, ErrDenied
	}
	reading, err := clock.Read()
	if err != nil || reading.Epoch == "" || reading.Ticks == 0 {
		return nil, ErrDenied
	}
	copyConfig := config
	if copyConfig.Coordinator == nil {
		copyConfig.Coordinator = NewCoordinator()
	}
	if copyConfig.Coordinator.slot == nil {
		return nil, ErrDenied
	}
	copyConfig.HMACKey = append([]byte(nil), config.HMACKey...)
	copyConfig.Policies = map[string]mutationguard.Policy{}
	for name, p := range config.Policies {
		if name != p.Table || !mutationguard.ValidIdentifier(name) || p.Generation != config.Binding.PolicyGeneration {
			return nil, ErrDenied
		}
		// Serialization makes the accepted local configuration immutable to its
		// caller, including the nested row predicate values and column slices.
		raw, err := json.Marshal(p)
		if err != nil {
			return nil, ErrDenied
		}
		var copied mutationguard.Policy
		if json.Unmarshal(raw, &copied) != nil {
			return nil, ErrDenied
		}
		copyConfig.Policies[name] = copied
	}
	return &Runner{config: copyConfig, target: target, journal: journal, clock: clock, platform: platform, clockEpoch: reading.Epoch, active: map[string]*activeExecution{}, previewSlot: make(chan struct{}, 1), workCancels: map[uint64]context.CancelFunc{}}, nil
}

func (r *Runner) work(ctx context.Context) (context.Context, func(), error) {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil, nil, ErrDenied
	}
	operation, cancel := context.WithCancel(ctx)
	r.nextWork++
	id := r.nextWork
	r.workCancels[id] = cancel
	r.workers.Add(1)
	r.mu.Unlock()
	return operation, func() { cancel(); r.mu.Lock(); delete(r.workCancels, id); r.mu.Unlock(); r.workers.Done() }, nil
}
func randomID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", ErrDenied
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}
func (r *Runner) read() (Reading, error) {
	v, err := r.clock.Read()
	if err != nil || v.Epoch != r.clockEpoch || v.Ticks == 0 {
		return Reading{}, ErrDenied
	}
	return v, nil
}
func addTicks(start, amount uint64) (uint64, error) {
	if start > math.MaxUint64-amount {
		return 0, ErrDenied
	}
	return start + amount, nil
}
func (r *Runner) commitment(payload []byte) string {
	return payloadCommitment(r.config.HMACKey, payload)
}
func payloadCommitment(key, payload []byte) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("mutation-preview-v1\x00"))
	mac.Write(payload)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func contentHash(v any) (string, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return "", ErrDenied
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}
func sameRow(a, b mutationguard.Row) bool {
	ah, e1 := contentHash(a)
	bh, e2 := contentHash(b)
	return e1 == nil && e2 == nil && ah == bh
}
func cloneRow(row mutationguard.Row) mutationguard.Row {
	out := mutationguard.Row{}
	for k, v := range row {
		out[k] = v
	}
	return out
}
func key(t mutationguard.Table, row mutationguard.Row) (mutationguard.Row, error) {
	out := mutationguard.Row{}
	for _, c := range mutationguard.Primary(t) {
		v, ok := row[c.Name]
		if !ok || v.Kind == "null" {
			return nil, ErrDenied
		}
		out[c.Name] = v
	}
	return out, nil
}
func unchangedTable(a, b mutationguard.Table) bool {
	first, err := mutationguard.StructuralDefinition(a.Definition, a.SQLMode)
	if err != nil {
		return false
	}
	second, err := mutationguard.StructuralDefinition(b.Definition, b.SQLMode)
	if err != nil {
		return false
	}
	a.Definition, b.Definition = first, second
	ah, e1 := contentHash(a)
	bh, e2 := contentHash(b)
	return e1 == nil && e2 == nil && ah == bh
}
func (r *Runner) ready(ctx context.Context) error {
	r.mu.Lock()
	closed := r.closed
	frozenInMemory := r.frozen
	r.mu.Unlock()
	if closed {
		return ErrDenied
	}
	if frozenInMemory || r.config.Coordinator.isFrozen() {
		return ErrFrozen
	}
	frozen, err := r.journal.IsFrozen(ctx, r.config.Binding.TargetIdentity)
	if err != nil {
		return err
	}
	if frozen {
		return ErrFrozen
	}
	return nil
}
func (r *Runner) freeze(ctx context.Context, code string) {
	r.mu.Lock()
	r.frozen = true
	r.mu.Unlock()
	r.config.Coordinator.freeze()
	_ = r.journal.Freeze(ctx, r.config.Binding.TargetIdentity, code)
}

// Block is a one-way local safety latch for the authenticated coordinator.
// Missing evidence for an old binding can freeze aliases, never authorize it.
func (r *Runner) Block(ctx context.Context, code string) {
	if !errorCodePattern.MatchString(code) {
		code = "recovery_unproven"
	}
	r.freeze(ctx, code)
}
func (r *Runner) loadLease(ctx context.Context, e Execution) (leasePayload, error) {
	var payload leasePayload
	l, err := r.journal.LoadLease(ctx, e.PreviewID, e.Scope)
	if err != nil {
		if !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrDenied) && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			r.freeze(context.WithoutCancel(ctx), "journal_unavailable")
		}
		return payload, ErrDenied
	}
	if r.commitment(l.Payload) != l.Commitment || json.Unmarshal(l.Payload, &payload) != nil {
		r.freeze(context.WithoutCancel(ctx), "journal_unavailable")
		return leasePayload{}, ErrDenied
	}
	if l.Commitment != e.Commitment || payload.PreviewID != e.PreviewID || payload.Binding != e.Binding || e.Revision != 1 {
		return leasePayload{}, ErrDenied
	}
	now, err := r.read()
	if err != nil || payload.ClockEpoch != now.Epoch || now.Ticks >= payload.ExpiresTicks {
		return leasePayload{}, ErrDenied
	}
	return payload, nil
}
func validExecution(e Execution) bool {
	raw, err := base64.RawURLEncoding.DecodeString(e.Commitment)
	return validBinding(e.Binding) && uuidPattern.MatchString(e.ExecutionID) && uuidPattern.MatchString(e.PreviewID) && e.Revision == 1 && err == nil && len(raw) == 32 && base64.RawURLEncoding.EncodeToString(raw) == e.Commitment
}
func result(record Record) Result {
	value := Result{Execution: record.Execution, State: record.State, Code: record.Code, RowCount: record.RowCount}
	if record.ReconciliationExpiresAt > 0 {
		value.ReconciliationExpiresAt = time.Unix(record.ReconciliationExpiresAt, 0).UTC().Format(time.RFC3339)
	}
	return value
}
func recordError(e Execution, state, code string, count int) Record {
	return Record{Execution: e, State: state, Code: code, RowCount: count}
}

// Stop cancels in-flight work without waiting; Close also drains it. This
// lets a manager revoke all targets before waiting on any one slow target.
func (r *Runner) Stop() {
	r.mu.Lock()
	r.closed = true
	cancels := make([]context.CancelFunc, 0, len(r.workCancels))
	for _, cancel := range r.workCancels {
		cancels = append(cancels, cancel)
	}
	r.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}

}
func (r *Runner) Close() {
	r.Stop()
	r.workers.Wait()
}

// Managers sharing a journal must union these IDs across all live runners
// before cleanup; a preview TTL never deletes an active execution's payload.
func (r *Runner) ActivePreviewIDs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	ids := make([]string, 0, len(r.active))
	for _, active := range r.active {
		ids = append(ids, active.execution.PreviewID)
	}
	return ids
}

func (r *Runner) retainUnknown(ctx context.Context, record *Record) {
	deadline, err := RetainReconciliation(ctx, r.journal, record.Execution, r.config.HMACKey)
	if deadline > 0 {
		if record.ReconciliationExpiresAt != 0 && record.ReconciliationExpiresAt != deadline {
			r.freeze(ctx, "reconciliation_unavailable")
			record.Code = "reconciliation_unavailable"
			return
		}
		record.ReconciliationExpiresAt = deadline
	}
	if err != nil {
		r.freeze(ctx, "reconciliation_unavailable")
		record.Code = "reconciliation_unavailable"
		if errors.Is(err, ErrExpired) {
			record.Code = "reconciliation_expired"
		}
	}
}

// RetainReconciliation is also used by the startup coordinator before lease
// cleanup. It never grants execution and never derives a new retention window.
func RetainReconciliation(ctx context.Context, journal Journal, e Execution, key []byte) (int64, error) {
	if journal == nil || len(key) != 32 || !validExecution(e) {
		return 0, ErrDenied
	}
	lease, err := journal.LoadLease(ctx, e.PreviewID, e.Scope)
	if err != nil {
		return 0, err
	}
	var payload leasePayload
	if lease.ID != e.PreviewID || lease.Scope != e.Scope || lease.Commitment != e.Commitment || payloadCommitment(key, lease.Payload) != lease.Commitment || json.Unmarshal(lease.Payload, &payload) != nil || payload.PreviewID != e.PreviewID || payload.Binding != e.Binding || payload.ReconciliationDeadline <= 0 || lease.ReconciliationExpiresAt != payload.ReconciliationDeadline {
		return 0, ErrDenied
	}
	deadline := payload.ReconciliationDeadline
	if deadline <= time.Now().Unix() {
		if err := journal.DeleteOwnedLease(ctx, e); err != nil {
			return deadline, err
		}
		return deadline, ErrExpired
	}
	if err := journal.RetainLease(ctx, e.PreviewID, e.Scope, deadline); err != nil {
		return deadline, err
	}
	return deadline, nil
}

func (r *Runner) clearPayload(ctx context.Context, e Execution) {
	if err := r.journal.DeleteOwnedLease(ctx, e); err != nil {
		r.freeze(ctx, "payload_cleanup_failed")
	}
}
func (r *Runner) Status(ctx context.Context, scope Scope, id string) (Result, error) {
	if scope != r.config.Binding.Scope || !uuidPattern.MatchString(id) {
		return Result{}, ErrDenied
	}
	operation, finish, err := r.work(ctx)
	if err != nil {
		return Result{}, err
	}
	defer finish()
	ctx = operation
	record, err := r.journal.Get(ctx, id, scope)
	if err != nil {
		if !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrDenied) {
			r.freeze(context.WithoutCancel(ctx), "journal_unavailable")
		}
		return Result{}, err
	}
	if record.State == "committed" || record.State == "rolled_back" || record.State == "rejected" {
		return result(record), nil
	}
	r.mu.Lock()
	_, running := r.active[id]
	r.mu.Unlock()
	if running {
		return result(record), nil
	}
	if record.State != "outcome_unknown" {
		record.State = "outcome_unknown"
		record.Code = "restarted"
		r.retainUnknown(ctx, &record)
		_ = r.journal.Transition(ctx, record)
		r.freeze(ctx, "restarted")
	}
	if record.State != "outcome_unknown" {
		return result(record), nil
	}
	receipt, err := r.target.Receipt(ctx, scope, id)
	if err != nil || receipt == nil {
		return result(record), nil
	}
	e := record.Execution
	if receipt.ExecutionID != id || receipt.Commitment != e.Commitment || receipt.Scope != scope || receipt.TargetIdentity != e.TargetIdentity || receipt.TargetEpoch != e.TargetEpoch || receipt.RowCount < 1 || receipt.RowCount > mutationguard.MaxRows {
		return result(record), ErrDenied
	}
	record.State, record.Code, record.RowCount = "committed", "", receipt.RowCount
	if r.journal.Transition(ctx, record) != nil {
		r.freeze(ctx, "journal_unavailable")
	}
	r.clearPayload(ctx, e)
	return result(record), nil
}
func (r *Runner) Cancel(ctx context.Context, scope Scope, id string) (Result, error) {
	if scope != r.config.Binding.Scope || !uuidPattern.MatchString(id) {
		return Result{}, ErrDenied
	}
	operation, finish, err := r.work(ctx)
	if err != nil {
		return Result{}, err
	}
	defer finish()
	ctx = operation
	r.mu.Lock()
	a := r.active[id]
	r.mu.Unlock()
	if a != nil {
		a.mu.Lock()
		if !a.handoff {
			a.cancelled = true
			a.cancel()
		}
		a.mu.Unlock()
		return r.Status(ctx, scope, id)
	}
	record, err := r.journal.Get(ctx, id, scope)
	if err != nil {
		if !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrDenied) {
			r.freeze(context.WithoutCancel(ctx), "journal_unavailable")
		}
		return Result{}, err
	}
	if record.State == "accepted" {
		record.State, record.Code = "rejected", "cancelled"
		if err := r.journal.Transition(ctx, record); err != nil {
			return Result{}, err
		}
	}
	return result(record), nil
}

// A failed write to a local safety record itself closes admission. The error
// returned here is deliberately stable and never contains driver details.
func (r *Runner) persist(ctx context.Context, record Record) error {
	if r.journal.Transition(ctx, record) != nil {
		r.freeze(ctx, "journal_unavailable")
		return ErrUnknown
	}
	return nil
}
