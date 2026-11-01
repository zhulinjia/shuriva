package mutationmysql

import (
	"context"
	"example.com/ai-database-workspace/connector/internal/mutationguard"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	"testing"
)

type afterimageFaultTarget struct {
	mutationrunner.Target
	armed   bool
	mode    string
	mutated int64
	faults  int
}
type afterimageFaultTx struct {
	mutationrunner.Transaction
	target  *afterimageFaultTarget
	applied bool
}

func (t *afterimageFaultTarget) Begin(ctx context.Context, b mutationrunner.Binding) (mutationrunner.Transaction, error) {
	tx, err := t.Target.Begin(ctx, b)
	if err != nil {
		return nil, err
	}
	return &afterimageFaultTx{Transaction: tx, target: t}, nil
}
func (t *afterimageFaultTx) Exec(ctx context.Context, s mutationguard.Statement) (mutationrunner.ApplyResult, error) {
	result, err := t.Transaction.Exec(ctx, s)
	if err == nil {
		t.applied = true
		t.target.mutated += result.Affected
	}
	return result, err
}
func (t *afterimageFaultTx) Rows(ctx context.Context, s mutationguard.Statement) ([]mutationguard.Row, error) {
	rows, err := t.Transaction.Rows(ctx, s)
	if err == nil && t.applied && t.target.armed {
		t.target.faults++
		if t.target.mode == "read-error" {
			return nil, ErrTarget
		}
		return nil, nil
	}
	return rows, err
}
func TestG4IncompleteAfterimageRollsBackRealDMLAndReceipt(t *testing.T) {
	for _, mode := range []string{"read-error", "missing-row"} {
		t.Run(mode, func(t *testing.T) {
			l := newLab(t)
			target := &afterimageFaultTarget{Target: l.controller, mode: mode}
			r := newCoreRunner(t, l, target)
			e := corePreviewExecution(t, r, mutationguard.Plan{Operation: "update", Table: "orders", Changes: []mutationguard.Assignment{{Column: "label", Value: mutationguard.Value{Kind: "string", Value: "must-rollback-afterimage"}}}, Where: integerWhere("1")})
			target.armed = true
			result, err := r.Execute(context.Background(), e)
			if target.mutated != 1 || target.faults != 1 {
				t.Fatal("test did not reach exactly one real row mutation and its injected afterimage fault")
			}
			if err == nil || result.State != "rolled_back" {
				t.Fatal("missing afterimage was treated as a verified commit")
			}
			var label string
			if err := l.fixture.Admin.QueryRow("SELECT label FROM " + qualified(l.manifest.Spec.Catalog, "orders") + " WHERE id=1").Scan(&label); err != nil || label != "first" {
				t.Fatal("afterimage failure left partial real DML")
			}
			receipt, err := l.controller.Receipt(context.Background(), e.Scope, e.ExecutionID)
			if err != nil || receipt != nil {
				t.Fatal("afterimage failure left a receipt")
			}
		})
	}
}
