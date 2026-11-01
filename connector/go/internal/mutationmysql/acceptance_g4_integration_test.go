package mutationmysql

import (
	"context"
	"database/sql"
	"testing"

	"example.com/ai-database-workspace/connector/internal/mutationguard"
)

func TestG4DeletedTargetCannotBeResurrectedFromPreview(t *testing.T) {
	l := newLab(t)
	r := newCoreRunner(t, l, l.controller)
	e := corePreviewExecution(t, r, mutationguard.Plan{Operation: "update", Table: "orders", Changes: []mutationguard.Assignment{{Column: "label", Value: mutationguard.Value{Kind: "string", Value: "must-not-resurrect"}}}, Where: integerWhere("1")})
	l.fixture.Exec(t, "DELETE FROM "+qualified(l.manifest.Spec.Catalog, "orders")+" WHERE id=1")
	result, err := r.Execute(context.Background(), e)
	if err == nil || result.State != "rolled_back" {
		t.Fatal("deleted target accepted a stale preview")
	}
	receipt, err := l.controller.Receipt(context.Background(), e.Scope, e.ExecutionID)
	if err != nil || receipt != nil {
		t.Fatal("deleted-target failure left a receipt")
	}
	var count int
	if err := l.fixture.Admin.QueryRow("SELECT COUNT(*) FROM " + qualified(l.manifest.Spec.Catalog, "orders")).Scan(&count); err != nil || count != 0 {
		t.Fatal("execution recreated a deleted row")
	}
}

func TestG4CredentialAndPermissionChangesInvalidatePendingPreview(t *testing.T) {
	for _, fault := range []string{"writer-password", "writer-update", "inspector-global-visibility"} {
		t.Run(fault, func(t *testing.T) {
			l := newLab(t)
			r := newCoreRunner(t, l, l.controller)
			e := corePreviewExecution(t, r, mutationguard.Plan{Operation: "update", Table: "orders", Changes: []mutationguard.Assignment{{Column: "label", Value: mutationguard.Value{Kind: "string", Value: "must-not-commit"}}}, Where: integerWhere("1")})
			switch fault {
			case "writer-password":
				replacement, _ := NewEpoch()
				l.fixture.Exec(t, "ALTER USER "+account(l.manifest.Spec.Writer)+" IDENTIFIED BY '"+replacement+"'")
				// Drop only idle connections of this owned test account, so new authentication is required.
				l.controller.writer.SetMaxIdleConns(0)
			case "writer-update":
				l.fixture.Exec(t, "REVOKE UPDATE ON "+qualified(l.manifest.Spec.Catalog, "orders")+" FROM "+account(l.manifest.Spec.Writer))
			case "inspector-global-visibility":
				l.fixture.Exec(t, "REVOKE REFERENCES ON *.* FROM "+account(l.plan.Definer))
			}
			result, err := r.Execute(context.Background(), e)
			if err == nil || result.State == "committed" {
				t.Fatal("changed local credential/permission retained execution authority")
			}
			var label string
			if err := l.fixture.Admin.QueryRow("SELECT label FROM " + qualified(l.manifest.Spec.Catalog, "orders") + " WHERE id=1").Scan(&label); err != nil || label != "first" {
				t.Fatal("permission failure changed business row")
			}
			var receipts int
			if err := l.fixture.Admin.QueryRow("SELECT COUNT(*) FROM " + qualified(l.plan.ControlCatalog, "receipts")).Scan(&receipts); err != nil || receipts != 0 {
				t.Fatal("permission failure left a commit receipt")
			}
		})
	}
}

func TestG4InstallationPreflightDetectsRecoveryPrivilegeLoss(t *testing.T) {
	l := newLab(t)
	if err := l.controller.Verify(context.Background()); err != nil {
		t.Fatal("valid initial installation was rejected")
	}
	l.fixture.Exec(t, "REVOKE EXECUTE ON PROCEDURE "+qualified(l.plan.ControlCatalog, "read_gate")+" FROM "+account(l.manifest.Spec.Recovery))
	if err := l.controller.Verify(context.Background()); err == nil {
		t.Fatal("changed recovery permissions passed installation preflight")
	}
}

func TestG4NullableDecimalAndCanonicalDatetimeUseRealMySQL(t *testing.T) {
	l := newLab(t)
	table := qualified(l.manifest.Spec.Catalog, "orders")
	l.fixture.Exec(t, "ALTER TABLE "+table+" MODIFY amount DECIMAL(12,2) NULL DEFAULT NULL")
	r := newCoreRunner(t, l, l.controller)
	applyCore(t, r, mutationguard.Plan{Operation: "update", Table: "orders", Changes: []mutationguard.Assignment{{Column: "amount", Value: mutationguard.Value{Kind: "null"}}}, Where: integerWhere("1")})
	var amount sql.NullString
	if err := l.fixture.Admin.QueryRow("SELECT amount FROM " + table + " WHERE id=1").Scan(&amount); err != nil || amount.Valid {
		t.Fatal("SQL NULL became an empty string or zero")
	}
	applyCore(t, r, mutationguard.Plan{Operation: "update", Table: "orders", Changes: []mutationguard.Assignment{{Column: "amount", Value: mutationguard.Value{Kind: "decimal", Value: "0.01"}}}, Where: integerWhere("1")})
	l.fixture.Exec(t, "UPDATE "+table+" SET label='2026-10-31 23:59:59.123'")
	l.fixture.Exec(t, "ALTER TABLE "+table+" MODIFY label DATETIME(3) NULL")
	tx, err := l.controller.Begin(context.Background(), l.binding)
	if err != nil {
		t.Fatal(err)
	}
	var zone string
	if err := tx.(*transaction).tx.QueryRow("SELECT @@session.time_zone").Scan(&zone); err != nil || zone != "+00:00" {
		t.Fatal("write session is not pinned to UTC")
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	applyCore(t, r, mutationguard.Plan{Operation: "update", Table: "orders", Changes: []mutationguard.Assignment{{Column: "label", Value: mutationguard.Value{Kind: "datetime", Value: "2026-11-01 00:00:00.456"}}}, Where: integerWhere("1")})
	var timestamp string
	if err := l.fixture.Admin.QueryRow("SELECT CAST(label AS CHAR) FROM " + table + " WHERE id=1").Scan(&timestamp); err != nil || timestamp != "2026-11-01 00:00:00.456" {
		t.Fatal("datetime precision or civil time changed")
	}
}
