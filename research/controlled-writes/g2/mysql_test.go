package g2

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"example.com/stackoryn/research/controlled-writes-g2/internal/lab"
	"github.com/go-sql-driver/mysql"
)

// These are database-primitive experiments, not the production write runner.
// openVerifiedMySQL must verify the fresh G2 instance before any fixture DDL.
type mysqlFixture struct {
	db             *sql.DB
	schema, hidden string
	suffix         string
	dir, uuid      string
}

func newMySQLFixture(t *testing.T) *mysqlFixture {
	t.Helper()
	db := openVerifiedMySQL(t)
	var random [6]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal("cannot create fixture identity")
	}
	suffix := hex.EncodeToString(random[:])
	f := &mysqlFixture{db: db, schema: "stage8_g2_" + suffix, hidden: "stage8_g2_hidden_" + suffix, suffix: suffix}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var port int
	if err := db.QueryRowContext(ctx, "SELECT @@port, @@datadir, @@server_uuid").Scan(&port, &f.dir, &f.uuid); err != nil || port != 13308 || f.uuid == "" {
		t.Fatal("verified G2 connection identity unavailable")
	}
	for _, schema := range []string{f.schema, f.hidden} {
		f.exec(t, "CREATE DATABASE "+mysqlIdent(schema)+" CHARACTER SET utf8mb4 COLLATE utf8mb4_bin")
		name := schema
		t.Cleanup(func() {
			cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			if !f.sameInstance(cleanup, db) {
				t.Error("cleanup refused: G2 database identity changed")
				return
			}
			if _, err := db.ExecContext(cleanup, "DROP DATABASE "+mysqlIdent(name)); err != nil {
				t.Error("cannot remove this test's isolated schema")
			}
		})
	}
	return f
}

// Fixture names come only from cryptographic hexadecimal suffixes, never input.
func mysqlIdent(value string) string { return "`" + value + "`" }
func (f *mysqlFixture) table(name string) string {
	return mysqlIdent(f.schema) + "." + mysqlIdent(name)
}
func (f *mysqlFixture) hiddenTable(name string) string {
	return mysqlIdent(f.hidden) + "." + mysqlIdent(name)
}
func (f *mysqlFixture) exec(t *testing.T, statement string, args ...any) sql.Result {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	result, err := f.db.ExecContext(ctx, statement, args...)
	if err != nil {
		t.Fatalf("isolated fixture statement failed: %v", err)
	}
	return result
}
func (f *mysqlFixture) sameInstance(ctx context.Context, db *sql.DB) bool {
	var port int
	var dir, uuid string
	err := db.QueryRowContext(ctx, "SELECT @@port, @@datadir, @@server_uuid").Scan(&port, &dir, &uuid)
	return err == nil && port == 13308 && dir == f.dir && uuid == f.uuid
}
func (f *mysqlFixture) account(t *testing.T, role, privileges, object string, foundRows bool) *sql.DB {
	t.Helper()
	user := "s8g2_" + f.suffix + "_" + role
	var secret [24]byte
	if _, err := rand.Read(secret[:]); err != nil {
		t.Fatal("cannot create isolated fixture credential")
	}
	password := hex.EncodeToString(secret[:])
	// This account exists only on the guard-verified disposable instance.
	f.exec(t, "CREATE USER '"+user+"'@'127.0.0.1' IDENTIFIED BY '"+password+"'")
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if !f.sameInstance(ctx, f.db) {
			t.Error("account cleanup refused: G2 identity changed")
			return
		}
		if _, err := f.db.ExecContext(ctx, "DROP USER '"+user+"'@'127.0.0.1'"); err != nil {
			t.Error("cannot remove this test's isolated account")
		}
	})
	f.exec(t, "GRANT "+privileges+" ON "+object+" TO '"+user+"'@'127.0.0.1'")
	manifest, err := lab.Load(os.Getenv("STAGE8_G2_MANIFEST"))
	if err != nil {
		t.Fatal("cannot load the explicit isolated account target")
	}
	db, err := lab.OpenAccount(manifest, user, password, foundRows)
	if err != nil {
		t.Fatal("cannot configure the pinned isolated account")
	}
	db.SetMaxOpenConns(2)
	db.SetMaxIdleConns(2)
	t.Cleanup(func() { _ = db.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !f.sameInstance(ctx, db) {
		t.Fatal("isolated account did not reach the pinned G2 instance")
	}
	return db
}
func mysqlCount(t *testing.T, db *sql.DB, query string, args ...any) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var count int
	if err := db.QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
		t.Fatalf("cannot inspect isolated fixture count: %v", err)
	}
	return count
}
func requireMySQLError(t *testing.T, err error, code uint16) {
	t.Helper()
	var serverError *mysql.MySQLError
	if !errors.As(err, &serverError) || serverError.Number != code {
		t.Fatalf("expected MySQL error %d; got %v", code, err)
	}
}

func TestMySQLMetadataVisibilityIsNotCompletenessProof(t *testing.T) {
	f := newMySQLFixture(t)
	f.exec(t, "CREATE TABLE "+f.table("parent")+" (id INT PRIMARY KEY, label VARCHAR(20)) ENGINE=InnoDB")
	f.exec(t, "CREATE TABLE "+f.hiddenTable("child")+" (id INT PRIMARY KEY, parent_id INT, CONSTRAINT incoming_fk FOREIGN KEY (parent_id) REFERENCES "+f.table("parent")+"(id) ON DELETE CASCADE) ENGINE=InnoDB")
	f.exec(t, "CREATE TRIGGER "+mysqlIdent(f.schema)+".hidden_trigger BEFORE UPDATE ON "+f.table("parent")+" FOR EACH ROW SET @g2_trigger_observed=1")
	f.exec(t, "INSERT INTO "+f.table("parent")+" VALUES (1,'synthetic')")
	f.exec(t, "INSERT INTO "+f.hiddenTable("child")+" VALUES (1,1)")
	writer := f.account(t, "writer", "SELECT, INSERT, UPDATE, DELETE", f.table("parent"), false)
	metadata := f.account(t, "meta", "SHOW DATABASES, SHOW VIEW, PROCESS", "*.*", false)
	triggerQuery := "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=? AND EVENT_OBJECT_TABLE='parent'"
	fkQuery := "SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME='parent'"
	rootTriggers, writerTriggers, metadataTriggers := mysqlCount(t, f.db, triggerQuery, f.schema), mysqlCount(t, writer, triggerQuery, f.schema), mysqlCount(t, metadata, triggerQuery, f.schema)
	rootFK, writerFK, metadataFK := mysqlCount(t, f.db, fkQuery, f.schema), mysqlCount(t, writer, fkQuery, f.schema), mysqlCount(t, metadata, fkQuery, f.schema)
	if rootTriggers != 1 || rootFK != 1 || writerTriggers != 0 || metadataTriggers != 0 {
		t.Fatalf("metadata hypothesis mismatch: trigger counts root/writer/meta=%d/%d/%d, reverse FK=%d/%d/%d", rootTriggers, writerTriggers, metadataTriggers, rootFK, writerFK, metadataFK)
	}
	t.Logf("visible trigger counts root=%d table-writer=%d metadata-candidate=%d; incoming-FK counts=%d/%d/%d", rootTriggers, writerTriggers, metadataTriggers, rootFK, writerFK, metadataFK)
	// TRIGGER is not a read-only inspection privilege: it also permits dropping
	// the very trigger whose absence the verifier is trying to prove.
	inspector := f.account(t, "inspect", "TRIGGER, REFERENCES", "*.*", false)
	if mysqlCount(t, inspector, triggerQuery, f.schema) != 1 || mysqlCount(t, inspector, fkQuery, f.schema) != 1 {
		t.Fatal("TRIGGER/REFERENCES did not expose the known synthetic dependencies")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := inspector.ExecContext(ctx, "DROP TRIGGER "+mysqlIdent(f.schema)+".hidden_trigger"); err != nil {
		t.Fatalf("cannot demonstrate TRIGGER's DDL authority: %v", err)
	}
	if mysqlCount(t, f.db, triggerQuery, f.schema) != 0 {
		t.Fatal("fixture trigger was not dropped by the metadata candidate")
	}
	_, err := inspector.ExecContext(ctx, "SELECT * FROM "+f.hiddenTable("child"))
	requireMySQLError(t, err, 1142)
	_, err = writer.ExecContext(ctx, "ALTER TABLE "+f.table("parent")+" ADD COLUMN forbidden INT")
	requireMySQLError(t, err, 1142)
	_, err = writer.ExecContext(ctx, "INSERT INTO "+f.hiddenTable("child")+" VALUES (2,1)")
	requireMySQLError(t, err, 1142)
	if _, err := writer.ExecContext(ctx, "DELETE FROM "+f.table("parent")+" WHERE id=1"); err != nil {
		t.Fatalf("cannot observe the isolated cascade: %v", err)
	}
	if mysqlCount(t, f.db, "SELECT COUNT(*) FROM "+f.hiddenTable("child")) != 0 {
		t.Fatal("fixture did not demonstrate the known cascading side effect")
	}
	t.Log("the table-only writer cannot directly insert into the hidden child but DELETE on the granted parent cascades into it; table grants alone do not bound effects")
	t.Log("G2 LIMITATION: the tested metadata-only candidate cannot prove trigger absence; granting TRIGGER changes schema authority and is not an acceptable read-only verifier credential")
}

func TestMySQLWriteTransactionMetadataLocksBlockDDL(t *testing.T) {
	for _, kind := range []string{"alter_target", "create_trigger", "incoming_foreign_key"} {
		t.Run(kind, func(t *testing.T) {
			f := newMySQLFixture(t)
			f.exec(t, "CREATE TABLE "+f.table("parent")+" (id INT PRIMARY KEY, label VARCHAR(20)) ENGINE=InnoDB")
			f.exec(t, "INSERT INTO "+f.table("parent")+" VALUES (1,'original')")
			f.exec(t, "CREATE TABLE "+f.hiddenTable("child")+" (id INT PRIMARY KEY, parent_id INT) ENGINE=InnoDB")
			writer := f.account(t, "writer", "SELECT, INSERT, UPDATE, DELETE", f.table("parent"), false)
			ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
			defer cancel()
			tx, err := writer.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal("cannot begin isolated write transaction")
			}
			defer tx.Rollback()
			var label string
			if err := tx.QueryRowContext(ctx, "SELECT label FROM "+f.table("parent")+" WHERE id=1 FOR UPDATE").Scan(&label); err != nil {
				t.Fatal("cannot acquire the fixture table/row locks")
			}
			ddlConn, err := f.db.Conn(ctx)
			if err != nil {
				t.Fatal("cannot acquire isolated DDL connection")
			}
			defer ddlConn.Close()
			if _, err := ddlConn.ExecContext(ctx, "SET SESSION lock_wait_timeout=1"); err != nil {
				t.Fatal("cannot set isolated metadata lock timeout")
			}
			ddl := "ALTER TABLE " + f.table("parent") + " ADD COLUMN extra INT"
			switch kind {
			case "create_trigger":
				ddl = "CREATE TRIGGER " + mysqlIdent(f.schema) + ".new_trigger BEFORE UPDATE ON " + f.table("parent") + " FOR EACH ROW SET @g2_mdl_trigger=1"
			case "incoming_foreign_key":
				ddl = "ALTER TABLE " + f.hiddenTable("child") + " ADD CONSTRAINT new_incoming_fk FOREIGN KEY (parent_id) REFERENCES " + f.table("parent") + "(id) ON DELETE CASCADE"
			}
			started := time.Now()
			_, err = ddlConn.ExecContext(ctx, ddl)
			requireMySQLError(t, err, 1205)
			t.Logf("%s blocked while target write transaction held locks: %s", kind, time.Since(started))
			if err := tx.Rollback(); err != nil {
				t.Fatal("cannot release isolated transaction")
			}
			if _, err := ddlConn.ExecContext(ctx, ddl); err != nil {
				t.Fatalf("DDL failed after target locks were released: %v", err)
			}
		})
	}
}

func TestMySQLPostImageAuthorizationCanRollbackWholeMutation(t *testing.T) {
	f := newMySQLFixture(t)
	f.exec(t, "CREATE TABLE "+f.table("scoped_rows")+" (id INT PRIMARY KEY AUTO_INCREMENT, region VARCHAR(12) NOT NULL DEFAULT 'south', label VARCHAR(20) NOT NULL) ENGINE=InnoDB")
	f.exec(t, "INSERT INTO "+f.table("scoped_rows")+" (id,region,label) VALUES (1,'east','original'),(2,'south','outside')")
	writer := f.account(t, "writer", "SELECT, INSERT, UPDATE, DELETE", f.table("scoped_rows"), false)
	for _, kind := range []string{"update_outside", "insert_outside", "insert_default_outside", "delete_outside"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			tx, err := writer.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal("cannot begin isolated scope experiment")
			}
			defer tx.Rollback()
			var id int64
			var region string
			switch kind {
			case "update_outside":
				if err := tx.QueryRowContext(ctx, "SELECT region FROM "+f.table("scoped_rows")+" WHERE id=1 FOR UPDATE").Scan(&region); err != nil || region != "east" {
					t.Fatal("old row does not satisfy the fixture policy")
				}
				if _, err := tx.ExecContext(ctx, "UPDATE "+f.table("scoped_rows")+" SET region=? WHERE id=1", "south"); err != nil {
					t.Fatal("cannot write isolated candidate postimage")
				}
				id = 1
			case "insert_outside", "insert_default_outside":
				statement := "INSERT INTO " + f.table("scoped_rows") + " (region,label) VALUES ('south','candidate')"
				if kind == "insert_default_outside" {
					statement = "INSERT INTO " + f.table("scoped_rows") + " (label) VALUES ('candidate')"
				}
				result, err := tx.ExecContext(ctx, statement)
				if err != nil {
					t.Fatal("cannot insert isolated candidate postimage")
				}
				id, err = result.LastInsertId()
				if err != nil || id <= 2 {
					t.Fatal("cannot reliably locate the inserted fixture row")
				}
			case "delete_outside":
				id = 2
			}
			if err := tx.QueryRowContext(ctx, "SELECT region FROM "+f.table("scoped_rows")+" WHERE id=? FOR UPDATE", id).Scan(&region); err != nil {
				t.Fatal("cannot read the actual row used by the scope decision")
			}
			if region == "east" {
				t.Fatal("fixture did not actually create an out-of-scope image")
			}
			if err := tx.Rollback(); err != nil {
				t.Fatal("cannot confirm isolated scope rollback")
			}
			if mysqlCount(t, f.db, "SELECT COUNT(*) FROM "+f.table("scoped_rows")) != 2 || mysqlCount(t, f.db, "SELECT COUNT(*) FROM "+f.table("scoped_rows")+" WHERE id=1 AND region='east' AND label='original'") != 1 {
				t.Fatal("scope rejection did not preserve the complete original fixture")
			}
			t.Logf("%s: actual row scope denied before commit; rollback preserved original rows", kind)
		})
	}
	t.Log("This proves rollback/readback primitives for synthetic policies, not production MutationGuard or Connector authorization")
}

func TestMySQLPrecisionStrictErrorsAndAffectedRows(t *testing.T) {
	f := newMySQLFixture(t)
	f.exec(t, "CREATE TABLE "+f.table("exact_values")+" (id BIGINT UNSIGNED PRIMARY KEY, amount DECIMAL(40,18) NOT NULL, payload VARBINARY(16) NOT NULL, optional VARCHAR(8), label VARCHAR(6) NOT NULL) ENGINE=InnoDB")
	const id = "18446744073709551615"
	const amount = "12345678901234567890.123456789012345678"
	payload := []byte{0, 255, 39, 92, 1}
	f.exec(t, "INSERT INTO "+f.table("exact_values")+" VALUES (?,?,?,?,?)", id, amount, payload, nil, "old")
	writer := f.account(t, "writer", "SELECT, INSERT, UPDATE, DELETE", f.table("exact_values"), false)
	found := f.account(t, "found", "SELECT, INSERT, UPDATE, DELETE", f.table("exact_values"), true)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var gotID, gotAmount string
	var gotPayload []byte
	var optional sql.NullString
	if err := writer.QueryRowContext(ctx, "SELECT CAST(id AS CHAR),CAST(amount AS CHAR),payload,optional FROM "+f.table("exact_values")+" WHERE id=?", id).Scan(&gotID, &gotAmount, &gotPayload, &optional); err != nil || gotID != id || gotAmount != amount || !bytes.Equal(gotPayload, payload) || optional.Valid {
		t.Fatalf("exact fixture values did not round-trip: %v", err)
	}
	for _, candidate := range []struct {
		db   *sql.DB
		want int64
		name string
	}{{writer, 0, "default_changed_rows"}, {found, 1, "client_found_rows"}} {
		result, err := candidate.db.ExecContext(ctx, "UPDATE "+f.table("exact_values")+" SET label='old' WHERE id=?", id)
		if err != nil {
			t.Fatal("cannot observe affected-row semantics")
		}
		count, err := result.RowsAffected()
		if err != nil || count != candidate.want {
			t.Fatalf("%s affected rows=%d want=%d: %v", candidate.name, count, candidate.want, err)
		}
		t.Logf("%s reports %d for one matched unchanged row", candidate.name, count)
	}
	conn, err := writer.Conn(ctx)
	if err != nil {
		t.Fatal("cannot reserve strict-mode fixture connection")
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "SET SESSION sql_mode='STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'"); err != nil {
		t.Fatal("cannot fix trusted strict-mode test settings")
	}
	_, err = conn.ExecContext(ctx, "INSERT INTO "+f.table("exact_values")+" VALUES (7,1,X'01',NULL,'too-long')")
	requireMySQLError(t, err, 1406)
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal("cannot begin atomic-batch experiment")
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "INSERT INTO "+f.table("exact_values")+" VALUES (7,1,X'01',NULL,'first')"); err != nil {
		t.Fatal("cannot create first uncommitted batch row")
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO "+f.table("exact_values")+" VALUES (?,1,X'01',NULL,'second')", id)
	requireMySQLError(t, err, 1062)
	if err := tx.Rollback(); err != nil {
		t.Fatal("cannot confirm batch rollback")
	}
	if mysqlCount(t, f.db, "SELECT COUNT(*) FROM "+f.table("exact_values")+" WHERE id=7") != 0 {
		t.Fatal("first row of the failed batch persisted")
	}
	t.Log("uint64/decimal/binary/NULL round-trip exact; strict truncation rejected; duplicate-key batch fully rolled back")
}

func TestMySQLFrozenKeysAndABALimitation(t *testing.T) {
	f := newMySQLFixture(t)
	f.exec(t, "CREATE TABLE "+f.table("targets")+" (id INT PRIMARY KEY, region VARCHAR(12), label VARCHAR(20)) ENGINE=InnoDB")
	f.exec(t, "INSERT INTO "+f.table("targets")+" VALUES (1,'east','normal'),(2,'east','normal'),(3,'south','normal')")
	writer := f.account(t, "writer", "SELECT, INSERT, UPDATE, DELETE", f.table("targets"), false)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	rows, err := writer.QueryContext(ctx, "SELECT id FROM "+f.table("targets")+" WHERE region='east' ORDER BY id")
	if err != nil {
		t.Fatal("cannot preview frozen fixture keys")
	}
	var frozen []int
	for rows.Next() {
		var key int
		if err := rows.Scan(&key); err != nil {
			rows.Close()
			t.Fatal("cannot scan frozen fixture key")
		}
		frozen = append(frozen, key)
	}
	rowErr := rows.Err()
	rows.Close()
	if rowErr != nil || fmt.Sprint(frozen) != "[1 2]" {
		t.Fatal("unexpected complete fixture target set")
	}
	f.exec(t, "INSERT INTO "+f.table("targets")+" VALUES (4,'east','normal')")
	tx, err := writer.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal("cannot start frozen-key experiment")
	}
	defer tx.Rollback()
	for _, key := range frozen {
		var region, label string
		if err := tx.QueryRowContext(ctx, "SELECT region,label FROM "+f.table("targets")+" WHERE id=? FOR UPDATE", key).Scan(&region, &label); err != nil || region != "east" || label != "normal" {
			t.Fatal("frozen target no longer equals its preview")
		}
	}
	if _, err := tx.ExecContext(ctx, "UPDATE "+f.table("targets")+" SET label=? WHERE id IN (?,?)", "priority", frozen[0], frozen[1]); err != nil {
		t.Fatal("cannot execute bounded frozen-key change")
	}
	if err := tx.Commit(); err != nil {
		t.Fatal("cannot confirm frozen-key experiment commit")
	}
	if mysqlCount(t, f.db, "SELECT COUNT(*) FROM "+f.table("targets")+" WHERE label='priority'") != 2 || mysqlCount(t, f.db, "SELECT COUNT(*) FROM "+f.table("targets")+" WHERE id=4 AND label='normal'") != 1 {
		t.Fatal("later matching row was incorrectly included")
	}
	image := func() string {
		t.Helper()
		var key int
		var region, label string
		if err := writer.QueryRowContext(ctx, "SELECT id,region,label FROM "+f.table("targets")+" WHERE id=1").Scan(&key, &region, &label); err != nil {
			t.Fatal("cannot read complete synthetic row image")
		}
		return fmt.Sprintf("%d/%s/%s", key, region, label)
	}
	before := image()
	f.exec(t, "UPDATE "+f.table("targets")+" SET label='temporary' WHERE id=1")
	f.exec(t, "UPDATE "+f.table("targets")+" SET label='priority' WHERE id=1")
	if image() != before {
		t.Fatal("ABA experiment did not return to the identical row image")
	}
	f.exec(t, "DELETE FROM "+f.table("targets")+" WHERE id=1")
	f.exec(t, "INSERT INTO "+f.table("targets")+" VALUES (1,'east','priority')")
	if image() != before {
		t.Fatal("same-key reconstruction experiment did not recreate identical values")
	}
	t.Log("frozen keys exclude a later matching row; ABA and same-key/same-value reconstruction produce identical fingerprint inputs and cannot prove unmodified history")
}

func TestMySQLRowLockTimeoutDoesNotCommitOtherBatchChanges(t *testing.T) {
	f := newMySQLFixture(t)
	f.exec(t, "CREATE TABLE "+f.table("locked_rows")+" (id INT PRIMARY KEY, label VARCHAR(20)) ENGINE=InnoDB")
	f.exec(t, "INSERT INTO "+f.table("locked_rows")+" VALUES (1,'one'),(2,'two')")
	writer := f.account(t, "writer", "SELECT, INSERT, UPDATE, DELETE", f.table("locked_rows"), false)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	holder, err := f.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal("cannot begin lock holder")
	}
	defer holder.Rollback()
	if _, err := holder.ExecContext(ctx, "UPDATE "+f.table("locked_rows")+" SET label='held' WHERE id=1"); err != nil {
		t.Fatal("cannot lock isolated row")
	}
	conn, err := writer.Conn(ctx)
	if err != nil {
		t.Fatal("cannot reserve timeout connection")
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "SET SESSION innodb_lock_wait_timeout=1"); err != nil {
		t.Fatal("cannot set isolated row lock timeout")
	}
	batch, err := conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal("cannot begin isolated batch")
	}
	defer batch.Rollback()
	if _, err := batch.ExecContext(ctx, "UPDATE "+f.table("locked_rows")+" SET label='changed' WHERE id=2"); err != nil {
		t.Fatal("cannot create first uncommitted change")
	}
	_, err = batch.ExecContext(ctx, "UPDATE "+f.table("locked_rows")+" SET label='blocked' WHERE id=1")
	requireMySQLError(t, err, 1205)
	if err := batch.Rollback(); err != nil {
		t.Fatal("cannot explicitly roll back batch after lock timeout")
	}
	if err := holder.Rollback(); err != nil {
		t.Fatal("cannot release lock holder")
	}
	if mysqlCount(t, f.db, "SELECT COUNT(*) FROM "+f.table("locked_rows")+" WHERE (id=1 AND label='one') OR (id=2 AND label='two')") != 2 {
		t.Fatal("a batch change escaped the explicit rollback")
	}
	t.Log("lock timeout returned 1205; explicit full rollback preserved both original rows (timeout alone was not treated as proof)")
}

// Retain the failed G2 view candidate as a counterexample. The known hidden
// dependencies must still exist while the view returns zero; a future change
// in version behavior requires re-evaluation, never silently treating it safe.
func TestMySQLLockedDefinerViewsCannotProveCompleteness(t *testing.T) {
	f := newMySQLFixture(t)
	f.exec(t, "CREATE TABLE "+f.table("parent")+" (id INT PRIMARY KEY, label VARCHAR(20)) ENGINE=InnoDB")
	f.exec(t, "CREATE TABLE "+f.table("other_parent")+" (id INT PRIMARY KEY, label VARCHAR(20)) ENGINE=InnoDB")
	f.exec(t, "CREATE TABLE "+f.hiddenTable("child")+" (id INT PRIMARY KEY, parent_id INT, CONSTRAINT incoming_fk FOREIGN KEY (parent_id) REFERENCES "+f.table("parent")+"(id) ON DELETE CASCADE) ENGINE=InnoDB")
	f.exec(t, "CREATE TABLE "+f.hiddenTable("other_child")+" (id INT PRIMARY KEY, parent_id INT, CONSTRAINT other_incoming_fk FOREIGN KEY (parent_id) REFERENCES "+f.table("other_parent")+"(id)) ENGINE=InnoDB")
	f.exec(t, "CREATE TRIGGER "+mysqlIdent(f.schema)+".parent_trigger BEFORE UPDATE ON "+f.table("parent")+" FOR EACH ROW SET @g2_definer_parent=1")
	f.exec(t, "CREATE TRIGGER "+mysqlIdent(f.schema)+".other_trigger BEFORE UPDATE ON "+f.table("other_parent")+" FOR EACH ROW SET @g2_definer_other=1")
	f.exec(t, "INSERT INTO "+f.table("parent")+" VALUES (1,'synthetic')")
	definer := "s8g2_" + f.suffix + "_definer"
	definerAccount := "'" + definer + "'@'127.0.0.1'"
	f.exec(t, "CREATE USER "+definerAccount+" ACCOUNT LOCK")
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if !f.sameInstance(ctx, f.db) {
			t.Error("definer cleanup refused: G2 identity changed")
			return
		}
		for _, view := range []string{"trigger_proof", "incoming_fk_proof"} {
			if _, err := f.db.ExecContext(ctx, "DROP VIEW IF EXISTS "+f.table(view)); err != nil {
				t.Error("cannot remove this test's definer view")
			}
		}
		if _, err := f.db.ExecContext(ctx, "DROP USER "+definerAccount); err != nil {
			t.Error("cannot remove this test's locked definer")
		}
	})
	f.exec(t, "GRANT TRIGGER ON "+f.table("parent")+" TO "+definerAccount)
	f.exec(t, "GRANT REFERENCES ON *.* TO "+definerAccount)
	triggerView := "CREATE DEFINER=" + definerAccount + " SQL SECURITY DEFINER VIEW " + f.table("trigger_proof") +
		" AS SELECT TRIGGER_SCHEMA,TRIGGER_NAME,EVENT_OBJECT_SCHEMA,EVENT_OBJECT_TABLE,EVENT_MANIPULATION,ACTION_TIMING FROM information_schema.TRIGGERS" +
		" WHERE BINARY EVENT_OBJECT_SCHEMA=BINARY '" + f.schema + "' AND BINARY EVENT_OBJECT_TABLE=BINARY 'parent'"
	fkView := "CREATE DEFINER=" + definerAccount + " SQL SECURITY DEFINER VIEW " + f.table("incoming_fk_proof") +
		" AS SELECT k.TABLE_SCHEMA,k.TABLE_NAME,k.CONSTRAINT_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_SCHEMA,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,k.ORDINAL_POSITION,r.DELETE_RULE,r.UPDATE_RULE" +
		" FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r" +
		" ON r.CONSTRAINT_SCHEMA=k.TABLE_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME" +
		" WHERE BINARY k.REFERENCED_TABLE_SCHEMA=BINARY '" + f.schema + "' AND BINARY k.REFERENCED_TABLE_NAME=BINARY 'parent'"
	f.exec(t, triggerView)
	f.exec(t, fkView)
	invoker := f.account(t, "view", "SELECT", f.table("trigger_proof"), false)
	invokerAccount := "'s8g2_" + f.suffix + "_view'@'127.0.0.1'"
	f.exec(t, "GRANT SELECT ON "+f.table("incoming_fk_proof")+" TO "+invokerAccount)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var locked string
	if err := f.db.QueryRowContext(ctx, "SELECT account_locked FROM mysql.user WHERE User=? AND Host='127.0.0.1'", definer).Scan(&locked); err != nil || locked != "Y" {
		t.Fatal("catalog definer is not explicitly account-locked")
	}
	manifest, err := lab.Load(os.Getenv("STAGE8_G2_MANIFEST"))
	if err != nil {
		t.Fatal("cannot load the explicit definer experiment target")
	}
	lockedDB, err := lab.OpenAccount(manifest, definer, "", false)
	if err != nil {
		t.Fatal("cannot configure the locked-definer login probe")
	}
	loginErr := lockedDB.PingContext(ctx)
	lockedDB.Close()
	if loginErr == nil {
		t.Fatal("account-locked definer unexpectedly accepted a client login")
	}
	visibleTriggers := mysqlCount(t, invoker, "SELECT COUNT(*) FROM "+f.table("trigger_proof"))
	visibleFK := mysqlCount(t, invoker, "SELECT COUNT(*) FROM "+f.table("incoming_fk_proof"))
	t.Logf("locked-definer candidate: invoker trigger=%d incoming-FK=%d; DBA view trigger=%d incoming-FK=%d", visibleTriggers, visibleFK,
		mysqlCount(t, f.db, "SELECT COUNT(*) FROM "+f.table("trigger_proof")), mysqlCount(t, f.db, "SELECT COUNT(*) FROM "+f.table("incoming_fk_proof")))
	if visibleTriggers != 0 || visibleFK != 0 || mysqlCount(t, f.db, "SELECT COUNT(*) FROM "+f.table("trigger_proof")) != 1 || mysqlCount(t, f.db, "SELECT COUNT(*) FROM "+f.table("incoming_fk_proof")) != 1 {
		t.Fatal("the documented incomplete view counterexample changed; re-evaluate the candidate instead of assuming completeness")
	}
	if mysqlCount(t, invoker, "SELECT COUNT(*) FROM "+f.table("incoming_fk_proof")+" WHERE DELETE_RULE='CASCADE'") != 0 {
		t.Fatal("view counterexample no longer hides the known incoming cascade")
	}
	for _, query := range []string{
		"SELECT COUNT(*) FROM " + f.table("trigger_proof") + " WHERE EVENT_OBJECT_TABLE='other_parent'",
		"SELECT COUNT(*) FROM " + f.table("incoming_fk_proof") + " WHERE REFERENCED_TABLE_NAME='other_parent'",
	} {
		if mysqlCount(t, invoker, query) != 0 {
			t.Fatal("caller widened the view's immutable target scope")
		}
	}
	if mysqlCount(t, invoker, "SELECT COUNT(*) FROM "+f.table("trigger_proof")+" WHERE EVENT_OBJECT_SCHEMA=?", f.hidden) != 0 ||
		mysqlCount(t, invoker, "SELECT COUNT(*) FROM "+f.table("incoming_fk_proof")+" WHERE REFERENCED_TABLE_SCHEMA=?", f.hidden) != 0 {
		t.Fatal("bound scope parameter redirected a fixed catalog view")
	}
	if mysqlCount(t, invoker, "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=?", f.schema) != 0 ||
		mysqlCount(t, invoker, "SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=?", f.schema) != 0 {
		t.Fatal("invoker unexpectedly received direct dependency catalog authority")
	}
	for _, statement := range []string{
		"SELECT * FROM " + f.table("parent"),
		"SELECT * FROM " + f.hiddenTable("child"),
		"DROP TRIGGER " + mysqlIdent(f.schema) + ".parent_trigger",
		"DROP VIEW " + f.table("trigger_proof"),
		"ALTER VIEW " + f.table("trigger_proof") + " AS SELECT 1 AS substituted",
		"CREATE VIEW " + f.table("forbidden") + " AS SELECT 1 AS substituted",
	} {
		_, err := invoker.ExecContext(ctx, statement)
		requireMySQLError(t, err, 1142)
	}
	showDefinition := func(db *sql.DB, view string) (string, error) {
		var name, definition, charset, collation string
		err := db.QueryRowContext(ctx, "SHOW CREATE VIEW "+f.table(view)).Scan(&name, &definition, &charset, &collation)
		return definition, err
	}
	_, err = showDefinition(invoker, "trigger_proof")
	requireMySQLError(t, err, 1142)
	t.Logf("candidate A: SELECT-only invoker observed trigger=%d incoming-FK=%d, and cannot SHOW CREATE VIEW to verify the installed definition", visibleTriggers, visibleFK)
	for _, view := range []string{"trigger_proof", "incoming_fk_proof"} {
		f.exec(t, "GRANT SHOW VIEW ON "+f.table(view)+" TO "+invokerAccount)
		definition, err := showDefinition(invoker, view)
		if err != nil || !strings.Contains(definition, "SQL SECURITY DEFINER") || !strings.Contains(definition, "DEFINER="+mysqlIdent(definer)+"@`127.0.0.1`") || !strings.Contains(definition, f.schema) {
			t.Fatalf("cannot verify the fixed view definition and definer: %v", err)
		}
		var identity, security string
		if err := invoker.QueryRowContext(ctx, "SELECT DEFINER,SECURITY_TYPE FROM information_schema.VIEWS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?", f.schema, view).Scan(&identity, &security); err != nil || identity != definer+"@127.0.0.1" || security != "DEFINER" {
			t.Fatal("view identity does not match the trusted fixture installation")
		}
		t.Logf("candidate B: fixed %s definition SHA256=%x; %s", view, sha256.Sum256([]byte(definition)), definition)
	}
	for _, statement := range []string{
		"ALTER VIEW " + f.table("trigger_proof") + " AS SELECT 1 AS substituted",
		"DROP TRIGGER " + mysqlIdent(f.schema) + ".parent_trigger",
		"SELECT * FROM " + f.table("parent"),
	} {
		_, err := invoker.ExecContext(ctx, statement)
		requireMySQLError(t, err, 1142)
	}
	// A view projecting INFORMATION_SCHEMA does not turn absent rows into a
	// completeness attestation. Losing the definer's grants must be detectable.
	f.exec(t, "REVOKE TRIGGER ON "+f.table("parent")+" FROM "+definerAccount)
	if mysqlCount(t, invoker, "SELECT COUNT(*) FROM "+f.table("trigger_proof")) != 0 ||
		mysqlCount(t, f.db, "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=? AND EVENT_OBJECT_TABLE='parent'", f.schema) != 1 {
		t.Fatal("definer grant-revocation completeness counterexample was not reproduced")
	}
	f.exec(t, "GRANT TRIGGER ON "+f.table("parent")+" TO "+definerAccount)
	f.exec(t, "REVOKE REFERENCES ON *.* FROM "+definerAccount)
	if mysqlCount(t, invoker, "SELECT COUNT(*) FROM "+f.table("incoming_fk_proof")) != 0 ||
		mysqlCount(t, f.db, "SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME='parent'", f.schema) != 1 {
		t.Fatal("definer REFERENCES-revocation completeness counterexample was not reproduced")
	}
	f.exec(t, "GRANT REFERENCES ON *.* TO "+definerAccount)
	if mysqlCount(t, invoker, "SELECT COUNT(*) FROM "+f.table("trigger_proof")) != 0 || mysqlCount(t, invoker, "SELECT COUNT(*) FROM "+f.table("incoming_fk_proof")) != 0 {
		t.Fatal("restored definer grants changed the view counterexample; re-evaluate before admission")
	}
	for _, viewSQL := range []string{triggerView, fkView} {
		f.exec(t, strings.Replace(viewSQL, "CREATE DEFINER=", "ALTER ALGORITHM=TEMPTABLE DEFINER=", 1))
	}
	materializedTriggers := mysqlCount(t, invoker, "SELECT COUNT(*) FROM "+f.table("trigger_proof"))
	materializedFK := mysqlCount(t, invoker, "SELECT COUNT(*) FROM "+f.table("incoming_fk_proof"))
	t.Logf("bounded ALGORITHM=TEMPTABLE variant: invoker trigger=%d incoming-FK=%d; DBA view trigger=%d incoming-FK=%d", materializedTriggers, materializedFK,
		mysqlCount(t, f.db, "SELECT COUNT(*) FROM "+f.table("trigger_proof")), mysqlCount(t, f.db, "SELECT COUNT(*) FROM "+f.table("incoming_fk_proof")))
	if materializedTriggers != 0 || materializedFK != 0 || mysqlCount(t, f.db, "SELECT COUNT(*) FROM "+f.table("trigger_proof")) != 1 || mysqlCount(t, f.db, "SELECT COUNT(*) FROM "+f.table("incoming_fk_proof")) != 1 {
		t.Fatal("TEMPTABLE counterexample changed; expected hidden dependencies must remain real while invoker sees zero")
	}
	t.Log("G2 LIMITATION: installation/definer identity inspection is possible with narrow view grants, but visibility and definer-grant completeness must be proven independently; zero view rows do not prove no side effects")
	t.Log("This candidate requires separately approved DBA installation; no object was installed in any pre-existing database, and production tamper/supply-chain/least-privilege validation is not complete")
}
