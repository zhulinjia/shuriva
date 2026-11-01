package mutationmysql

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/mutationguard"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
)

func TestG4MySQLLockTimeoutRollsBackWithoutReceipt(t *testing.T) {
	l := newLab(t)
	r := newCoreRunner(t, l, l.controller)
	e := corePreviewExecution(t, r, mutationguard.Plan{Operation: "update", Table: "orders", Changes: []mutationguard.Assignment{{Column: "label", Value: mutationguard.Value{Kind: "string", Value: "must-not-commit"}}}, Where: integerWhere("1")})
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	block, err := l.fixture.Admin.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer block.Rollback()
	var id int
	if err := block.QueryRowContext(ctx, "SELECT id FROM "+qualified(l.manifest.Spec.Catalog, "orders")+" WHERE id=1 FOR UPDATE").Scan(&id); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	result, err := r.Execute(ctx, e)
	if err == nil || result.State != "rolled_back" || time.Since(start) < 2*time.Second {
		t.Fatal("real lock timeout did not produce a proven rollback")
	}
	if err := block.Rollback(); err != nil {
		t.Fatal(err)
	}
	receipt, err := l.controller.Receipt(ctx, e.Scope, e.ExecutionID)
	if err != nil || receipt != nil {
		t.Fatal("timed out transaction left a receipt")
	}
	var label string
	if err := l.fixture.Admin.QueryRowContext(ctx, "SELECT label FROM "+qualified(l.manifest.Spec.Catalog, "orders")+" WHERE id=1").Scan(&label); err != nil || label != "first" {
		t.Fatal("timed out transaction changed business row")
	}
}

func deadlocks(t *testing.T, db *sql.DB) int {
	t.Helper()
	var count int
	if err := db.QueryRow("SELECT `COUNT` FROM information_schema.INNODB_METRICS WHERE NAME='lock_deadlocks'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}
func TestG4MySQLDeadlockIsAtomicAndNeverReplayed(t *testing.T) {
	l := newLab(t)
	r := newCoreRunner(t, l, l.controller)
	l.fixture.Exec(t, "INSERT INTO "+qualified(l.manifest.Spec.Catalog, "orders")+"(label,amount) VALUES ('second',12.30)")
	e := corePreviewExecution(t, r, mutationguard.Plan{Operation: "update", Table: "orders", Changes: []mutationguard.Assignment{{Column: "label", Value: mutationguard.Value{Kind: "string", Value: "G4-deadlock"}}}, Where: []mutationguard.Predicate{{Column: "tenant", Operator: "eq", Value: &mutationguard.Value{Kind: "string", Value: "east"}}}})
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	before := deadlocks(t, l.fixture.Admin)
	block, err := l.fixture.Admin.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer block.Rollback()
	var id int
	if err := block.QueryRowContext(ctx, "SELECT id FROM "+qualified(l.manifest.Spec.Catalog, "orders")+" WHERE id=2 FOR UPDATE").Scan(&id); err != nil {
		t.Fatal(err)
	}
	done := make(chan mutationrunner.Result, 1)
	go func() { result, _ := r.Execute(ctx, e); done <- result }()
	until := time.Now().Add(2 * time.Second)
	for {
		var waiting int
		if err := l.fixture.Admin.QueryRowContext(ctx, "SELECT COUNT(*) FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks k ON k.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE k.OBJECT_SCHEMA=?", l.manifest.Spec.Catalog).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(until) {
			t.Fatal("runner did not reach row lock barrier")
		}
		time.Sleep(5 * time.Millisecond)
	}
	_, _ = block.ExecContext(ctx, "UPDATE "+qualified(l.manifest.Spec.Catalog, "orders")+" SET label=label WHERE id=1")
	_ = block.Rollback()
	var result mutationrunner.Result
	select {
	case result = <-done:
	case <-ctx.Done():
		t.Fatal("deadlock did not resolve")
	}
	if deadlocks(t, l.fixture.Admin) <= before {
		t.Fatal("no real InnoDB deadlock occurred")
	}
	if result.State != "committed" && result.State != "rolled_back" {
		t.Fatalf("deadlock outcome not proven: %s", result.State)
	}
	var changed int
	if err := l.fixture.Admin.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+qualified(l.manifest.Spec.Catalog, "orders")+" WHERE label='G4-deadlock'").Scan(&changed); err != nil {
		t.Fatal(err)
	}
	want := 0
	if result.State == "committed" {
		want = 2
	}
	if changed != want {
		t.Fatal("deadlock left a partial batch")
	}
	receipt, err := l.controller.Receipt(ctx, e.Scope, e.ExecutionID)
	if err != nil || (receipt != nil) != (result.State == "committed") {
		t.Fatal("deadlock receipt disagrees with business outcome")
	}
	again, _ := r.Execute(ctx, e)
	if again.State != result.State || again.ExecutionID != e.ExecutionID {
		t.Fatal("deadlock retry lost original execution")
	}
}

func TestG4CurrentValueFingerprintDoesNotClaimHistoryDetection(t *testing.T) {
	for _, scenario := range []string{"A-B-A", "same-key-same-values-recreated"} {
		t.Run(scenario, func(t *testing.T) {
			l := newLab(t)
			r := newCoreRunner(t, l, l.controller)
			e := corePreviewExecution(t, r, mutationguard.Plan{Operation: "update", Table: "orders", Changes: []mutationguard.Assignment{{Column: "label", Value: mutationguard.Value{Kind: "string", Value: "G4-final"}}}, Where: integerWhere("1")})
			if scenario == "A-B-A" {
				l.fixture.Exec(t, "UPDATE "+qualified(l.manifest.Spec.Catalog, "orders")+" SET label='temporary' WHERE id=1")
				l.fixture.Exec(t, "UPDATE "+qualified(l.manifest.Spec.Catalog, "orders")+" SET label='first' WHERE id=1")
			} else {
				l.fixture.Exec(t, "DELETE FROM "+qualified(l.manifest.Spec.Catalog, "orders")+" WHERE id=1")
				l.fixture.Exec(t, "INSERT INTO "+qualified(l.manifest.Spec.Catalog, "orders")+"(id,label,amount,tenant) VALUES (1,'first',12.30,'east')")
			}
			result, err := r.Execute(context.Background(), e)
			if err != nil || result.State != "committed" {
				t.Fatal("current-value contract unexpectedly claimed historical identity")
			}
		})
	}
}
