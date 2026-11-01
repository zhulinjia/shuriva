package mutationmysql

import (
	"context"
	"crypto/rand"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/mutationguard"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	"example.com/ai-database-workspace/connector/internal/mutationstore"
)

// This port stands in for the separately tested authenticated API. These tests
// prove the real core->SQL->journal chain, not HTTP/session/signature delivery.
type isolatedPermitPort struct {
	mu     sync.Mutex
	claims map[string]mutationrunner.Execution
}

func (p *isolatedPermitPort) Claim(ctx context.Context, e mutationrunner.Execution) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, exists := p.claims[e.ExecutionID]; exists {
		return mutationrunner.ErrConsumed
	}
	p.claims[e.ExecutionID] = e
	return nil
}
func (p *isolatedPermitPort) Permit(ctx context.Context, request mutationrunner.PermitRequest) (mutationrunner.Permit, error) {
	if ctx.Err() != nil {
		return mutationrunner.Permit{}, ctx.Err()
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.claims[request.ExecutionID] != request.Execution {
		return mutationrunner.Permit{}, mutationrunner.ErrDenied
	}
	return mutationrunner.Permit{PermitRequest: request, PermitID: testUUID(), BudgetMillis: 3000}, nil
}
func newCoreRunner(t *testing.T, l *mysqlLab, target mutationrunner.Target) *mutationrunner.Runner {
	t.Helper()
	var key [32]byte
	if _, err := rand.Read(key[:]); err != nil {
		t.Fatal(err)
	}
	journal, err := mutationstore.Create(filepath.Join(t.TempDir(), "execution.db"), key[:], l.binding.ConnectorID, mutationstore.NewMemoryPackageKeys())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = journal.Close() })
	clock, err := mutationstore.NewClock()
	if err != nil {
		t.Fatal(err)
	}
	policy := mutationguard.Policy{Database: l.manifest.Spec.Catalog, Table: "orders", InsertColumns: []string{"id", "label", "amount", "tenant"}, UpdateColumns: []string{"label", "amount"}, PreviewColumns: []string{"id", "label", "amount", "tenant"}, Delete: true, RowPredicates: []mutationguard.Predicate{{Column: "tenant", Operator: "eq", Value: &mutationguard.Value{Kind: "string", Value: "east"}}}, MaxRows: 20, MaxBytes: 1 << 20, Generation: l.binding.PolicyGeneration}
	runner, err := mutationrunner.New(mutationrunner.Config{Binding: l.binding, Policies: map[string]mutationguard.Policy{"orders": policy}, HMACKey: key[:]}, target, journal, clock, &isolatedPermitPort{claims: map[string]mutationrunner.Execution{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(runner.Close)
	return runner
}
func integerWhere(value string) []mutationguard.Predicate {
	return []mutationguard.Predicate{{Column: "id", Operator: "eq", Value: &mutationguard.Value{Kind: "integer", Value: value}}}
}
func corePreviewExecution(t *testing.T, r *mutationrunner.Runner, p mutationguard.Plan) mutationrunner.Execution {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	preview, err := r.Preview(ctx, p)
	if err != nil {
		t.Fatal("core preview:", err)
	}
	if preview.RowCount < 1 || len(preview.Rows) != preview.RowCount {
		t.Fatal("preview omitted complete targets")
	}
	if p.Operation == "insert" {
		for i, input := range p.Rows {
			provided := map[string]bool{}
			for _, value := range input {
				provided[value.Column] = true
			}
			contains := func(names []string, want string) bool {
				for _, name := range names {
					if name == want {
						return true
					}
				}
				return false
			}
			if !provided["id"] && (!contains(preview.Rows[i].GeneratedColumns, "id") || preview.Rows[i].After["id"].Kind != "") {
				t.Fatal("auto-generated primary key was presented as a known final value")
			}
			for _, name := range []string{"amount", "tenant"} {
				if !provided[name] && !contains(preview.Rows[i].DefaultColumns, name) {
					t.Fatal("literal database default was not labeled")
				}
			}
		}
	}
	return mutationrunner.Execution{Binding: preview.Binding, ExecutionID: testUUID(), PreviewID: preview.PreviewID, Commitment: preview.Commitment, Revision: preview.Revision}
}
func applyCore(t *testing.T, r *mutationrunner.Runner, p mutationguard.Plan) mutationrunner.Execution {
	t.Helper()
	e := corePreviewExecution(t, r, p)
	result, err := r.Execute(context.Background(), e)
	if err != nil || result.State != "committed" || result.RowCount < 1 {
		t.Fatalf("core execute: %+v %v", result, err)
	}
	again, err := r.Execute(context.Background(), e)
	if err != nil || again.State != "committed" {
		t.Fatal("duplicate request lost original committed identity")
	}
	return e
}

func TestMySQLCoreRunnerThreeOperationsExactValuesAndReceipt(t *testing.T) {
	l := newLab(t)
	r := newCoreRunner(t, l, l.controller)
	update := mutationguard.Plan{Operation: "update", Table: "orders", Changes: []mutationguard.Assignment{{Column: "amount", Value: mutationguard.Value{Kind: "decimal", Value: "9999999999.99"}}, {Column: "label", Value: mutationguard.Value{Kind: "string", Value: "updated"}}}, Where: integerWhere("1")}
	updated := applyCore(t, r, update)
	var amount, label string
	if err := l.fixture.Admin.QueryRow("SELECT amount,label FROM "+qualified(l.manifest.Spec.Catalog, "orders")+" WHERE id=1").Scan(&amount, &label); err != nil || amount != "9999999999.99" || label != "updated" {
		t.Fatal("decimal precision or update behavior changed", err)
	}
	insert := mutationguard.Plan{Operation: "insert", Table: "orders", Rows: [][]mutationguard.Assignment{{{Column: "label", Value: mutationguard.Value{Kind: "string", Value: "auto"}}, {Column: "amount", Value: mutationguard.Value{Kind: "decimal", Value: "12.3"}}}}}
	applyCore(t, r, insert)
	applyCore(t, r, mutationguard.Plan{Operation: "delete", Table: "orders", Where: integerWhere("1")})
	insert.Rows[0] = append(insert.Rows[0], mutationguard.Assignment{Column: "id", Value: mutationguard.Value{Kind: "integer", Value: "18446744073709551615"}})
	insert.Rows[0][0].Value.Value = "uint64-max"
	applyCore(t, r, insert)
	var id, exact string
	if err := l.fixture.Admin.QueryRow("SELECT CAST(id AS CHAR),amount FROM "+qualified(l.manifest.Spec.Catalog, "orders")+" WHERE id=?", "18446744073709551615").Scan(&id, &exact); err != nil || id != "18446744073709551615" || exact != "12.30" {
		t.Fatal("unsigned primary key or decimal was rounded", err)
	}
	receipt, err := l.controller.Receipt(context.Background(), updated.Scope, updated.ExecutionID)
	if err != nil || receipt == nil || receipt.Commitment != updated.Commitment || receipt.RowCount != 1 {
		t.Fatal("real atomic target receipt missing or mismatched", err)
	}
	var count int
	if err := l.fixture.Admin.QueryRow("SELECT COUNT(*) FROM " + qualified(l.manifest.Spec.Catalog, "orders")).Scan(&count); err != nil || count != 2 {
		t.Fatal("retries duplicated a real business operation", err)
	}
}

func TestMySQLCoreRunnerPolicyDefaultsAndHiddenBehavior(t *testing.T) {
	for _, scenario := range []string{"explicit-outside-scope", "default-outside-scope", "protected-field", "hidden-trigger"} {
		t.Run(scenario, func(t *testing.T) {
			l := newLab(t)
			r := newCoreRunner(t, l, l.controller)
			plan := mutationguard.Plan{Operation: "insert", Table: "orders", Rows: [][]mutationguard.Assignment{{{Column: "label", Value: mutationguard.Value{Kind: "string", Value: "new"}}}}}
			switch scenario {
			case "explicit-outside-scope":
				plan.Rows[0] = append(plan.Rows[0], mutationguard.Assignment{Column: "tenant", Value: mutationguard.Value{Kind: "string", Value: "west"}})
			case "default-outside-scope":
				l.fixture.Exec(t, "ALTER TABLE "+qualified(l.manifest.Spec.Catalog, "orders")+" ALTER COLUMN tenant SET DEFAULT 'west'")
			case "protected-field":
				plan = mutationguard.Plan{Operation: "update", Table: "orders", Changes: []mutationguard.Assignment{{Column: "tenant", Value: mutationguard.Value{Kind: "string", Value: "west"}}}, Where: integerWhere("1")}
			case "hidden-trigger":
				l.fixture.Exec(t, "CREATE TRIGGER "+qualified(l.manifest.Spec.Catalog, "hidden_trigger")+" BEFORE INSERT ON "+qualified(l.manifest.Spec.Catalog, "orders")+" FOR EACH ROW SET NEW.label='side-effect'")
			}
			if _, err := r.Preview(context.Background(), plan); err == nil {
				t.Fatal("unsafe row/table acquired an executable preview")
			}
			var count int
			if err := l.fixture.Admin.QueryRow("SELECT COUNT(*) FROM " + qualified(l.manifest.Spec.Catalog, "orders")).Scan(&count); err != nil || count != 1 {
				t.Fatal("rejected preview changed a real business table", err)
			}
		})
	}
}

func TestMySQLCoreRunnerFrozenRowsAndBatchFailureRollBack(t *testing.T) {
	for _, scenario := range []string{"changed-row", "batch-unique"} {
		t.Run(scenario, func(t *testing.T) {
			l := newLab(t)
			r := newCoreRunner(t, l, l.controller)
			plan := mutationguard.Plan{Operation: "update", Table: "orders", Changes: []mutationguard.Assignment{{Column: "label", Value: mutationguard.Value{Kind: "string", Value: "planned"}}}, Where: integerWhere("1")}
			if scenario == "batch-unique" {
				l.fixture.Exec(t, "ALTER TABLE "+qualified(l.manifest.Spec.Catalog, "orders")+" ADD UNIQUE KEY unique_label(label)")
				plan = mutationguard.Plan{Operation: "insert", Table: "orders", Rows: [][]mutationguard.Assignment{{{Column: "id", Value: mutationguard.Value{Kind: "integer", Value: "10"}}, {Column: "label", Value: mutationguard.Value{Kind: "string", Value: "dupe"}}}, {{Column: "id", Value: mutationguard.Value{Kind: "integer", Value: "11"}}, {Column: "label", Value: mutationguard.Value{Kind: "string", Value: "dupe"}}}}}
			}
			e := corePreviewExecution(t, r, plan)
			if scenario == "changed-row" {
				l.fixture.Exec(t, "UPDATE "+qualified(l.manifest.Spec.Catalog, "orders")+" SET label='external' WHERE id=1")
			}
			result, err := r.Execute(context.Background(), e)
			if err == nil || result.State != "rolled_back" || result.ExecutionID != e.ExecutionID {
				t.Fatalf("unsafe execution not rolled back with identity: %+v %v", result, err)
			}
			var count int
			if err := l.fixture.Admin.QueryRow("SELECT COUNT(*) FROM " + qualified(l.manifest.Spec.Catalog, "orders")).Scan(&count); err != nil || count != 1 {
				t.Fatal("partial batch survived rollback", err)
			}
			receipt, err := l.controller.Receipt(context.Background(), e.Scope, e.ExecutionID)
			if err != nil || receipt != nil {
				t.Fatal("rejected transaction left a committed receipt", err)
			}
		})
	}
}

type loseCommitTarget struct{ mutationrunner.Target }
type loseCommitTransaction struct{ mutationrunner.Transaction }

func (t loseCommitTarget) Begin(ctx context.Context, b mutationrunner.Binding) (mutationrunner.Transaction, error) {
	tx, err := t.Target.Begin(ctx, b)
	if err != nil {
		return nil, err
	}
	return loseCommitTransaction{tx}, nil
}
func (t loseCommitTransaction) Commit() error {
	if err := t.Transaction.Commit(); err != nil {
		return err
	}
	return errors.New("injected loss after real target commit")
}

func TestMySQLCoreRunnerLostCommitResponseUsesRealReceipt(t *testing.T) {
	l := newLab(t)
	r := newCoreRunner(t, l, loseCommitTarget{l.controller})
	e := corePreviewExecution(t, r, mutationguard.Plan{Operation: "update", Table: "orders", Changes: []mutationguard.Assignment{{Column: "label", Value: mutationguard.Value{Kind: "string", Value: "committed-once"}}}, Where: integerWhere("1")})
	result, err := r.Execute(context.Background(), e)
	if !errors.Is(err, mutationrunner.ErrUnknown) || result.State != "outcome_unknown" || result.ReconciliationExpiresAt == "" {
		t.Fatalf("real commit response loss mislabeled: %+v %v", result, err)
	}
	confirmed, err := r.Status(context.Background(), e.Scope, e.ExecutionID)
	if err != nil || confirmed.State != "committed" || confirmed.RowCount != 1 {
		t.Fatalf("real receipt could not prove original transaction: %+v %v", confirmed, err)
	}
	if _, err := r.Preview(context.Background(), mutationguard.Plan{Operation: "delete", Table: "orders", Where: integerWhere("1")}); !errors.Is(err, mutationrunner.ErrFrozen) {
		t.Fatal("receipt lookup silently reopened an unknown-frozen target")
	}
	var label string
	if err := l.fixture.Admin.QueryRow("SELECT label FROM " + qualified(l.manifest.Spec.Catalog, "orders") + " WHERE id=1").Scan(&label); err != nil || label != "committed-once" {
		t.Fatal("recovery changed the original business result", err)
	}
}

func TestMySQLCoreRunnerNewMatchingRowsDoNotChangeFrozenTargets(t *testing.T) {
	l := newLab(t)
	r := newCoreRunner(t, l, l.controller)
	plan := mutationguard.Plan{Operation: "update", Table: "orders", Changes: []mutationguard.Assignment{{Column: "label", Value: mutationguard.Value{Kind: "string", Value: "only-original"}}}, Where: []mutationguard.Predicate{{Column: "tenant", Operator: "eq", Value: &mutationguard.Value{Kind: "string", Value: "east"}}}}
	e := corePreviewExecution(t, r, plan)
	// This also advances SHOW CREATE TABLE's live AUTO_INCREMENT counter. It
	// is data, not a schema change, and must not invalidate the original set.
	l.fixture.Exec(t, "INSERT INTO "+qualified(l.manifest.Spec.Catalog, "orders")+"(label,tenant) VALUES ('new-matching','east')")
	result, err := r.Execute(context.Background(), e)
	if err != nil || result.State != "committed" || result.RowCount != 1 {
		t.Fatalf("later matching insert invalidated or enlarged frozen targets: %+v %v", result, err)
	}
	var first, second string
	if err := l.fixture.Admin.QueryRow("SELECT label FROM " + qualified(l.manifest.Spec.Catalog, "orders") + " WHERE id=1").Scan(&first); err != nil {
		t.Fatal(err)
	}
	if err := l.fixture.Admin.QueryRow("SELECT label FROM " + qualified(l.manifest.Spec.Catalog, "orders") + " WHERE id=2").Scan(&second); err != nil {
		t.Fatal(err)
	}
	if first != "only-original" || second != "new-matching" {
		t.Fatal("later row was modified or original frozen row omitted")
	}
}
