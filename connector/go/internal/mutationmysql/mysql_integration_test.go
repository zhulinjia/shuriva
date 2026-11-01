package mutationmysql

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/mutationguard"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	"example.com/ai-database-workspace/connector/internal/mutationstore"
	"example.com/ai-database-workspace/connector/internal/testmysql"
	mysql "github.com/go-sql-driver/mysql"
)

func testUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}

type mysqlLab struct {
	fixture    *testmysql.Fixture
	plan       InstallPlan
	manifest   Manifest
	controller *Controller
	profile    mutationstore.Profile
	binding    mutationrunner.Binding
}

func newLab(t *testing.T) *mysqlLab {
	t.Helper()
	f := testmysql.New(t)
	catalog := "stage8_g2_" + f.Suffix
	writer := Account{"s8g2_" + f.Suffix + "_writer", "127.0.0.1"}
	recovery := Account{"s8g2_" + f.Suffix + "_recover", "127.0.0.1"}
	incarnation, _ := NewEpoch()
	generation, _ := NewEpoch()
	plan, err := BuildInstallation(InstallSpec{catalog, []string{"orders"}, writer, recovery, incarnation, generation})
	if err != nil {
		t.Fatal(err)
	}
	secret, _ := NewEpoch()
	f.Exec(t, "CREATE DATABASE "+ident(catalog)+" CHARACTER SET utf8mb4 COLLATE utf8mb4_bin")
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		for _, schema := range []string{catalog, plan.ControlCatalog} {
			if _, err := f.Admin.ExecContext(ctx, "DROP DATABASE IF EXISTS "+ident(schema)); err != nil {
				t.Error("cannot clean owned isolated schema")
			}
		}
		for _, a := range []Account{writer, recovery, plan.Definer} {
			if _, err := f.Admin.ExecContext(ctx, "DROP USER IF EXISTS "+account(a)); err != nil {
				t.Error("cannot clean owned isolated account")
			}
		}
	})
	f.Exec(t, "CREATE TABLE "+qualified(catalog, "orders")+" (id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,label VARCHAR(64) NOT NULL,amount DECIMAL(12,2) NOT NULL DEFAULT 0,tenant VARCHAR(20) NOT NULL DEFAULT 'east') ENGINE=InnoDB")
	f.Exec(t, "INSERT INTO "+qualified(catalog, "orders")+"(label,amount) VALUES ('first',12.30)")
	for _, a := range []Account{writer, recovery} {
		f.Exec(t, "CREATE USER "+account(a)+" IDENTIFIED BY '"+secret+"'")
	}
	for _, statement := range plan.Statements {
		f.Exec(t, statement)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	manifest, err := CaptureInstallation(ctx, f.Admin, plan)
	if err != nil {
		for _, a := range []Account{writer, recovery, plan.Definer} {
			rows, _ := f.Admin.QueryContext(ctx, "SHOW GRANTS FOR "+account(a))
			if rows != nil {
				for rows.Next() {
					var grant string
					_ = rows.Scan(&grant)
					t.Log(grant)
				}
				rows.Close()
			}
		}
		for _, r := range plan.Routines {
			var body string
			if f.Admin.QueryRowContext(ctx, "SELECT ROUTINE_DEFINITION FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=? AND ROUTINE_NAME=?", plan.ControlCatalog, r.Name).Scan(&body) == nil && body != r.Body {
				t.Logf("body mismatch %s: %q versus %q", r.Name, body, r.Body)
			}
		}
		t.Fatal("capture: ", err)
	}
	key, _ := mutationstore.NewKey()
	enc, _ := mutationstore.NewKey()
	profile := mutationstore.Profile{SourceID: testUUID(), ConnectorID: testUUID(), WorkspaceIDs: []string{testUUID()}, Writer: mutationstore.Credential{Host: "127.0.0.1", Port: 13308, Database: catalog, Username: writer.User, Password: secret, TLS: "local"}, Recovery: mutationstore.Credential{Host: "127.0.0.1", Port: 13308, Database: catalog, Username: recovery.User, Password: secret, TLS: "local"}, ManifestPath: filepath.Join(t.TempDir(), "manifest.json"), ManifestMACKey: key, JournalKey: enc}
	c, err := NewWithDatabases(profile.Target(), manifest, f.Open(t, writer.User, secret), f.Open(t, recovery.User, secret))
	if err != nil {
		t.Fatal(err)
	}
	epoch, err := c.ReadGate(ctx)
	if err != nil {
		t.Fatal("read current gate: ", err)
	}
	apiBoot, _ := NewEpoch()
	connectorBoot, _ := NewEpoch()
	b := mutationrunner.Binding{Scope: mutationrunner.Scope{OwnerID: testUUID(), WorkspaceID: profile.WorkspaceIDs[0], SourceID: profile.SourceID, ConnectorID: profile.ConnectorID}, APIBoot: apiBoot, ConnectorBoot: connectorBoot, TargetIdentity: manifest.TargetIdentity(), TargetEpoch: epoch, PolicyGeneration: generation, InstallationGeneration: generation}
	return &mysqlLab{f, plan, manifest, c, profile, b}
}
func (l *mysqlLab) receipt() mutationrunner.Receipt {
	var raw [32]byte
	_, _ = rand.Read(raw[:])
	return mutationrunner.Receipt{ExecutionID: testUUID(), Commitment: base64.RawURLEncoding.EncodeToString(raw[:]), TargetIdentity: l.binding.TargetIdentity, TargetEpoch: l.binding.TargetEpoch, Scope: l.binding.Scope, RowCount: 1}
}
func (l *mysqlLab) begin(t *testing.T) mutationrunner.Transaction {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	t.Cleanup(cancel)
	tx, err := l.controller.Begin(ctx, l.binding)
	if err != nil {
		t.Fatal("begin: ", err)
	}
	return tx
}
func TestMySQLMutationInstallationAndAtomicReceipt(t *testing.T) {
	l := newLab(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx := l.begin(t)
	meta, err := tx.Describe(ctx, "orders")
	if err != nil {
		tx.Rollback()
		t.Fatal("describe: ", err)
	}
	if len(meta.Columns) != 4 || meta.Columns[0].Bits != 64 || !meta.Columns[0].Unsigned || !meta.Columns[0].AutoIncrement || meta.Columns[2].Scale != 2 {
		t.Fatal("complete precise metadata missing")
	}
	selectSQL, err := mutationguard.Select(meta, nil, 21, true)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := tx.Rows(ctx, selectSQL)
	if err != nil || len(rows) != 1 || rows[0]["amount"].Value != "12.30" {
		t.Fatal("exact complete rows: ", err)
	}
	statement, err := mutationguard.Update(meta, []mutationguard.Assignment{{Column: "label", Value: mutationguard.Value{Kind: "string", Value: "changed"}}}, mutationguard.Row{"id": rows[0]["id"]})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, statement); err != nil {
		t.Fatal(err)
	}
	receipt := l.receipt()
	zero := receipt
	zero.RowCount = 0
	if tx.PutReceipt(ctx, zero) == nil {
		t.Fatal("zero-change receipt accepted by adapter")
	}
	rawCommitment, _ := base64.RawURLEncoding.DecodeString(receipt.Commitment)
	if _, err := tx.(*transaction).tx.ExecContext(ctx, "CALL "+qualified(l.plan.ControlCatalog, "put_receipt")+"(?,?,?,?,?)", testUUID(), rawCommitment, scopeRaw(receipt.Scope), receipt.TargetEpoch, 0); err == nil {
		t.Fatal("zero-change receipt accepted by fixed SQL helper")
	}
	if err = tx.PutReceipt(ctx, receipt); err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if found, err := l.controller.Receipt(ctx, l.binding.Scope, receipt.ExecutionID); err != nil || found != nil {
		t.Fatal("rolled-back receipt escaped: ", err)
	}
	tx = l.begin(t)
	meta, err = tx.Describe(ctx, "orders")
	if err != nil {
		t.Fatal(err)
	}
	statement, err = mutationguard.Update(meta, []mutationguard.Assignment{{Column: "label", Value: mutationguard.Value{Kind: "string", Value: "changed"}}}, mutationguard.Row{"id": {Kind: "integer", Value: "1"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, statement); err != nil {
		t.Fatal(err)
	}
	if err = tx.PutReceipt(ctx, receipt); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	found, err := l.controller.Receipt(ctx, l.binding.Scope, receipt.ExecutionID)
	if err != nil || found == nil || *found != receipt {
		t.Fatal("committed receipt not exact: ", err)
	}
	tx = l.begin(t)
	if err = tx.PutReceipt(ctx, receipt); err == nil {
		tx.Rollback()
		t.Fatal("duplicate target receipt accepted")
	}
	tx.Rollback()
}
func TestMySQLMutationPermissionDefinitionAndScopeFailures(t *testing.T) {
	l := newLab(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	bad := l.binding
	bad.WorkspaceID = testUUID()
	if tx, err := l.controller.Begin(ctx, bad); err == nil {
		tx.Rollback()
		t.Fatal("cross-workspace admitted")
	}
	for _, query := range []string{"SELECT * FROM " + qualified(l.plan.ControlCatalog, "receipts"), "DELETE FROM " + qualified(l.plan.ControlCatalog, "receipts"), "ALTER TABLE " + qualified(l.plan.Spec.Catalog, "orders") + " ADD COLUMN forbidden INT", "CALL " + qualified(l.plan.ControlCatalog, "rotate_gate") + "(NULL,NULL)"} {
		if _, err := l.controller.writer.ExecContext(ctx, query); err == nil {
			t.Fatal("writer escaped fixed privileges")
		}
	}
	l.fixture.Exec(t, "REVOKE TRIGGER ON *.* FROM "+account(l.plan.Definer))
	if tx, err := l.controller.Begin(ctx, l.binding); err == nil {
		tx.Rollback()
		t.Fatal("partial catalog authority admitted")
	}
	l.fixture.Exec(t, "GRANT TRIGGER ON *.* TO "+account(l.plan.Definer))
	l.fixture.Exec(t, "ALTER PROCEDURE "+qualified(l.plan.ControlCatalog, "put_receipt")+" SQL SECURITY INVOKER")
	if tx, err := l.controller.Begin(ctx, l.binding); err == nil {
		tx.Rollback()
		t.Fatal("changed fixed routine admitted")
	}
}
func TestMySQLMutationRecoveryGateAndScopedDiscovery(t *testing.T) {
	l := newLab(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx := l.begin(t)
	receipt := l.receipt()
	if err := tx.PutReceipt(ctx, receipt); err != nil {
		t.Fatal(err)
	}
	blocked, stop := context.WithTimeout(ctx, 500*time.Millisecond)
	_, err := l.controller.Recover(blocked, l.binding.TargetEpoch)
	stop()
	if err == nil {
		tx.Rollback()
		t.Fatal("barrier overtook a shared old transaction")
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	current, err := l.controller.ReadGate(ctx)
	if err != nil || current != l.binding.TargetEpoch {
		t.Fatal("failed barrier changed epoch")
	}
	next, err := l.controller.Recover(ctx, current)
	if err != nil || next == current {
		t.Fatal("recovery barrier failed: ", err)
	}
	if late, err := l.controller.Begin(ctx, l.binding); err == nil {
		late.Rollback()
		t.Fatal("old epoch entered DML")
	}
	list, err := l.controller.ListReceipts(ctx, l.binding.Scope, "")
	if err != nil || len(list) != 1 || list[0] != receipt {
		t.Fatal("post-drain discovery lost old receipt: ", err)
	}
	foreign := l.binding.Scope
	foreign.SourceID = testUUID()
	if _, err = l.controller.ListReceipts(ctx, foreign, ""); err == nil {
		t.Fatal("source scope bypass")
	}
}

func TestInstallationPlanDoesNotProduceCredentialsOrReuse(t *testing.T) {
	epoch, _ := NewEpoch()
	spec := InstallSpec{Catalog: "sample", Tables: []string{"orders"}, Writer: Account{"writer", "127.0.0.1"}, Recovery: Account{"recover", "127.0.0.1"}, Incarnation: epoch, Generation: epoch}
	p, err := BuildInstallation(spec)
	if err != nil {
		t.Fatal(err)
	}
	sql := p.SQL()
	if strings.Contains(sql, "IF NOT EXISTS") || strings.Contains(sql, "IDENTIFIED BY") || !strings.Contains(sql, "ACCOUNT LOCK") || !strings.Contains(sql, "DELIMITER $$") {
		t.Fatal("plan is destructive, hides credentials, or cannot be reviewed")
	}
	other, err := BuildInstallation(spec)
	if err != nil || p.ControlCatalog != other.ControlCatalog || p.Definer != other.Definer {
		t.Fatal("same physical catalog acquired a distinct gate namespace")
	}
	malformed := spec
	malformed.Writer.User = "writer'; DROP DATABASE mysql"
	if _, err = BuildInstallation(malformed); err == nil {
		t.Fatal("account SQL injection accepted")
	}
}

func TestMySQLMutationControlMetadataLocksBlockLateDDL(t *testing.T) {
	for _, kind := range []string{"alter_receipts", "trigger_receipts", "incoming_fk", "alter_gate_routine"} {
		t.Run(kind, func(t *testing.T) {
			l := newLab(t)
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			if kind == "incoming_fk" {
				l.fixture.Exec(t, "CREATE TABLE "+qualified(l.plan.Spec.Catalog, "control_child")+" (id INT PRIMARY KEY,parent_id BINARY(36)) ENGINE=InnoDB")
			}
			tx := l.begin(t)
			defer tx.Rollback()
			admin, err := l.fixture.Admin.Conn(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer admin.Close()
			if _, err = admin.ExecContext(ctx, "SET SESSION lock_wait_timeout=1"); err != nil {
				t.Fatal(err)
			}
			statement := "ALTER TABLE " + qualified(l.plan.ControlCatalog, "receipts") + " ADD COLUMN unexpected INT"
			switch kind {
			case "trigger_receipts":
				statement = "CREATE TRIGGER " + qualified(l.plan.ControlCatalog, "unexpected_trigger") + " BEFORE INSERT ON " + qualified(l.plan.ControlCatalog, "receipts") + " FOR EACH ROW SET @unexpected=1"
			case "incoming_fk":
				statement = "ALTER TABLE " + qualified(l.plan.Spec.Catalog, "control_child") + " ADD CONSTRAINT incoming_control FOREIGN KEY(parent_id) REFERENCES " + qualified(l.plan.ControlCatalog, "receipts") + "(execution_id) ON DELETE CASCADE"
			case "alter_gate_routine":
				statement = "ALTER PROCEDURE " + qualified(l.plan.ControlCatalog, "lock_gate") + " SQL SECURITY INVOKER"
			}
			_, err = admin.ExecContext(ctx, statement)
			var server *mysql.MySQLError
			if !errors.As(err, &server) || server.Number != 1205 {
				t.Fatalf("control proof did not retain %s MDL: %v", kind, err)
			}
			if err = tx.Rollback(); err != nil {
				t.Fatal(err)
			}
			if _, err = admin.ExecContext(ctx, statement); err != nil {
				t.Fatal("DDL did not become available after rollback: ", err)
			}
		})
	}
}
