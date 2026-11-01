package g2

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"
)

// This is an installation experiment, not a product migration. A trusted DBA
// installs a fixed, argument-free helper and locks its non-login definer.
func installMetadataHelper(t *testing.T, f *mysqlFixture) (*sql.DB, string, helperDefinition) {
	return installMetadataHelperWithHook(t, f, "")
}

func installMetadataHelperWithHook(t *testing.T, f *mysqlFixture, hook string) (*sql.DB, string, helperDefinition) {
	t.Helper()
	definer := "s8g2_" + f.suffix + "_proof"
	account := "'" + definer + "'@'127.0.0.1'"
	f.exec(t, "CREATE USER "+account+" ACCOUNT LOCK")
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if !f.sameInstance(ctx, f.db) {
			t.Error("helper cleanup refused: isolated identity changed")
			return
		}
		if _, err := f.db.ExecContext(ctx, "DROP PROCEDURE IF EXISTS "+f.table("metadata_proof")); err != nil {
			t.Error("cannot remove this fixture's helper")
		}
		if _, err := f.db.ExecContext(ctx, "DROP USER "+account); err != nil {
			t.Error("cannot remove this fixture's locked helper definer")
		}
	})
	f.exec(t, "GRANT TRIGGER, REFERENCES ON *.* TO "+account)
	body := "CREATE DEFINER=" + account + " PROCEDURE " + f.table("metadata_proof") + "() SQL SECURITY DEFINER READS SQL DATA BEGIN " +
		"SHOW GRANTS FOR CURRENT_USER(); " +
		hook +
		"SELECT CURRENT_USER() AS proof_definer, @@server_uuid AS server_uuid, @@version AS server_version, '" + f.schema + "' AS target_schema, 'parent' AS target_table, @@global.mandatory_roles AS mandatory_roles, @@global.activate_all_roles_on_login AS activate_all_roles_on_login, CURRENT_ROLE() AS active_roles; " +
		"SELECT TRIGGER_SCHEMA,TRIGGER_NAME,EVENT_OBJECT_SCHEMA,EVENT_OBJECT_TABLE,EVENT_MANIPULATION,ACTION_TIMING FROM information_schema.TRIGGERS " +
		"WHERE BINARY EVENT_OBJECT_SCHEMA=BINARY '" + f.schema + "' AND BINARY EVENT_OBJECT_TABLE=BINARY 'parent' ORDER BY TRIGGER_SCHEMA,TRIGGER_NAME; " +
		"SELECT k.TABLE_SCHEMA,k.TABLE_NAME,k.CONSTRAINT_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_SCHEMA,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,k.ORDINAL_POSITION,r.DELETE_RULE,r.UPDATE_RULE " +
		"FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.TABLE_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME " +
		"WHERE BINARY k.REFERENCED_TABLE_SCHEMA=BINARY '" + f.schema + "' AND BINARY k.REFERENCED_TABLE_NAME=BINARY 'parent' ORDER BY k.TABLE_SCHEMA,k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION; " +
		"SHOW CREATE PROCEDURE " + f.table("metadata_proof") + "; " +
		"SHOW GRANTS FOR CURRENT_USER(); SELECT @@global.mandatory_roles AS mandatory_roles, @@global.activate_all_roles_on_login AS activate_all_roles_on_login, CURRENT_ROLE() AS active_roles; END"
	f.exec(t, body)
	f.exec(t, "GRANT EXECUTE ON PROCEDURE "+f.table("metadata_proof")+" TO "+account)
	caller := f.account(t, "proofcall", "EXECUTE", "PROCEDURE "+f.table("metadata_proof"), false)
	var pin helperDefinition
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := f.db.QueryRowContext(ctx, "SHOW CREATE PROCEDURE "+f.table("metadata_proof")).Scan(&pin.name, &pin.sqlMode, &pin.body, &pin.charset, &pin.collation, &pin.databaseCollation); err != nil || pin.body == "" {
		t.Fatal("trusted installer could not pin the created helper definition")
	}
	return caller, account, pin
}

type helperDefinition struct {
	name, sqlMode, body, charset, collation, databaseCollation string
}

type catalogProof struct {
	grants                                                                 []string
	finalGrants                                                            []string
	definer, uuid                                                          string
	version                                                                string
	schema, table                                                          string
	triggers, incoming                                                     int
	definition                                                             helperDefinition
	mandatoryRoles, activeRoles, closingMandatoryRoles, closingActiveRoles string
	activateAllRoles, closingActivateAllRoles                              int
}

type proofQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func metadataColumns(rows *sql.Rows, names ...string) error {
	columns, err := rows.Columns()
	if err != nil || len(columns) != len(names) {
		return fmt.Errorf("helper result shape does not match its pinned protocol")
	}
	for i := range names {
		if names[i] == "GRANTS" {
			if !strings.HasPrefix(columns[i], "Grants for ") {
				return fmt.Errorf("helper privilege result has unknown column")
			}
			continue
		}
		if columns[i] != names[i] {
			return fmt.Errorf("helper result has unknown column %s", columns[i])
		}
	}
	return nil
}

func readMetadataProof(ctx context.Context, q proofQueryer, call string) (catalogProof, error) {
	var p catalogProof
	rows, err := q.QueryContext(ctx, call)
	if err != nil {
		return p, err
	}
	defer rows.Close()
	if err := metadataColumns(rows, "GRANTS"); err != nil {
		return p, err
	}
	for rows.Next() {
		var grant string
		if err := rows.Scan(&grant); err != nil {
			return p, err
		}
		p.grants = append(p.grants, grant)
	}
	if rows.Err() != nil || !rows.NextResultSet() {
		return p, fmt.Errorf("incomplete helper grants/identity result: %v", rows.Err())
	}
	if err := metadataColumns(rows, "proof_definer", "server_uuid", "server_version", "target_schema", "target_table", "mandatory_roles", "activate_all_roles_on_login", "active_roles"); err != nil {
		return p, err
	}
	if !rows.Next() {
		return p, fmt.Errorf("empty helper identity result")
	}
	if err := rows.Scan(&p.definer, &p.uuid, &p.version, &p.schema, &p.table, &p.mandatoryRoles, &p.activateAllRoles, &p.activeRoles); err != nil {
		return p, err
	}
	if rows.Next() || rows.Err() != nil || !rows.NextResultSet() {
		return p, fmt.Errorf("incomplete helper trigger result")
	}
	if err := metadataColumns(rows, "TRIGGER_SCHEMA", "TRIGGER_NAME", "EVENT_OBJECT_SCHEMA", "EVENT_OBJECT_TABLE", "EVENT_MANIPULATION", "ACTION_TIMING"); err != nil {
		return p, err
	}
	for rows.Next() {
		var a, b, c, d, e, f string
		if err := rows.Scan(&a, &b, &c, &d, &e, &f); err != nil {
			return p, err
		}
		if c != p.schema || d != p.table {
			return p, fmt.Errorf("unexpected target in helper trigger proof")
		}
		p.triggers++
	}
	if rows.Err() != nil || !rows.NextResultSet() {
		return p, fmt.Errorf("incomplete helper incoming FK result")
	}
	if err := metadataColumns(rows, "TABLE_SCHEMA", "TABLE_NAME", "CONSTRAINT_NAME", "COLUMN_NAME", "REFERENCED_TABLE_SCHEMA", "REFERENCED_TABLE_NAME", "REFERENCED_COLUMN_NAME", "ORDINAL_POSITION", "DELETE_RULE", "UPDATE_RULE"); err != nil {
		return p, err
	}
	for rows.Next() {
		var a, b, c, d, e, f, g, update, remove string
		var ordinal int
		if err := rows.Scan(&a, &b, &c, &d, &e, &f, &g, &ordinal, &remove, &update); err != nil {
			return p, err
		}
		if e != p.schema || f != p.table {
			return p, fmt.Errorf("unexpected target in helper incoming FK proof")
		}
		p.incoming++
	}
	if rows.Err() != nil {
		return p, rows.Err()
	}
	if !rows.NextResultSet() {
		return p, fmt.Errorf("missing helper definition proof")
	}
	if err := metadataColumns(rows, "Procedure", "sql_mode", "Create Procedure", "character_set_client", "collation_connection", "Database Collation"); err != nil {
		return p, err
	}
	if !rows.Next() {
		return p, fmt.Errorf("empty helper definition proof")
	}
	if err := rows.Scan(&p.definition.name, &p.definition.sqlMode, &p.definition.body, &p.definition.charset, &p.definition.collation, &p.definition.databaseCollation); err != nil {
		return p, err
	}
	if rows.Next() || rows.Err() != nil || !rows.NextResultSet() {
		return p, fmt.Errorf("missing closing privilege proof")
	}
	if err := metadataColumns(rows, "GRANTS"); err != nil {
		return p, err
	}
	for rows.Next() {
		var grant string
		if err := rows.Scan(&grant); err != nil {
			return p, err
		}
		p.finalGrants = append(p.finalGrants, grant)
	}
	if rows.Err() != nil {
		return p, rows.Err()
	}
	if !rows.NextResultSet() {
		return p, fmt.Errorf("missing closing role environment")
	}
	if err := metadataColumns(rows, "mandatory_roles", "activate_all_roles_on_login", "active_roles"); err != nil {
		return p, err
	}
	if !rows.Next() {
		return p, fmt.Errorf("empty closing role environment")
	}
	if err := rows.Scan(&p.closingMandatoryRoles, &p.closingActivateAllRoles, &p.closingActiveRoles); err != nil {
		return p, err
	}
	if rows.Next() || rows.Err() != nil {
		return p, fmt.Errorf("invalid closing role environment")
	}
	if rows.NextResultSet() {
		return p, fmt.Errorf("unexpected trailing helper result, even if empty")
	}
	if rows.Err() != nil {
		return p, rows.Err()
	}
	return p, nil
}

// The installation grant contract is deliberately a strict allowlist. Unknown
// forms, roles, partial REVOKEs, extra powers, or a missing global grant fail.
// No statement is accepted merely because it contains the word REFERENCES.
func validateMetadataProof(p catalogProof, f *mysqlFixture, account string, pin helperDefinition) error {
	wantGlobal := "GRANT REFERENCES, TRIGGER ON *.* TO " + strings.ReplaceAll(account, "'", "`")
	wantExecute := "GRANT EXECUTE ON PROCEDURE " + f.table("metadata_proof") + " TO " + strings.ReplaceAll(account, "'", "`")
	if len(p.grants) != 2 || len(p.finalGrants) != 2 || p.definer != strings.ReplaceAll(account, "'", "") || p.uuid != f.uuid || p.version != "26.7.0" || p.schema != f.schema || p.table != "parent" {
		return fmt.Errorf("helper identity or grant envelope is not the pinned installation")
	}
	if p.grants[0] != p.finalGrants[0] || p.grants[1] != p.finalGrants[1] {
		return fmt.Errorf("helper catalog authority changed during collection")
	}
	if pin.body == "" || p.definition != pin {
		return fmt.Errorf("helper body or creation environment differs from the trusted installation")
	}
	if p.mandatoryRoles != "" || p.closingMandatoryRoles != "" || p.activateAllRoles != 0 || p.closingActivateAllRoles != 0 || p.activeRoles != "NONE" || p.closingActiveRoles != "NONE" {
		return fmt.Errorf("implicit or active roles prevent exact metadata authority proof")
	}
	seen := map[string]bool{}
	for _, grant := range append(append([]string{}, p.grants...), p.finalGrants...) {
		if grant != wantGlobal && grant != wantExecute {
			return fmt.Errorf("helper privileges do not prove complete visibility: %s", grant)
		}
		seen[grant] = true
	}
	if !seen[wantGlobal] || !seen[wantExecute] {
		return fmt.Errorf("helper lacks exact unfiltered catalog authority")
	}
	return nil
}

func TestMySQLFixedDefinerProcedureCompleteness(t *testing.T) {
	f := newMySQLFixture(t)
	f.exec(t, "CREATE TABLE "+f.table("parent")+" (id INT PRIMARY KEY, label VARCHAR(20)) ENGINE=InnoDB")
	f.exec(t, "CREATE TABLE "+f.hiddenTable("child")+" (id INT PRIMARY KEY, parent_id INT, CONSTRAINT incoming_fk FOREIGN KEY (parent_id) REFERENCES "+f.table("parent")+"(id) ON DELETE CASCADE) ENGINE=InnoDB")
	f.exec(t, "CREATE TRIGGER "+mysqlIdent(f.schema)+".parent_trigger BEFORE UPDATE ON "+f.table("parent")+" FOR EACH ROW SET @g2_helper=1")
	f.exec(t, "INSERT INTO "+f.table("parent")+" VALUES (1,'fixture')")
	caller, account, pin := installMetadataHelper(t, f)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	p, err := readMetadataProof(ctx, caller, "CALL "+f.table("metadata_proof")+"()")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("procedure identity=%s version=%s trigger=%d incoming=%d grants=%v", p.definer, p.version, p.triggers, p.incoming, p.grants)
	if err := validateMetadataProof(p, f, account, pin); err != nil {
		t.Fatal(err)
	}
	if p.triggers != 1 || p.incoming != 1 {
		t.Fatal("fixed DEFINER procedure did not expose both known hidden dependencies")
	}
	for _, statement := range []string{
		"SELECT * FROM " + f.table("parent"),
		"SELECT * FROM " + f.hiddenTable("child"),
		"DROP TRIGGER " + mysqlIdent(f.schema) + ".parent_trigger",
		"ALTER TABLE " + f.table("parent") + " ADD COLUMN forbidden INT",
	} {
		_, err := caller.ExecContext(ctx, statement)
		requireMySQLError(t, err, 1142)
	}
	_, err = caller.ExecContext(ctx, "DROP PROCEDURE "+f.table("metadata_proof"))
	requireMySQLError(t, err, 1370)
	_, err = caller.ExecContext(ctx, "ALTER PROCEDURE "+f.table("metadata_proof")+" SQL SECURITY INVOKER")
	requireMySQLError(t, err, 1370)
	_, err = caller.ExecContext(ctx, "CALL "+f.table("metadata_proof")+"('other_schema')")
	requireMySQLError(t, err, 1318)
	var locked string
	if err := f.db.QueryRowContext(ctx, "SELECT account_locked FROM mysql.user WHERE User=? AND Host='127.0.0.1'", "s8g2_"+f.suffix+"_proof").Scan(&locked); err != nil || locked != "Y" {
		t.Fatal("trusted installer did not create an account-locked definer")
	}
	t.Log("EXECUTE-only caller cannot read business rows or change target/helper/trigger; helper is immutable to the runtime identity, argument-free and bound to one target")
}

func TestMySQLMetadataHelperRevocationAndPartialRevokesFailClosed(t *testing.T) {
	f := newMySQLFixture(t)
	f.exec(t, "CREATE TABLE "+f.table("parent")+" (id INT PRIMARY KEY) ENGINE=InnoDB")
	f.exec(t, "CREATE TABLE "+f.hiddenTable("child")+" (id INT PRIMARY KEY, parent_id INT, CONSTRAINT incoming_fk FOREIGN KEY (parent_id) REFERENCES "+f.table("parent")+"(id)) ENGINE=InnoDB")
	f.exec(t, "CREATE TRIGGER "+mysqlIdent(f.schema)+".known_trigger BEFORE UPDATE ON "+f.table("parent")+" FOR EACH ROW SET @g2_helper_revocation=1")
	caller, account, pin := installMetadataHelper(t, f)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	collect := func() catalogProof {
		t.Helper()
		p, err := readMetadataProof(ctx, caller, "CALL "+f.table("metadata_proof")+"()")
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	for _, privilege := range []string{"TRIGGER", "REFERENCES"} {
		f.exec(t, "REVOKE "+privilege+" ON *.* FROM "+account)
		p := collect()
		if validateMetadataProof(p, f, account, pin) == nil {
			t.Fatal("missing global visibility privilege became an acceptable empty catalog")
		}
		t.Logf("revoked %s: trigger=%d incoming=%d; strict grant envelope rejected", privilege, p.triggers, p.incoming)
		f.exec(t, "GRANT "+privilege+" ON *.* TO "+account)
	}
	var previous int
	if err := f.db.QueryRowContext(ctx, "SELECT @@global.partial_revokes").Scan(&previous); err != nil {
		t.Fatal(err)
	}
	if previous != 0 {
		t.Fatal("expected fresh isolated instance partial_revokes=OFF")
	}
	f.exec(t, "SET GLOBAL partial_revokes=ON")
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if f.sameInstance(ctx, f.db) {
			if _, err := f.db.ExecContext(ctx, "SET GLOBAL partial_revokes=OFF"); err != nil {
				t.Error("cannot restore new-instance-only partial_revokes setting")
			}
		}
	})
	f.exec(t, "REVOKE REFERENCES ON "+mysqlIdent(f.hidden)+".* FROM "+account)
	p := collect()
	if validateMetadataProof(p, f, account, pin) == nil || len(p.grants) != 3 {
		t.Fatal("partial schema revoke was not explicitly rejected")
	}
	t.Logf("partial REVOKE appeared as a third grant-envelope statement; trigger=%d incoming=%d; refused even if rows happen to remain visible", p.triggers, p.incoming)
	f.exec(t, "GRANT REFERENCES ON "+mysqlIdent(f.hidden)+".* TO "+account)
	if err := validateMetadataProof(collect(), f, account, pin); err != nil {
		t.Fatal("restoring exact fixture contract did not restore proof: ", err)
	}
}

func TestMySQLMetadataHelperRevokedDuringCollectionIsRejected(t *testing.T) {
	f := newMySQLFixture(t)
	f.exec(t, "CREATE TABLE "+f.table("parent")+" (id INT PRIMARY KEY) ENGINE=InnoDB")
	f.exec(t, "CREATE TRIGGER "+mysqlIdent(f.schema)+".known_trigger BEFORE UPDATE ON "+f.table("parent")+" FOR EACH ROW SET @g2_helper_midcall=1")
	lockName := "g2_meta_" + f.suffix
	caller, account, pin := installMetadataHelperWithHook(t, f, "DO GET_LOCK('"+lockName+"',8); DO RELEASE_LOCK('"+lockName+"'); ")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	holder, err := f.db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()
	var held int
	if err := holder.QueryRowContext(ctx, "SELECT GET_LOCK(?,1)", lockName).Scan(&held); err != nil || held != 1 {
		t.Fatal("cannot create controlled metadata-collection barrier")
	}
	defer holder.ExecContext(context.Background(), "DO RELEASE_LOCK(?)", lockName)
	rows, err := caller.QueryContext(ctx, "CALL "+f.table("metadata_proof")+"()")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var first []string
	for rows.Next() {
		var grant string
		if err := rows.Scan(&grant); err != nil {
			t.Fatal(err)
		}
		first = append(first, grant)
	}
	if len(first) != 2 || !strings.Contains(first[0], "REFERENCES, TRIGGER") {
		t.Fatal("collection did not begin with known complete authority")
	}
	f.exec(t, "REVOKE TRIGGER ON *.* FROM "+account)
	if _, err := holder.ExecContext(ctx, "DO RELEASE_LOCK(?)", lockName); err != nil {
		t.Fatal(err)
	}
	// Drain the remaining results; a fresh call must reject the changed grants.
	// SHOW GRANTS at the end of this same call must also observe the revocation.
	var final []string
	for rows.NextResultSet() {
		columns, err := rows.Columns()
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			values := make([]any, len(columns))
			pointers := make([]any, len(columns))
			for i := range values {
				pointers[i] = &values[i]
			}
			if err := rows.Scan(pointers...); err != nil {
				t.Fatal(err)
			}
			if len(columns) == 1 {
				if raw, ok := values[0].([]byte); ok {
					final = append(final, string(raw))
				}
			}
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	if len(final) != 2 || strings.Contains(final[0], "TRIGGER") || first[0] == final[0] {
		t.Fatalf("mid-call privilege removal was not caught by closing proof: first=%v final=%v", first, final)
	}
	p, err := readMetadataProof(ctx, caller, "CALL "+f.table("metadata_proof")+"()")
	if err != nil || validateMetadataProof(p, f, account, pin) == nil {
		t.Fatal("post-revocation proof was accepted")
	}
	t.Log("real REVOKE between initial grants and catalog reads changed the closing envelope; proof rejected. DBA grant ABA remains a trusted-maintenance boundary, not a claim of grant-table locking")
}

func TestMySQLMetadataHelperSharesWriteTransactionAndDDLBarrier(t *testing.T) {
	for _, kind := range []string{"alter_target", "new_trigger", "incoming_foreign_key", "alter_helper", "drop_helper"} {
		t.Run(kind, func(t *testing.T) {
			f := newMySQLFixture(t)
			f.exec(t, "CREATE TABLE "+f.table("parent")+" (id INT PRIMARY KEY, label VARCHAR(20) NOT NULL DEFAULT 'fixture') ENGINE=InnoDB")
			f.exec(t, "CREATE TABLE "+f.hiddenTable("child")+" (id INT PRIMARY KEY, parent_id INT) ENGINE=InnoDB")
			f.exec(t, "INSERT INTO "+f.table("parent")+"(id) VALUES (1)")
			_, account, pin := installMetadataHelper(t, f)
			writer := f.account(t, "lockedwriter", "SELECT, UPDATE", f.table("parent"), false)
			f.exec(t, "GRANT EXECUTE ON PROCEDURE "+f.table("metadata_proof")+" TO 's8g2_"+f.suffix+"_lockedwriter'@'127.0.0.1'")
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			tx, err := writer.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			var label string
			if err := tx.QueryRowContext(ctx, "SELECT label FROM "+f.table("parent")+" WHERE id=1 FOR UPDATE").Scan(&label); err != nil || label != "fixture" {
				t.Fatal("cannot acquire target's real row and metadata locks")
			}
			var table, definition string
			if err := tx.QueryRowContext(ctx, "SHOW CREATE TABLE "+f.table("parent")).Scan(&table, &definition); err != nil || !strings.Contains(definition, "PRIMARY KEY (`id`)") || !strings.Contains(definition, "ENGINE=InnoDB") || !strings.Contains(definition, "DEFAULT 'fixture'") {
				t.Fatal("writer could not obtain the complete target definition under the same lock")
			}
			if _, err := tx.ExecContext(ctx, "UPDATE "+f.table("parent")+" SET label='uncommitted' WHERE id=1"); err != nil {
				t.Fatal(err)
			}
			p, err := readMetadataProof(ctx, tx, "CALL "+f.table("metadata_proof")+"()")
			if err != nil || validateMetadataProof(p, f, account, pin) != nil || p.triggers != 0 || p.incoming != 0 {
				t.Fatal("dependency-free table did not obtain complete in-transaction proof: ", err)
			}
			ddl := "ALTER TABLE " + f.table("parent") + " ADD COLUMN extra INT"
			switch kind {
			case "new_trigger":
				ddl = "CREATE TRIGGER " + mysqlIdent(f.schema) + ".new_trigger BEFORE UPDATE ON " + f.table("parent") + " FOR EACH ROW SET @g2_proof_mdl=1"
			case "incoming_foreign_key":
				ddl = "ALTER TABLE " + f.hiddenTable("child") + " ADD CONSTRAINT new_incoming_fk FOREIGN KEY(parent_id) REFERENCES " + f.table("parent") + "(id) ON DELETE CASCADE"
			case "alter_helper":
				ddl = "ALTER PROCEDURE " + f.table("metadata_proof") + " SQL SECURITY INVOKER"
			case "drop_helper":
				ddl = "DROP PROCEDURE " + f.table("metadata_proof")
			}
			admin, err := f.db.Conn(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer admin.Close()
			if _, err := admin.ExecContext(ctx, "SET SESSION lock_wait_timeout=1"); err != nil {
				t.Fatal(err)
			}
			_, err = admin.ExecContext(ctx, ddl)
			requireMySQLError(t, err, 1205)
			if err := tx.Rollback(); err != nil {
				t.Fatal(err)
			}
			if mysqlCount(t, f.db, "SELECT COUNT(*) FROM "+f.table("parent")+" WHERE label='fixture'") != 1 {
				t.Fatal("calling the proof helper implicitly committed candidate DML")
			}
			if _, err := admin.ExecContext(ctx, ddl); err != nil {
				t.Fatal("blocked DDL did not become possible after proof transaction ended: ", err)
			}
			t.Log("full target definition and hidden-dependency proof shared one write transaction; " + kind + " blocked until rollback, and helper did not commit DML")
		})
	}
}

func TestMySQLMetadataTargetDefinitionIncludesAutomaticBehavior(t *testing.T) {
	f := newMySQLFixture(t)
	f.exec(t, "CREATE TABLE "+f.table("parent")+" (id INT PRIMARY KEY, label VARCHAR(20) NOT NULL DEFAULT 'fixture', amount DECIMAL(12,2) NOT NULL DEFAULT 0, calculated INT GENERATED ALWAYS AS (id+1) STORED, changed TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY label_unique(label), CONSTRAINT amount_nonnegative CHECK (amount >= 0)) ENGINE=InnoDB")
	f.exec(t, "INSERT INTO "+f.table("parent")+"(id) VALUES (1)")
	writer := f.account(t, "bundle", "SELECT, UPDATE", f.table("parent"), false)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	tx, err := writer.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var id int
	if err := tx.QueryRowContext(ctx, "SELECT id FROM "+f.table("parent")+" WHERE id=1 FOR UPDATE").Scan(&id); err != nil {
		t.Fatal(err)
	}
	var name, definition string
	if err := tx.QueryRowContext(ctx, "SHOW CREATE TABLE "+f.table("parent")).Scan(&name, &definition); err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"ENGINE=InnoDB", "PRIMARY KEY (`id`)", "UNIQUE KEY `label_unique`", "CHECK", "GENERATED ALWAYS AS", "ON UPDATE CURRENT_TIMESTAMP", "decimal(12,2)", "DEFAULT 'fixture'"} {
		if !strings.Contains(definition, required) {
			t.Fatalf("full target definition omitted %s", required)
		}
	}
	rows, err := tx.QueryContext(ctx, "SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,GENERATION_EXPRESSION,ORDINAL_POSITION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='parent' ORDER BY ORDINAL_POSITION", f.schema)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	count, automatic := 0, 0
	for rows.Next() {
		var column, kind, nullable, extra, expression string
		var defaultValue sql.NullString
		var ordinal int
		if err := rows.Scan(&column, &kind, &nullable, &defaultValue, &extra, &expression, &ordinal); err != nil {
			t.Fatal(err)
		}
		count++
		if ordinal != count {
			t.Fatal("target column list was incomplete")
		}
		if expression != "" || strings.Contains(extra, "on update") {
			automatic++
		}
	}
	if rows.Err() != nil || count != 5 || automatic != 2 {
		t.Fatalf("target automatic behavior was not completely observable: columns=%d automatic=%d err=%v", count, automatic, rows.Err())
	}
	t.Log("SHOW CREATE TABLE and complete ordered COLUMNS under target MDL expose primary/unique/check/default/generated/on-update/type definitions; automatic behavior requires rejection, not treating zero triggers as table admission")
}

func TestMySQLMetadataHelperWrongInstallationAndEmptyShapesRejected(t *testing.T) {
	for _, kind := range []string{"changed_body", "empty_trigger_wrong_shape", "empty_fk_wrong_shape", "truncated", "extra_empty_set"} {
		t.Run(kind, func(t *testing.T) {
			f := newMySQLFixture(t)
			f.exec(t, "CREATE TABLE "+f.table("parent")+" (id INT PRIMARY KEY) ENGINE=InnoDB")
			caller, account, pin := installMetadataHelper(t, f)
			definition := strings.Replace(pin.body, "PROCEDURE `metadata_proof`", "PROCEDURE "+f.table("metadata_proof"), 1)
			switch kind {
			case "changed_body":
				definition = strings.Replace(definition, "BEGIN ", "BEGIN DO 0; ", 1)
			case "empty_trigger_wrong_shape":
				start := strings.Index(definition, "SELECT TRIGGER_SCHEMA")
				end := strings.Index(definition[start:], ";") + start
				definition = definition[:start] + "SELECT 1 AS unexpected WHERE FALSE" + definition[end:]
			case "empty_fk_wrong_shape":
				start := strings.Index(definition, "SELECT k.TABLE_SCHEMA")
				end := strings.Index(definition[start:], ";") + start
				definition = definition[:start] + "SELECT 1 AS unexpected WHERE FALSE" + definition[end:]
			case "truncated":
				start := strings.LastIndex(definition, "SHOW GRANTS FOR CURRENT_USER();")
				definition = definition[:start] + "END"
			case "extra_empty_set":
				start := strings.LastIndex(definition, "END")
				definition = definition[:start] + "SELECT 1 AS unexpected WHERE FALSE; END"
			}
			f.exec(t, "DROP PROCEDURE "+f.table("metadata_proof"))
			f.exec(t, definition)
			f.exec(t, "GRANT EXECUTE ON PROCEDURE "+f.table("metadata_proof")+" TO "+account)
			f.exec(t, "GRANT EXECUTE ON PROCEDURE "+f.table("metadata_proof")+" TO 's8g2_"+f.suffix+"_proofcall'@'127.0.0.1'")
			ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
			defer cancel()
			p, err := readMetadataProof(ctx, caller, "CALL "+f.table("metadata_proof")+"()")
			if kind == "changed_body" {
				if err != nil || p.definition == pin {
					t.Fatal("routine owner did not expose the real changed definition: ", err)
				}
				if err := validateMetadataProof(p, f, account, pin); err == nil || !strings.Contains(err.Error(), "body") {
					t.Fatal("changed routine body bypassed installation commitment")
				}
			} else if err == nil {
				t.Fatal("empty, truncated or unknown result shape became an absence proof")
			}
			t.Log(kind + ": rejected against exact result protocol and trusted installed definition; no SHOW_ROUTINE privilege granted to caller")
		})
	}
}

func TestMySQLMetadataHelperRejectsImplicitMandatoryRoles(t *testing.T) {
	f := newMySQLFixture(t)
	f.exec(t, "CREATE TABLE "+f.table("parent")+" (id INT PRIMARY KEY) ENGINE=InnoDB")
	caller, account, pin := installMetadataHelper(t, f)
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	var priorMandatory string
	var priorActivate int
	if err := f.db.QueryRowContext(ctx, "SELECT @@global.mandatory_roles,@@global.activate_all_roles_on_login").Scan(&priorMandatory, &priorActivate); err != nil || priorMandatory != "" || priorActivate != 0 {
		t.Fatal("mandatory-role experiment requires the fresh instance's default role configuration")
	}
	role := "s8g2_" + f.suffix + "_mandatory"
	roleAccount := "'" + role + "'@'%'"
	f.exec(t, "CREATE ROLE "+roleAccount)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if !f.sameInstance(ctx, f.db) {
			t.Error("role cleanup refused: isolated identity changed")
			return
		}
		for _, statement := range []string{"SET GLOBAL activate_all_roles_on_login=OFF", "SET GLOBAL mandatory_roles=''", "DROP ROLE " + roleAccount} {
			if _, err := f.db.ExecContext(ctx, statement); err != nil {
				t.Error("cannot restore this new-instance-only role fixture: ", err)
			}
		}
	})
	f.exec(t, "GRANT ALTER ON "+f.table("parent")+" TO "+roleAccount)
	f.exec(t, "SET GLOBAL mandatory_roles='"+role+"'")
	f.exec(t, "SET GLOBAL activate_all_roles_on_login=ON")
	p, err := readMetadataProof(ctx, caller, "CALL "+f.table("metadata_proof")+"()")
	if err != nil {
		t.Fatal(err)
	}
	if len(p.grants) != 2 || len(p.finalGrants) != 2 || p.mandatoryRoles == "" {
		t.Fatalf("known implicit-role grant-hiding behavior changed: grants=%v roles=%s mandatory=%s", p.grants, p.activeRoles, p.mandatoryRoles)
	}
	if err := validateMetadataProof(p, f, account, pin); err == nil || !strings.Contains(err.Error(), "roles") {
		t.Fatal("SHOW GRANTS exact match hid an active mandatory role from the admission check")
	}
	observedRoles := p.activeRoles
	newCaller := f.account(t, "rolecaller", "EXECUTE", "PROCEDURE "+f.table("metadata_proof"), false)
	if _, err := newCaller.ExecContext(ctx, "ALTER TABLE "+f.table("parent")+" ADD COLUMN implicit_ddl_authority INT"); err != nil {
		t.Fatal("fixture did not demonstrate inherited mandatory-role DDL authority: ", err)
	}
	f.exec(t, "SET GLOBAL activate_all_roles_on_login=OFF")
	f.exec(t, "SET GLOBAL mandatory_roles=''")
	p, err = readMetadataProof(ctx, caller, "CALL "+f.table("metadata_proof")+"()")
	if err != nil || validateMetadataProof(p, f, account, pin) != nil {
		t.Fatal("restored explicit no-role environment did not restore the proof contract: ", err)
	}
	t.Log("SHOW GRANTS FOR CURRENT_USER still had two expected lines; old helper context CURRENT_ROLE=" + observedRoles + "; fresh runtime login inherited mandatory-role ALTER. Explicit pre/post role-environment checks reject even when the old context reports NONE")
}
