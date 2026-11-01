package mutationrunner_test

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/mutationguard"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	"example.com/ai-database-workspace/connector/internal/mutationstore"
)

const owner = "11111111-1111-4111-8111-111111111111"
const workspace = "22222222-2222-4222-8222-222222222222"
const source = "33333333-3333-4333-8333-333333333333"
const connector = "44444444-4444-4444-8444-444444444444"
const executionID = "55555555-5555-4555-8555-555555555555"
const permitID = "66666666-6666-4666-8666-666666666666"

type fakeClock struct {
	mu    sync.Mutex
	ticks uint64
}

func (c *fakeClock) Read() (mutationrunner.Reading, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return mutationrunner.Reading{Epoch: "test-clock", Ticks: c.ticks}, nil
}
func (c *fakeClock) advance(ticks uint64) { c.mu.Lock(); c.ticks += ticks; c.mu.Unlock() }

type fakePlatform struct {
	mu               sync.Mutex
	clock            *fakeClock
	delay            uint64
	claims, permits  int
	entered, release chan struct{}
}

func (p *fakePlatform) Claim(context.Context, mutationrunner.Execution) error {
	p.mu.Lock()
	p.claims++
	p.mu.Unlock()
	return nil
}
func (p *fakePlatform) Permit(ctx context.Context, request mutationrunner.PermitRequest) (mutationrunner.Permit, error) {
	p.mu.Lock()
	p.permits++
	p.mu.Unlock()
	if p.entered != nil {
		close(p.entered)
		select {
		case <-p.release:
		case <-ctx.Done():
			return mutationrunner.Permit{}, ctx.Err()
		}
	}
	p.clock.advance(p.delay)
	return mutationrunner.Permit{PermitRequest: request, PermitID: permitID, BudgetMillis: 3000}, nil
}

type fakeTarget struct {
	mu                                                 sync.Mutex
	table                                              mutationguard.Table
	reads                                              [][]mutationguard.Row
	readIndex, execCalls, commitCalls, committedWrites int
	commitError                                        bool
	receipt                                            *mutationrunner.Receipt
	commitEntered, commitRelease                       chan struct{}
}
type fakeTx struct {
	target  *fakeTarget
	writes  int
	receipt *mutationrunner.Receipt
	done    bool
}

func (t *fakeTarget) Begin(context.Context, mutationrunner.Binding) (mutationrunner.Transaction, error) {
	return &fakeTx{target: t}, nil
}
func (t *fakeTarget) Receipt(context.Context, mutationrunner.Scope, string) (*mutationrunner.Receipt, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.receipt == nil {
		return nil, nil
	}
	copy := *t.receipt
	return &copy, nil
}
func (tx *fakeTx) Describe(context.Context, string) (mutationguard.Table, error) {
	tx.target.mu.Lock()
	defer tx.target.mu.Unlock()
	return tx.target.table, nil
}
func (tx *fakeTx) Rows(context.Context, mutationguard.Statement) ([]mutationguard.Row, error) {
	t := tx.target
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.readIndex >= len(t.reads) {
		return nil, errors.New("unexpected row read")
	}
	rows := t.reads[t.readIndex]
	t.readIndex++
	return rows, nil
}
func (tx *fakeTx) Exec(context.Context, mutationguard.Statement) (mutationrunner.ApplyResult, error) {
	tx.target.mu.Lock()
	tx.target.execCalls++
	tx.target.mu.Unlock()
	tx.writes++
	return mutationrunner.ApplyResult{Affected: 1, LastInsertID: 1}, nil
}
func (tx *fakeTx) PutReceipt(_ context.Context, r mutationrunner.Receipt) error {
	copy := r
	tx.receipt = &copy
	return nil
}
func (tx *fakeTx) Commit() error {
	if tx.done {
		return errors.New("finished")
	}
	tx.done = true
	t := tx.target
	t.mu.Lock()
	defer t.mu.Unlock()
	t.commitCalls++
	t.committedWrites += tx.writes
	t.receipt = tx.receipt
	if t.commitEntered != nil {
		close(t.commitEntered)
		<-t.commitRelease
	}
	if t.commitError {
		return errors.New("lost commit response")
	}
	return nil
}
func (tx *fakeTx) Rollback() error {
	if tx.done {
		return errors.New("finished")
	}
	tx.done = true
	return nil
}

type fixture struct {
	runner   *mutationrunner.Runner
	store    *mutationstore.Store
	target   *fakeTarget
	clock    *fakeClock
	platform *fakePlatform
	config   mutationrunner.Config
}

func newFixture(t *testing.T, reads ...[]mutationguard.Row) *fixture {
	t.Helper()
	clock := &fakeClock{ticks: 1_000_000_000}
	table := mutationguard.Table{Database: "lab", Name: "orders", Engine: "InnoDB", BaseTable: true, Complete: true, SQLMode: "STRICT_TRANS_TABLES", Definition: "CREATE TABLE orders(id BIGINT NOT NULL PRIMARY KEY,tenant VARCHAR(20) NOT NULL,label VARCHAR(64) NOT NULL) ENGINE=InnoDB", Columns: []mutationguard.Column{{Name: "id", Kind: "integer", Bits: 64, PrimaryOrdinal: 1}, {Name: "tenant", Kind: "string", MaxLength: 20}, {Name: "label", Kind: "string", MaxLength: 64}}}
	policy := mutationguard.Policy{Database: "lab", Table: "orders", InsertColumns: []string{"id", "tenant", "label"}, UpdateColumns: []string{"label"}, PreviewColumns: []string{"id", "tenant", "label"}, Delete: true, RowPredicates: []mutationguard.Predicate{{Column: "tenant", Operator: "eq", Value: &mutationguard.Value{Kind: "string", Value: "east"}}}, MaxRows: 20, MaxBytes: 1 << 20, Generation: "policy"}
	config := mutationrunner.Config{Binding: mutationrunner.Binding{Scope: mutationrunner.Scope{OwnerID: owner, WorkspaceID: workspace, SourceID: source, ConnectorID: connector}, APIBoot: strings.Repeat("a", 64), ConnectorBoot: strings.Repeat("b", 64), TargetIdentity: "fixed-target", TargetEpoch: strings.Repeat("c", 64), PolicyGeneration: "policy", InstallationGeneration: "installation"}, Policies: map[string]mutationguard.Policy{"orders": policy}, HMACKey: []byte(strings.Repeat("k", 32)), Coordinator: mutationrunner.NewCoordinator()}
	store, err := mutationstore.Create(filepath.Join(t.TempDir(), "journal.db"), []byte(strings.Repeat("j", 32)), connector, mutationstore.NewMemoryPackageKeys())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	target := &fakeTarget{table: table, reads: reads}
	platform := &fakePlatform{clock: clock}
	runner, err := mutationrunner.New(config, target, store, clock, platform)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(runner.Close)
	return &fixture{runner, store, target, clock, platform, config}
}
func row(label string) mutationguard.Row {
	return mutationguard.Row{"id": {Kind: "integer", Value: "1"}, "tenant": {Kind: "string", Value: "east"}, "label": {Kind: "string", Value: label}}
}
func updatePlan() mutationguard.Plan {
	return mutationguard.Plan{Operation: "update", Table: "orders", Changes: []mutationguard.Assignment{{Column: "label", Value: mutationguard.Value{Kind: "string", Value: "new"}}}, Where: []mutationguard.Predicate{{Column: "id", Operator: "eq", Value: &mutationguard.Value{Kind: "integer", Value: "1"}}}}
}
func previewExecution(t *testing.T, f *fixture, plan mutationguard.Plan) mutationrunner.Execution {
	t.Helper()
	p, err := f.runner.Preview(context.Background(), plan)
	if err != nil {
		t.Fatal(err)
	}
	return mutationrunner.Execution{Binding: p.Binding, ExecutionID: executionID, PreviewID: p.PreviewID, Commitment: p.Commitment, Revision: p.Revision}
}

func TestRunnerAllThreeOperationsAndDurableNoReplay(t *testing.T) {
	for _, operation := range []string{"insert", "update", "delete"} {
		t.Run(operation, func(t *testing.T) {
			var reads [][]mutationguard.Row
			plan := updatePlan()
			switch operation {
			case "insert":
				plan = mutationguard.Plan{Operation: "insert", Table: "orders", Rows: [][]mutationguard.Assignment{{{Column: "id", Value: mutationguard.Value{Kind: "integer", Value: "1"}}, {Column: "tenant", Value: mutationguard.Value{Kind: "string", Value: "east"}}, {Column: "label", Value: mutationguard.Value{Kind: "string", Value: "new"}}}}}
				reads = [][]mutationguard.Row{{row("new")}}
			case "update":
				reads = [][]mutationguard.Row{{row("old")}, {row("old")}, {row("new")}}
			case "delete":
				plan.Operation = "delete"
				plan.Changes = nil
				reads = [][]mutationguard.Row{{row("old")}, {row("old")}, {}}
			}
			f := newFixture(t, reads...)
			e := previewExecution(t, f, plan)
			got, err := f.runner.Execute(context.Background(), e)
			if err != nil || got.State != "committed" || got.RowCount != 1 {
				t.Fatalf("result=%+v err=%v", got, err)
			}
			if again, err := f.runner.Execute(context.Background(), e); err != nil || again.State != "committed" {
				t.Fatalf("retry lost original result: %v %v", again, err)
			}
			if f.target.execCalls != 1 || f.target.commitCalls != 1 || f.target.committedWrites != 1 || f.platform.claims != 1 || f.platform.permits != 1 {
				t.Fatal("same execution was attempted twice")
			}
		})
	}
}
func TestRunnerTargetAndScopeChangesCannotWrite(t *testing.T) {
	for _, fault := range []string{"changed-row", "changed-definition", "expired", "wrong-scope", "wrong-boot"} {
		t.Run(fault, func(t *testing.T) {
			f := newFixture(t, []mutationguard.Row{row("old")}, []mutationguard.Row{row("tampered")})
			e := previewExecution(t, f, updatePlan())
			switch fault {
			case "changed-definition":
				f.target.table.Definition = "new definition"
			case "expired":
				f.clock.advance(121 * 10_000_000)
			case "wrong-scope":
				e.WorkspaceID = owner
			case "wrong-boot":
				e.APIBoot = strings.Repeat("d", 64)
			}
			got, err := f.runner.Execute(context.Background(), e)
			if err == nil || got.State == "committed" || got.ExecutionID != executionID || f.target.execCalls != 0 || f.target.commitCalls != 0 {
				t.Fatalf("fault %s admitted: %+v %v", fault, got, err)
			}
		})
	}
}
func TestRunnerDelayedPermitRollsBackWithoutSecondCommit(t *testing.T) {
	f := newFixture(t, []mutationguard.Row{row("old")}, []mutationguard.Row{row("old")}, []mutationguard.Row{row("new")})
	e := previewExecution(t, f, updatePlan())
	f.platform.delay = 4 * 10_000_000
	got, err := f.runner.Execute(context.Background(), e)
	if err == nil || got.State != "rolled_back" || got.Code != "permit_expired" || f.target.commitCalls != 0 || f.target.committedWrites != 0 {
		t.Fatalf("late permit committed: %+v %v", got, err)
	}
	_, _ = f.runner.Execute(context.Background(), e)
	if f.platform.permits != 1 || f.target.execCalls != 1 {
		t.Fatal("late permit retry repeated an attempt")
	}
}
func TestRunnerLostCommitReplyRecoversOnlyOriginalReceipt(t *testing.T) {
	f := newFixture(t, []mutationguard.Row{row("old")}, []mutationguard.Row{row("old")}, []mutationguard.Row{row("new")})
	e := previewExecution(t, f, updatePlan())
	f.target.commitError = true
	got, err := f.runner.Execute(context.Background(), e)
	if !errors.Is(err, mutationrunner.ErrUnknown) || got.State != "outcome_unknown" || f.target.committedWrites != 1 {
		t.Fatalf("lost reply mislabeled: %v %v", got, err)
	}
	found, err := f.runner.Status(context.Background(), e.Scope, e.ExecutionID)
	if err != nil || found.State != "committed" || f.target.execCalls != 1 {
		t.Fatalf("original receipt not recovered: %v %v", found, err)
	}
	if _, err := f.runner.Preview(context.Background(), updatePlan()); !errors.Is(err, mutationrunner.ErrFrozen) {
		t.Fatal("receipt lookup silently unfroze target")
	}
}
func TestRunnerCancellationBeforeHandoffCannotCommit(t *testing.T) {
	f := newFixture(t, []mutationguard.Row{row("old")}, []mutationguard.Row{row("old")}, []mutationguard.Row{row("new")})
	e := previewExecution(t, f, updatePlan())
	f.platform.entered = make(chan struct{})
	f.platform.release = make(chan struct{})
	done := make(chan mutationrunner.Result, 1)
	go func() { result, _ := f.runner.Execute(context.Background(), e); done <- result }()
	<-f.platform.entered
	if _, err := f.runner.Cancel(context.Background(), e.Scope, e.ExecutionID); err != nil {
		t.Fatal(err)
	}
	close(f.platform.release)
	got := <-done
	if got.State != "rolled_back" || f.target.commitCalls != 0 {
		t.Fatalf("cancelled request committed: %v", got)
	}
}
func TestRunnerIdentityMismatchAndRestartNeverReauthorize(t *testing.T) {
	f := newFixture(t, []mutationguard.Row{row("old")}, []mutationguard.Row{row("old")}, []mutationguard.Row{row("new")})
	e := previewExecution(t, f, updatePlan())
	if _, err := f.runner.Execute(context.Background(), e); err != nil {
		t.Fatal(err)
	}
	changed := e
	changed.Commitment = strings.Repeat("A", 43)
	if _, err := f.runner.Execute(context.Background(), changed); err == nil {
		t.Fatal("same execution accepted a different commitment")
	}
	configuration := f.config
	configuration.Binding.APIBoot = strings.Repeat("d", 64)
	fresh, err := mutationrunner.New(configuration, f.target, f.store, f.clock, f.platform)
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close()
	if _, err := fresh.Execute(context.Background(), e); err == nil {
		t.Fatal("new process recovered old execution eligibility")
	}
	if f.target.execCalls != 1 {
		t.Fatal("new boot re-executed old grant")
	}
}

func TestRunnerAliasesShareExecutionAndUnknownFreeze(t *testing.T) {
	f := newFixture(t, []mutationguard.Row{row("old")}, []mutationguard.Row{row("old")}, []mutationguard.Row{row("old")}, []mutationguard.Row{row("new")})
	first := previewExecution(t, f, updatePlan())
	configuration := f.config
	configuration.Binding.SourceID = "77777777-7777-4777-8777-777777777777"
	alias, err := mutationrunner.New(configuration, f.target, f.store, f.clock, f.platform)
	if err != nil {
		t.Fatal(err)
	}
	defer alias.Close()
	p, err := alias.Preview(context.Background(), updatePlan())
	if err != nil {
		t.Fatal(err)
	}
	second := mutationrunner.Execution{Binding: p.Binding, ExecutionID: "88888888-8888-4888-8888-888888888888", PreviewID: p.PreviewID, Commitment: p.Commitment, Revision: 1}
	f.platform.entered = make(chan struct{})
	f.platform.release = make(chan struct{})
	f.target.commitError = true
	firstDone, secondDone := make(chan mutationrunner.Result, 1), make(chan mutationrunner.Result, 1)
	go func() { got, _ := f.runner.Execute(context.Background(), first); firstDone <- got }()
	<-f.platform.entered
	go func() { got, _ := alias.Execute(context.Background(), second); secondDone <- got }()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := f.store.Get(context.Background(), second.ExecutionID, second.Scope); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("second alias was not registered")
		}
		time.Sleep(time.Millisecond)
	}
	f.platform.mu.Lock()
	claims := f.platform.claims
	f.platform.mu.Unlock()
	if claims != 1 {
		t.Fatal("an alias bypassed the occupied execution slot")
	}
	close(f.platform.release)
	if got := <-firstDone; got.State != "outcome_unknown" {
		t.Fatalf("unexpected first result: %+v", got)
	}
	if got := <-secondDone; got.State != "rejected" || got.Code != "frozen" {
		t.Fatalf("waiting alias ignored shared unknown freeze: %+v", got)
	}
	if f.target.execCalls != 1 || f.target.commitCalls != 1 {
		t.Fatal("waiting alias executed after another alias became unknown")
	}
}

func TestRunnerCloseDrainsHandoffBeforeResourcesMayClose(t *testing.T) {
	f := newFixture(t, []mutationguard.Row{row("old")}, []mutationguard.Row{row("old")}, []mutationguard.Row{row("new")})
	e := previewExecution(t, f, updatePlan())
	f.target.commitEntered = make(chan struct{})
	f.target.commitRelease = make(chan struct{})
	resultDone := make(chan mutationrunner.Result, 1)
	go func() { got, _ := f.runner.Execute(context.Background(), e); resultDone <- got }()
	<-f.target.commitEntered
	closed := make(chan struct{})
	go func() { f.runner.Close(); close(closed) }()
	select {
	case <-closed:
		t.Fatal("Close returned with a Commit callback still running")
	case <-time.After(30 * time.Millisecond):
	}
	close(f.target.commitRelease)
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("Close did not drain the completed handoff")
	}
	if got := <-resultDone; got.State != "committed" {
		t.Fatalf("shutdown discarded a known commit: %+v", got)
	}
	stored, err := f.store.Get(context.Background(), e.ExecutionID, e.Scope)
	if err != nil || stored.State != "committed" {
		t.Fatal("resources became closeable before terminal result was durable")
	}
	if _, err := f.runner.Preview(context.Background(), updatePlan()); err == nil {
		t.Fatal("closed runner accepted new work")
	}
}

func TestRunnerRecoveredAcceptedRecordIsUnknownAndRetentionNeverRenews(t *testing.T) {
	f := newFixture(t, []mutationguard.Row{row("old")})
	e := previewExecution(t, f, updatePlan())
	if err := f.store.Accept(context.Background(), mutationrunner.Record{Execution: e, State: "accepted"}); err != nil {
		t.Fatal(err)
	}
	first, err := f.runner.Status(context.Background(), e.Scope, e.ExecutionID)
	if err != nil || first.State != "outcome_unknown" || first.ReconciliationExpiresAt == "" {
		t.Fatalf("restored accepted record regained eligibility: %+v %v", first, err)
	}
	second, err := f.runner.Status(context.Background(), e.Scope, e.ExecutionID)
	if err != nil || second.ReconciliationExpiresAt != first.ReconciliationExpiresAt {
		t.Fatal("recovery renewed the reconciliation deadline")
	}
	persisted, err := f.store.Get(context.Background(), e.ExecutionID, e.Scope)
	if err != nil || persisted.State != "outcome_unknown" || persisted.ReconciliationExpiresAt == 0 {
		t.Fatal("recovered accepted state was not durably frozen")
	}
	if _, err := f.runner.Preview(context.Background(), updatePlan()); !errors.Is(err, mutationrunner.ErrFrozen) {
		t.Fatal("restored accepted record did not freeze new writes")
	}
	if f.target.execCalls != 0 || f.platform.claims != 0 {
		t.Fatal("status recovery dispatched an old task")
	}
}
