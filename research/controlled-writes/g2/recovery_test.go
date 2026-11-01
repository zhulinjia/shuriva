package g2

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"example.com/stackoryn/research/controlled-writes-g2/internal/lab"
	bolt "go.etcd.io/bbolt"
)

// Experiment-only three-store protocol. The target receipt and business DML
// share a target transaction; neither bbolt nor platform SQL is that transaction.
// A missing receipt is deliberately NOT evidence that execution may be retried.
type recoveryGrant struct {
	ID, Commitment, Scope, Incarnation string
	APIBoot, ConnectorBoot             string
	TargetEpoch                        string
}

type recoveryFixture struct {
	f                  *mysqlFixture
	writer             *sql.DB
	user, secret       string
	scope, incarnation string
	targetEpoch        string
	commitmentKey      []byte
	localPath          string
}

var errRecoveryOldProcess = errors.New("old process grant is query-only")
var errRecoveryConsumed = errors.New("execution attempt is already consumed or its evidence disagrees")

type recoveryLocalRecord struct {
	Grant     recoveryGrant
	Attempted bool
}

func recoveryRandom(t *testing.T, size int) string {
	t.Helper()
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		t.Fatal("cannot generate disposable recovery identity")
	}
	return hex.EncodeToString(value)
}

func newRecoveryFixture(t *testing.T) *recoveryFixture {
	t.Helper()
	f := newMySQLFixture(t)
	r := &recoveryFixture{f: f, scope: "scope-" + f.suffix, incarnation: recoveryRandom(t, 16), targetEpoch: recoveryRandom(t, 16), localPath: filepath.Join(t.TempDir(), "recovery.db")}
	r.commitmentKey = make([]byte, 32)
	if _, err := rand.Read(r.commitmentKey); err != nil {
		t.Fatal(err)
	}
	if mysqlCount(t, f.db, "SELECT @@innodb_flush_log_at_trx_commit") != 1 {
		t.Fatal("target receipt experiment requires synchronized InnoDB commit logging")
	}
	f.exec(t, "CREATE TABLE "+f.table("business")+" (id INT PRIMARY KEY, value INT NOT NULL) ENGINE=InnoDB")
	f.exec(t, "INSERT INTO "+f.table("business")+" VALUES (1,0)")
	f.exec(t, "CREATE TABLE "+f.table("authority")+" (id VARBINARY(80) PRIMARY KEY, commitment VARBINARY(64) NOT NULL, scope_id VARBINARY(80) NOT NULL, incarnation VARBINARY(64) NOT NULL, api_boot VARBINARY(64) NOT NULL, connector_boot VARBINARY(64) NOT NULL,target_epoch VARBINARY(64) NOT NULL, state VARBINARY(32) NOT NULL) ENGINE=InnoDB")
	f.exec(t, "CREATE TABLE "+f.hiddenTable("receipts")+" (id VARBINARY(80) PRIMARY KEY, commitment BINARY(32) NOT NULL, scope_id VARBINARY(80) NOT NULL, incarnation VARBINARY(64) NOT NULL,target_epoch VARBINARY(64) NOT NULL) ENGINE=InnoDB")
	f.exec(t, "CREATE TABLE "+f.hiddenTable("gate")+" (scope_id VARBINARY(80) PRIMARY KEY,epoch VARBINARY(64) NOT NULL) ENGINE=InnoDB")
	f.exec(t, "INSERT INTO "+f.hiddenTable("gate")+" VALUES (?,?)", r.scope, r.targetEpoch)
	definer := "s8g2_" + f.suffix + "_rcdef"
	r.user, r.secret = "s8g2_"+f.suffix+"_rcwriter", recoveryRandom(t, 32)
	for _, statement := range []string{
		"CREATE USER '" + definer + "'@'127.0.0.1' ACCOUNT LOCK",
		"GRANT INSERT,SELECT ON " + f.hiddenTable("receipts") + " TO '" + definer + "'@'127.0.0.1'",
		"GRANT SELECT,UPDATE ON " + f.hiddenTable("gate") + " TO '" + definer + "'@'127.0.0.1'",
		"CREATE USER '" + r.user + "'@'127.0.0.1' IDENTIFIED BY '" + r.secret + "'",
		"GRANT SELECT,UPDATE ON " + f.table("business") + " TO '" + r.user + "'@'127.0.0.1'",
	} {
		f.exec(t, statement)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if !f.sameInstance(ctx, f.db) {
			t.Error("recovery account cleanup refused a changed isolated instance")
			return
		}
		for _, name := range []string{"put_receipt", "get_receipt", "list_receipts", "rotate_gate"} {
			if _, err := f.db.ExecContext(ctx, "DROP PROCEDURE "+mysqlIdent(f.hidden)+"."+mysqlIdent(name)); err != nil {
				t.Error("cannot remove isolated recovery helper")
			}
		}
		for _, user := range []string{r.user, definer} {
			if _, err := f.db.ExecContext(ctx, "DROP USER '"+user+"'@'127.0.0.1'"); err != nil {
				t.Error("cannot remove isolated recovery identity")
			}
		}
	})
	// No dynamic SQL, transaction control, business row access or caller-selected
	// scope/catalog. The locked definer has receipt INSERT/SELECT and gate
	// SELECT/UPDATE; ordinary writers cannot call the exclusive recovery helper.
	// CALL is deliberately tested inside the caller's transaction below.
	f.exec(t, "CREATE DEFINER='"+definer+"'@'127.0.0.1' PROCEDURE "+mysqlIdent(f.hidden)+".put_receipt(IN p_id VARBINARY(80), IN p_commitment VARBINARY(32),IN p_epoch VARBINARY(64)) SQL SECURITY DEFINER MODIFIES SQL DATA BEGIN DECLARE actual_epoch VARBINARY(64); SELECT epoch INTO actual_epoch FROM "+f.hiddenTable("gate")+" WHERE scope_id='"+r.scope+"' FOR SHARE; IF p_id IS NULL OR p_commitment IS NULL OR p_epoch IS NULL OR actual_epoch IS NULL OR actual_epoch <> p_epoch OR OCTET_LENGTH(p_id) <> 37 OR CONVERT(p_id USING ascii) NOT REGEXP '^exec-[0-9a-f]{32}$' OR OCTET_LENGTH(p_commitment) <> 32 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='invalid receipt metadata or fenced epoch'; END IF; INSERT INTO "+f.hiddenTable("receipts")+" VALUES (p_id,p_commitment,'"+r.scope+"','"+r.incarnation+"',p_epoch); END")
	f.exec(t, "CREATE DEFINER='"+definer+"'@'127.0.0.1' PROCEDURE "+mysqlIdent(f.hidden)+".get_receipt(IN p_id VARBINARY(80)) SQL SECURITY DEFINER READS SQL DATA SELECT HEX(commitment),scope_id,incarnation,target_epoch FROM "+f.hiddenTable("receipts")+" WHERE id=p_id AND scope_id='"+r.scope+"' AND incarnation='"+r.incarnation+"'")
	f.exec(t, "CREATE DEFINER='"+definer+"'@'127.0.0.1' PROCEDURE "+mysqlIdent(f.hidden)+".list_receipts(IN p_after VARBINARY(80)) SQL SECURITY DEFINER READS SQL DATA SELECT id,HEX(commitment),scope_id,incarnation,target_epoch FROM "+f.hiddenTable("receipts")+" WHERE id>p_after AND scope_id='"+r.scope+"' AND incarnation='"+r.incarnation+"' ORDER BY id LIMIT 100")
	f.exec(t, "CREATE DEFINER='"+definer+"'@'127.0.0.1' PROCEDURE "+mysqlIdent(f.hidden)+".rotate_gate(IN p_expected VARBINARY(64),IN p_next VARBINARY(64)) SQL SECURITY DEFINER MODIFIES SQL DATA BEGIN DECLARE actual_epoch VARBINARY(64); SELECT epoch INTO actual_epoch FROM "+f.hiddenTable("gate")+" WHERE scope_id='"+r.scope+"' FOR UPDATE; IF p_expected IS NULL OR p_next IS NULL OR actual_epoch IS NULL OR actual_epoch<>p_expected OR OCTET_LENGTH(p_expected)<>32 OR OCTET_LENGTH(p_next)<>32 OR CONVERT(p_next USING ascii) NOT REGEXP '^[0-9a-f]{32}$' OR p_expected=p_next THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='invalid recovery barrier'; END IF; UPDATE "+f.hiddenTable("gate")+" SET epoch=p_next WHERE scope_id='"+r.scope+"'; END")
	f.exec(t, "GRANT EXECUTE ON PROCEDURE "+mysqlIdent(f.hidden)+".rotate_gate TO '"+definer+"'@'127.0.0.1'")
	for _, user := range []string{definer, r.user} {
		for _, name := range []string{"put_receipt", "get_receipt", "list_receipts"} {
			f.exec(t, "GRANT EXECUTE ON PROCEDURE "+mysqlIdent(f.hidden)+"."+mysqlIdent(name)+" TO '"+user+"'@'127.0.0.1'")
		}
	}
	m, err := lab.Load(os.Getenv("STAGE8_G2_MANIFEST"))
	if err != nil {
		t.Fatal(err)
	}
	r.writer, err = lab.OpenAccount(m, r.user, r.secret, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.writer.Close() })
	return r
}

func (r *recoveryFixture) grant(t *testing.T) recoveryGrant {
	g := recoveryGrant{ID: "exec-" + recoveryRandom(t, 16), Scope: r.scope, Incarnation: r.incarnation, APIBoot: recoveryRandom(t, 16), ConnectorBoot: recoveryRandom(t, 16), TargetEpoch: r.targetEpoch}
	mac := hmac.New(sha256.New, r.commitmentKey)
	payload, _ := json.Marshal([]string{g.ID, g.Scope, g.Incarnation, g.TargetEpoch, "fixed-synthetic-increment"})
	mac.Write(payload)
	g.Commitment = hex.EncodeToString(mac.Sum(nil))
	return g
}

func (r *recoveryFixture) register(t *testing.T, g recoveryGrant) {
	t.Helper()
	r.f.exec(t, "INSERT INTO "+r.f.table("authority")+" VALUES (?,?,?,?,?,?,?,'registered')", g.ID, g.Commitment, g.Scope, g.Incarnation, g.APIBoot, g.ConnectorBoot, g.TargetEpoch)
}

func recoveryJournal(path string, g recoveryGrant) error {
	db, err := journalOpen(path)
	if err != nil {
		return err
	}
	defer db.Close()
	return db.Update(func(tx *bolt.Tx) error {
		b, err := tx.CreateBucketIfNotExists([]byte("recovery_records"))
		if err != nil {
			return err
		}
		encoded, err := json.Marshal(recoveryLocalRecord{Grant: g})
		if err != nil {
			return err
		}
		if old := b.Get([]byte(g.ID)); old != nil && string(old) != string(encoded) {
			return errors.New("same recovery identity changed its commitment or scope")
		}
		return b.Put([]byte(g.ID), encoded)
	})
}

func recoveryReadJournal(path, id string) (recoveryGrant, error) {
	var record recoveryGrant
	if _, err := os.Stat(path); err != nil {
		return record, err
	}
	db, err := bolt.Open(path, 0600, &bolt.Options{ReadOnly: true, Timeout: 400 * time.Millisecond})
	if err != nil {
		return record, err
	}
	defer db.Close()
	err = db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("recovery_records"))
		if b == nil || b.Get([]byte(id)) == nil {
			return sql.ErrNoRows
		}
		var local recoveryLocalRecord
		if err := json.Unmarshal(b.Get([]byte(id)), &local); err != nil {
			return err
		}
		record = local.Grant
		return nil
	})
	return record, err
}

// SQL row locking and bbolt CAS deliberately favor consumption over replay:
// if either commit fails or its acknowledgement is lost, this execution is
// not re-authorized. No distributed transaction is claimed between these stores.
func recoveryClaim(ctx context.Context, r *recoveryFixture, g recoveryGrant) error {
	tx, err := r.f.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var registered recoveryGrant
	var state string
	err = tx.QueryRowContext(ctx, "SELECT id,commitment,scope_id,incarnation,api_boot,connector_boot,target_epoch,state FROM "+r.f.table("authority")+" WHERE id=? FOR UPDATE", g.ID).Scan(&registered.ID, &registered.Commitment, &registered.Scope, &registered.Incarnation, &registered.APIBoot, &registered.ConnectorBoot, &registered.TargetEpoch, &state)
	if err != nil {
		return err
	}
	if registered != g || state != "registered" {
		return errRecoveryConsumed
	}
	if _, err = os.Stat(r.localPath); err != nil {
		return err
	}
	db, err := journalOpen(r.localPath)
	if err != nil {
		return err
	}
	err = db.Update(func(localTx *bolt.Tx) error {
		b := localTx.Bucket([]byte("recovery_records"))
		if b == nil || b.Get([]byte(g.ID)) == nil {
			return errRecoveryConsumed
		}
		var local recoveryLocalRecord
		if json.Unmarshal(b.Get([]byte(g.ID)), &local) != nil || local.Grant != g || local.Attempted {
			return errRecoveryConsumed
		}
		local.Attempted = true
		encoded, err := json.Marshal(local)
		if err != nil {
			return err
		}
		return b.Put([]byte(g.ID), encoded)
	})
	closeErr := db.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if _, err = tx.ExecContext(ctx, "UPDATE "+r.f.table("authority")+" SET state='attempt_started' WHERE id=?", g.ID); err != nil {
		return err
	}
	return tx.Commit()
}

func recoveryBegin(ctx context.Context, db *sql.DB, schema, control string, g recoveryGrant) (*sql.Tx, error) {
	tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	commitment, err := hex.DecodeString(g.Commitment)
	if err == nil {
		_, err = tx.ExecContext(ctx, "CALL "+mysqlIdent(control)+".put_receipt(?,?,?)", g.ID, commitment, g.TargetEpoch)
	}
	if err == nil {
		_, err = tx.ExecContext(ctx, "UPDATE "+mysqlIdent(schema)+".business SET value=value+1 WHERE id=1")
	}
	if err != nil {
		tx.Rollback()
		return nil, err
	}
	return tx, nil
}

// Fresh runtime identities are never reconstructed from the database, journal,
// UTC timestamp or backup. Querying a prior grant does not call this function.
func recoveryAttempt(ctx context.Context, r *recoveryFixture, g recoveryGrant, apiBoot, connectorBoot string) error {
	if apiBoot == "" || connectorBoot == "" || g.APIBoot != apiBoot || g.ConnectorBoot != connectorBoot {
		return errRecoveryOldProcess
	}
	if g.Scope != r.scope || g.Incarnation != r.incarnation {
		return errors.New("recovery grant scope or target incarnation mismatch")
	}
	if err := recoveryClaim(ctx, r, g); err != nil {
		return err
	}
	tx, err := recoveryBegin(ctx, r.writer, r.f.schema, r.f.hidden, g)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	return tx.Commit()
}

func recoveryReceipt(ctx context.Context, r *recoveryFixture, g recoveryGrant) (string, error) {
	if g.Scope != r.scope || g.Incarnation != r.incarnation {
		return "unknown_frozen", errors.New("receipt query outside current trusted target scope")
	}
	var commitment, scope, incarnation, epoch string
	err := r.writer.QueryRowContext(ctx, "CALL "+mysqlIdent(r.f.hidden)+".get_receipt(?)", g.ID).Scan(&commitment, &scope, &incarnation, &epoch)
	if errors.Is(err, sql.ErrNoRows) {
		return "unknown_frozen", nil
	}
	if err != nil {
		return "unknown_frozen", err
	}
	if !strings.EqualFold(commitment, g.Commitment) || scope != g.Scope || incarnation != g.Incarnation || epoch != g.TargetEpoch {
		return "unknown_frozen", errors.New("target receipt does not match immutable execution metadata")
	}
	return "committed", nil
}

func TestRecoveryTargetReceiptAtomicityAndLeastPrivilege(t *testing.T) {
	r := newRecoveryFixture(t)
	g := r.grant(t)
	r.register(t, g)
	if err := recoveryJournal(r.localPath, g); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	tx, err := recoveryBegin(ctx, r.writer, r.f.schema, r.f.hidden, g)
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if mysqlCount(t, r.f.db, "SELECT value FROM "+r.f.table("business")) != 0 || mysqlCount(t, r.f.db, "SELECT COUNT(*) FROM "+r.f.hiddenTable("receipts")) != 0 {
		t.Fatal("receipt helper escaped the caller's rollback")
	}
	if err = recoveryAttempt(ctx, r, g, g.APIBoot, g.ConnectorBoot); err != nil {
		t.Fatal(err)
	}
	if state, err := recoveryReceipt(ctx, r, g); err != nil || state != "committed" {
		t.Fatalf("atomic target receipt not recoverable: %s %v", state, err)
	}
	// The lookup ID need not come from the old browser or restored journal.
	// Scope is fixed by the installed helper and current connector enrollment.
	var found recoveryGrant
	if err = r.writer.QueryRowContext(ctx, "CALL "+mysqlIdent(r.f.hidden)+".list_receipts(?)", "").Scan(&found.ID, &found.Commitment, &found.Scope, &found.Incarnation, &found.TargetEpoch); err != nil || found.ID != g.ID || !strings.EqualFold(found.Commitment, g.Commitment) || found.Scope != r.scope || found.Incarnation != r.incarnation || found.TargetEpoch != g.TargetEpoch {
		t.Fatal("scoped target discovery did not recover the original execution identity")
	}
	if err = recoveryAttempt(ctx, r, g, g.APIBoot, g.ConnectorBoot); err == nil {
		t.Fatal("a duplicate execution passed target receipt uniqueness")
	}
	if duplicate, err := recoveryBegin(ctx, r.writer, r.f.schema, r.f.hidden, g); err == nil {
		duplicate.Rollback()
		t.Fatal("direct target duplicate bypassed immutable receipt primary key")
	}
	changed := g
	changed.Commitment = recoveryRandom(t, 32)
	if state, err := recoveryReceipt(ctx, r, changed); err == nil || state != "unknown_frozen" {
		t.Fatal("same ID with changed commitment acquired a commit result")
	}
	if err = recoveryAttempt(ctx, r, changed, g.APIBoot, g.ConnectorBoot); err == nil {
		t.Fatal("same ID with changed commitment was executed")
	}
	unregistered := r.grant(t)
	if err = recoveryAttempt(ctx, r, unregistered, unregistered.APIBoot, unregistered.ConnectorBoot); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("a current-process unregistered execution passed the authority boundary")
	}
	changed = g
	changed.Scope = "other-scope"
	if err = recoveryAttempt(ctx, r, changed, g.APIBoot, g.ConnectorBoot); err == nil {
		t.Fatal("a different scope acquired execution")
	}
	for name, statement := range map[string]string{
		"direct-receipt-read":   "SELECT * FROM " + r.f.hiddenTable("receipts"),
		"delete-old-receipt":    "DELETE FROM " + r.f.hiddenTable("receipts"),
		"modify-old-receipt":    "UPDATE " + r.f.hiddenTable("receipts") + " SET commitment=REPEAT('x',32)",
		"arbitrary-receipt":     "INSERT INTO " + r.f.hiddenTable("receipts") + " VALUES ('evil',REPEAT('x',32),'other','other')",
		"alter-business":        "ALTER TABLE " + r.f.table("business") + " ADD COLUMN forbidden INT",
		"replace-helper":        "DROP PROCEDURE " + mysqlIdent(r.f.hidden) + ".put_receipt",
		"caller-selected-scope": "CALL " + mysqlIdent(r.f.hidden) + ".put_receipt('bad',REPEAT('x',32),'other-scope')",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := r.writer.ExecContext(ctx, statement); err == nil {
				t.Fatal("restricted recovery runtime executed forbidden operation")
			}
		})
	}
	if mysqlCount(t, r.f.db, "SELECT value FROM "+r.f.table("business")) != 1 || mysqlCount(t, r.f.db, "SELECT COUNT(*) FROM "+r.f.hiddenTable("receipts")) != 1 {
		t.Fatal("duplicate or forbidden operation changed business rows/receipt")
	}
	t.Log("restricted writer committed DML and a metadata-only receipt together; rollback removed both; immutable ID rejected retries and changed commitment")
}

type recoveryChildConfig struct {
	Schema, Control, User, Secret, JournalPath string
	Grant                                      recoveryGrant
}

func recoveryChild(t *testing.T, mode string) {
	t.Helper()
	path, child := journalHelperArgs(mode)
	if !child {
		t.Fatal("recovery helper was not explicitly selected")
	}
	data, err := os.ReadFile(path)
	var cfg recoveryChildConfig
	if err != nil || json.Unmarshal(data, &cfg) != nil || !regexp.MustCompile(`^stage8_g2_[0-9a-f]{12}$`).MatchString(cfg.Schema) || !regexp.MustCompile(`^stage8_g2_hidden_[0-9a-f]{12}$`).MatchString(cfg.Control) || !regexp.MustCompile(`^s8g2_[0-9a-f]{12}_rcwriter$`).MatchString(cfg.User) || !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(cfg.Secret) || filepath.Dir(cfg.JournalPath) != filepath.Dir(path) {
		t.Fatal("invalid disposable recovery helper input")
	}
	m, err := lab.Load(os.Getenv("STAGE8_G2_MANIFEST"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := lab.OpenAccount(m, cfg.User, cfg.Secret, false)
	if err != nil {
		t.Fatal(err)
	}
	// The current boot identity originates in this child's memory. It is not
	// reconstructed from the task, persisted journal or the parent's config.
	bootBytes := make([]byte, 16)
	if _, err = rand.Read(bootBytes); err != nil {
		t.Fatal(err)
	}
	currentBoot := hex.EncodeToString(bootBytes)
	fmt.Println("g2-recovery-ready:" + currentBoot)
	input := bufio.NewReader(os.Stdin)
	line, err := input.ReadString('\n')
	var approved recoveryGrant
	if err != nil || json.Unmarshal([]byte(line), &approved) != nil {
		t.Fatal("fresh child did not receive an issued grant")
	}
	expected := cfg.Grant
	expected.ConnectorBoot = currentBoot
	if approved != expected {
		t.Fatal("grant did not bind the fresh in-memory child boot")
	}
	cfg.Grant = approved
	if err = recoveryJournal(cfg.JournalPath, cfg.Grant); err != nil {
		t.Fatal(err)
	}
	fmt.Println("g2-recovery-journal-ready")
	line, err = input.ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "claim-committed" {
		t.Fatal("platform/local attempt claim was not acknowledged")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := recoveryBegin(ctx, db, cfg.Schema, cfg.Control, cfg.Grant)
	if err != nil {
		t.Fatal(err)
	}
	if mode == "recovery-before-target-commit" {
		fmt.Println("g2-recovery-synced-intent-uncommitted-target")
		os.Exit(31)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	// Deliberately lose the acknowledgement to the parent/platform and do not
	// record a local terminal state, after the target transaction committed.
	fmt.Println("g2-recovery-target-committed-acknowledgement-lost")
	os.Exit(32)
}

func TestRecoveryAbruptChildBeforeCommitAndLostAcknowledgement(t *testing.T) {
	for _, mode := range []string{"recovery-before-target-commit", "recovery-after-target-commit"} {
		if _, child := journalHelperArgs(mode); child {
			recoveryChild(t, mode)
			return
		}
	}
	for _, mode := range []string{"recovery-before-target-commit", "recovery-after-target-commit"} {
		t.Run(mode, func(t *testing.T) {
			r := newRecoveryFixture(t)
			g := r.grant(t)
			g.ConnectorBoot = ""
			configPath := filepath.Join(filepath.Dir(r.localPath), "owned-child.json")
			data, err := json.Marshal(recoveryChildConfig{r.f.schema, r.f.hidden, r.user, r.secret, r.localPath, g})
			if err != nil || os.WriteFile(configPath, data, 0600) != nil {
				t.Fatal("cannot prepare private disposable child configuration")
			}
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			childCtx, childCancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer childCancel()
			cmd := exec.CommandContext(childCtx, executable, "-test.run=^TestRecoveryAbruptChildBeforeCommitAndLostAcknowledgement$", "--", "--g2-disposable-journal="+mode, configPath)
			journalHideChildWindow(cmd)
			stdout, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			stdin, err := cmd.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err = cmd.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() {
				stdin.Close()
				if cmd.ProcessState == nil {
					cmd.Process.Kill()
					cmd.Wait()
				}
			}()
			reader := bufio.NewReader(stdout)
			line, err := reader.ReadString('\n')
			freshBoot := strings.TrimSpace(strings.TrimPrefix(line, "g2-recovery-ready:"))
			if err != nil || !strings.HasPrefix(line, "g2-recovery-ready:") || !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(freshBoot) {
				t.Fatalf("child did not announce a fresh runtime boot: %v", err)
			}
			g.ConnectorBoot = freshBoot
			r.register(t, g)
			approval, _ := json.Marshal(g)
			if _, err = fmt.Fprintln(stdin, string(approval)); err != nil {
				t.Fatal(err)
			}
			line, err = reader.ReadString('\n')
			if err != nil || strings.TrimSpace(line) != "g2-recovery-journal-ready" {
				t.Fatal("child did not persist a local intent")
			}
			if err = recoveryClaim(childCtx, r, g); err != nil {
				t.Fatal(err)
			}
			if _, err = fmt.Fprintln(stdin, "claim-committed"); err != nil {
				t.Fatal(err)
			}
			output, readErr := io.ReadAll(reader)
			if readErr != nil {
				t.Fatal(readErr)
			}
			err = cmd.Wait()
			var exit *exec.ExitError
			expectedCode, expectedState, expectedValue := 31, "unknown_frozen", 0
			if mode == "recovery-after-target-commit" {
				expectedCode, expectedState, expectedValue = 32, "committed", 1
			}
			if !errors.As(err, &exit) || exit.ExitCode() != expectedCode {
				t.Fatalf("owned helper did not exit at its selected boundary: %v %s", err, output)
			}
			local, err := recoveryReadJournal(r.localPath, g.ID)
			if err != nil || local != g {
				t.Fatal("synchronized local intent did not survive owned child exit")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			state, err := recoveryReceipt(ctx, r, g)
			if err != nil || state != expectedState {
				t.Fatalf("wrong recovery outcome %s: %v", state, err)
			}
			if err = recoveryAttempt(ctx, r, g, recoveryRandom(t, 16), recoveryRandom(t, 16)); !errors.Is(err, errRecoveryOldProcess) {
				t.Fatal("process recovery made an old task executable")
			}
			if mysqlCount(t, r.f.db, "SELECT value FROM "+r.f.table("business")) != expectedValue {
				t.Fatal("recovery retried or lost the business effect")
			}
			if mysqlCount(t, r.f.db, "SELECT COUNT(*) FROM "+r.f.table("authority")+" WHERE state='attempt_started'") != 1 {
				t.Fatal("child unexpectedly delivered a platform terminal acknowledgement")
			}
			t.Logf("real child exit %d: journal intent and platform registration survived; target effect=%d; recovery=%s; no replay", expectedCode, expectedValue, expectedState)
		})
	}
}

func TestRecoveryRestoredCoordinatorsDoNotReplayAndTargetProvesCommit(t *testing.T) {
	r := newRecoveryFixture(t)
	g := r.grant(t)
	// Real SQL and bbolt snapshots before the subsequent target transaction.
	r.f.exec(t, "CREATE TABLE "+r.f.table("authority_backup")+" LIKE "+r.f.table("authority"))
	db, err := journalOpen(r.localPath)
	if err != nil {
		t.Fatal(err)
	}
	oldPath := filepath.Join(filepath.Dir(r.localPath), "old-valid.db")
	if err = db.View(func(tx *bolt.Tx) error { return tx.CopyFile(oldPath, 0600) }); err != nil {
		t.Fatal(err)
	}
	db.Close()
	r.register(t, g)
	if err = recoveryJournal(r.localPath, g); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	if err = recoveryAttempt(ctx, r, g, g.APIBoot, g.ConnectorBoot); err != nil {
		t.Fatal(err)
	}
	r.f.exec(t, "DELETE FROM "+r.f.table("authority"))
	r.f.exec(t, "INSERT INTO "+r.f.table("authority")+" SELECT * FROM "+r.f.table("authority_backup"))
	r.localPath = oldPath
	if mysqlCount(t, r.f.db, "SELECT COUNT(*) FROM "+r.f.table("authority")) != 0 {
		t.Fatal("platform snapshot was not restored to before registration")
	}
	if _, err = recoveryReadJournal(oldPath, g.ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("old valid journal unexpectedly retained the execution")
	}
	var discovered recoveryGrant
	if err = r.writer.QueryRowContext(ctx, "CALL "+mysqlIdent(r.f.hidden)+".list_receipts(?)", "").Scan(&discovered.ID, &discovered.Commitment, &discovered.Scope, &discovered.Incarnation, &discovered.TargetEpoch); err != nil || discovered.ID != g.ID || !strings.EqualFold(discovered.Commitment, g.Commitment) || discovered.Scope != r.scope || discovered.Incarnation != r.incarnation {
		t.Fatal("both coordinator snapshots lost the ID, but scoped target discovery did not find it")
	}
	for _, pair := range [][2]string{{recoveryRandom(t, 16), g.ConnectorBoot}, {g.APIBoot, recoveryRandom(t, 16)}, {recoveryRandom(t, 16), recoveryRandom(t, 16)}} {
		if err = recoveryAttempt(ctx, r, g, pair[0], pair[1]); !errors.Is(err, errRecoveryOldProcess) {
			t.Fatal("one or both restored coordinator processes accepted a previous-process grant")
		}
	}
	if state, err := recoveryReceipt(ctx, r, g); err != nil || state != "committed" {
		t.Fatalf("independent atomic target receipt did not prove original commit: %s %v", state, err)
	}
	if mysqlCount(t, r.f.db, "SELECT value FROM "+r.f.table("business")) != 1 {
		t.Fatal("restoring both coordinators replayed an original execution")
	}
	t.Log("real SQL and bbolt pre-execution backups both lost registration/tombstone; fresh API or Connector boot rejected old grants; atomic target receipt still proved commit")
}

func TestRecoveryMissingOrTamperedEvidenceNeverGrantsRetry(t *testing.T) {
	r := newRecoveryFixture(t)
	g := r.grant(t)
	r.register(t, g)
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	// Registration committed, but a crash occurred before any local marker.
	if state, err := recoveryReceipt(ctx, r, g); err != nil || state != "unknown_frozen" {
		t.Fatal("absent receipt was treated as proof of rollback or retry permission")
	}
	if err := recoveryAttempt(ctx, r, g, g.APIBoot, g.ConnectorBoot); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("registered task with a missing journal acquired execution")
	}
	if err := recoveryJournal(r.localPath, g); err != nil {
		t.Fatal(err)
	}
	changed := g
	changed.Commitment = recoveryRandom(t, 32)
	if err := recoveryJournal(r.localPath, changed); err == nil {
		t.Fatal("normal local CAS permitted same-ID metadata mutation")
	}
	// Reproducible same-record-count tampering of this disposable local fixture.
	db, err := journalOpen(r.localPath)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Update(func(tx *bolt.Tx) error {
		encoded, err := json.Marshal(recoveryLocalRecord{Grant: changed})
		if err != nil {
			return err
		}
		return tx.Bucket([]byte("recovery_records")).Put([]byte(g.ID), encoded)
	}); err != nil {
		t.Fatal(err)
	}
	db.Close()
	local, err := recoveryReadJournal(r.localPath, g.ID)
	if err != nil || local == g || local.ID != g.ID {
		t.Fatal("same-record-count tampering setup failed")
	}
	// The original current-process grant must also fail. Fresh runtime nonces
	// alone do not detect same-count corruption of a live journal.
	if err = recoveryAttempt(ctx, r, g, g.APIBoot, g.ConnectorBoot); !errors.Is(err, errRecoveryConsumed) {
		t.Fatal("same-count live local tampering acquired execution")
	}
	if err = recoveryAttempt(ctx, r, local, local.APIBoot, local.ConnectorBoot); !errors.Is(err, errRecoveryConsumed) {
		t.Fatal("local metadata became its own platform authority")
	}
	r.f.exec(t, "UPDATE "+r.f.table("authority")+" SET scope_id='wrong-scope' WHERE id=?", g.ID)
	if err = recoveryAttempt(ctx, r, g, g.APIBoot, g.ConnectorBoot); !errors.Is(err, errRecoveryConsumed) {
		t.Fatal("same-count platform tampering acquired execution")
	}
	closed, err := lab.OpenAccount(mustRecoveryManifest(t), r.user, r.secret, false)
	if err != nil {
		t.Fatal(err)
	}
	closed.Close()
	original := r.writer
	r.writer = closed
	state, err := recoveryReceipt(ctx, r, g)
	r.writer = original
	if err == nil || state != "unknown_frozen" {
		t.Fatal("unavailable target authority granted a determinate outcome")
	}
	if mysqlCount(t, r.f.db, "SELECT value FROM "+r.f.table("business")) != 0 {
		t.Fatal("metadata recovery dispatched business DML")
	}
	t.Log("missing local journal/receipt, same-count immutable-field tampering and unavailable target remain query-only and frozen")
}

func mustRecoveryManifest(t *testing.T) lab.Manifest {
	t.Helper()
	m, err := lab.Load(os.Getenv("STAGE8_G2_MANIFEST"))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestRecoveryConcurrentCrossStoreClaimExecutesOnce(t *testing.T) {
	r := newRecoveryFixture(t)
	g := r.grant(t)
	r.register(t, g)
	if err := recoveryJournal(r.localPath, g); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	const contenders = 16
	var wg sync.WaitGroup
	var won atomic.Int32
	start := make(chan struct{})
	failures := make(chan error, contenders)
	for i := 0; i < contenders; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			err := recoveryAttempt(ctx, r, g, g.APIBoot, g.ConnectorBoot)
			if err == nil {
				won.Add(1)
			} else if !errors.Is(err, errRecoveryConsumed) {
				failures <- err
			}
		}()
	}
	close(start)
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
	if won.Load() != 1 || mysqlCount(t, r.f.db, "SELECT value FROM "+r.f.table("business")) != 1 || mysqlCount(t, r.f.db, "SELECT COUNT(*) FROM "+r.f.hiddenTable("receipts")) != 1 {
		t.Fatal("cross-store claim did not constrain concurrent execution to one effect")
	}
	t.Log("16 current-process duplicate claims: one MySQL+bbolt reservation, one business increment, one target receipt")
}

func TestRecoveryPartialCrossStoreClaimNeverReauthorizes(t *testing.T) {
	r := newRecoveryFixture(t)
	g := r.grant(t)
	r.register(t, g)
	if err := recoveryJournal(r.localPath, g); err != nil {
		t.Fatal(err)
	}
	r.f.exec(t, "CREATE TRIGGER "+mysqlIdent(r.f.schema)+".reject_claim BEFORE UPDATE ON "+r.f.table("authority")+" FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected platform claim failure'")
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	if err := recoveryAttempt(ctx, r, g, g.APIBoot, g.ConnectorBoot); err == nil {
		t.Fatal("injected platform commit failure did not stop execution")
	}
	if mysqlCount(t, r.f.db, "SELECT COUNT(*) FROM "+r.f.table("authority")+" WHERE state='registered'") != 1 {
		t.Fatal("failed platform transaction did not roll back")
	}
	r.f.exec(t, "DROP TRIGGER "+mysqlIdent(r.f.schema)+".reject_claim")
	if err := recoveryAttempt(ctx, r, g, g.APIBoot, g.ConnectorBoot); !errors.Is(err, errRecoveryConsumed) {
		t.Fatal("SQL rollback caused an already consumed local attempt to be authorized again")
	}
	if mysqlCount(t, r.f.db, "SELECT value FROM "+r.f.table("business")) != 0 || mysqlCount(t, r.f.db, "SELECT COUNT(*) FROM "+r.f.hiddenTable("receipts")) != 0 {
		t.Fatal("partial cross-store failure dispatched target DML")
	}
	t.Log("local synchronized CAS survived an injected SQL claim rollback; the original attempt stayed consumed and target business/receipt remained unchanged")
}

func TestRecoveryTargetBarrierDrainsOldTransactionsAndFencesAliases(t *testing.T) {
	r := newRecoveryFixture(t)
	g := r.grant(t)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	old, err := recoveryBegin(ctx, r.writer, r.f.schema, r.f.hidden, g)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Rollback()
	barrier := r.f.account(t, "rcbarrier", "EXECUTE", "PROCEDURE "+mysqlIdent(r.f.hidden)+".rotate_gate", false)
	barrier.SetMaxOpenConns(1)
	if _, err = barrier.ExecContext(ctx, "SET SESSION innodb_lock_wait_timeout=1"); err != nil {
		t.Fatal(err)
	}
	next := recoveryRandom(t, 16)
	blocked, err := barrier.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	_, err = blocked.ExecContext(ctx, "CALL "+mysqlIdent(r.f.hidden)+".rotate_gate(?,?)", r.targetEpoch, next)
	requireMySQLError(t, err, 1205)
	blocked.Rollback()
	if err = old.Commit(); err != nil {
		t.Fatal(err)
	}
	rotation, err := barrier.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	defer rotation.Rollback()
	if _, err = rotation.ExecContext(ctx, "CALL "+mysqlIdent(r.f.hidden)+".rotate_gate(?,?)", r.targetEpoch, next); err != nil {
		t.Fatal(err)
	}
	if err = rotation.Commit(); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]any{{nil, recoveryRandom(t, 16)}, {next, nil}, {nil, nil}, {"wrong", recoveryRandom(t, 16)}, {next, next}} {
		_, err = barrier.ExecContext(ctx, "CALL "+mysqlIdent(r.f.hidden)+".rotate_gate(?,?)", args...)
		requireMySQLError(t, err, 1644)
	}
	for _, args := range [][]any{{nil, make([]byte, 32), next}, {"exec-" + recoveryRandom(t, 16), nil, next}, {"exec-" + recoveryRandom(t, 16), make([]byte, 32), nil}} {
		_, err = r.writer.ExecContext(ctx, "CALL "+mysqlIdent(r.f.hidden)+".put_receipt(?,?,?)", args...)
		requireMySQLError(t, err, 1644)
	}
	alias := r.f.account(t, "rcalias", "SELECT,UPDATE", r.f.table("business"), false)
	aliasUser := "s8g2_" + r.f.suffix + "_rcalias"
	for _, helper := range []string{"put_receipt", "get_receipt", "list_receipts"} {
		r.f.exec(t, "GRANT EXECUTE ON PROCEDURE "+mysqlIdent(r.f.hidden)+"."+mysqlIdent(helper)+" TO '"+aliasUser+"'@'127.0.0.1'")
	}
	for _, writer := range []*sql.DB{r.writer, alias} {
		late := g
		late.ID = "exec-" + recoveryRandom(t, 16)
		if tx, err := recoveryBegin(ctx, writer, r.f.schema, r.f.hidden, late); err == nil {
			tx.Rollback()
			t.Fatal("an old target epoch passed an equivalent source alias after the drain barrier")
		}
		if _, err := writer.ExecContext(ctx, "CALL "+mysqlIdent(r.f.hidden)+".rotate_gate(?,?)", next, recoveryRandom(t, 16)); err == nil {
			t.Fatal("ordinary writer acquired recovery-barrier privilege")
		}
	}
	if state, err := recoveryReceipt(ctx, r, g); err != nil || state != "committed" {
		t.Fatal("barrier erased an old target receipt")
	}
	// Discover AFTER the exclusive barrier has committed. Enumerating first
	// could omit the old transaction that committed while rotation was waiting.
	var afterDrain recoveryGrant
	if err := r.writer.QueryRowContext(ctx, "CALL "+mysqlIdent(r.f.hidden)+".list_receipts(?)", "").Scan(
		&afterDrain.ID, &afterDrain.Commitment, &afterDrain.Scope, &afterDrain.Incarnation, &afterDrain.TargetEpoch,
	); err != nil || afterDrain.ID != g.ID || !strings.EqualFold(afterDrain.Commitment, g.Commitment) ||
		afterDrain.Scope != r.scope || afterDrain.Incarnation != r.incarnation || afterDrain.TargetEpoch != g.TargetEpoch {
		t.Fatal("post-drain discovery omitted the old transaction's final commit")
	}
	r.targetEpoch = next
	fresh := r.grant(t)
	r.register(t, fresh)
	if err = recoveryJournal(r.localPath, fresh); err != nil {
		t.Fatal(err)
	}
	if err = recoveryAttempt(ctx, r, fresh, fresh.APIBoot, fresh.ConnectorBoot); err != nil {
		t.Fatal(err)
	}
	if mysqlCount(t, r.f.db, "SELECT value FROM "+r.f.table("business")) != 2 || mysqlCount(t, r.f.db, "SELECT COUNT(*) FROM "+r.f.hiddenTable("receipts")) != 2 {
		t.Fatal("old epoch aliases added a business effect or new epoch did not execute")
	}
	for _, statement := range []string{"SELECT * FROM " + r.f.hiddenTable("gate"), "UPDATE " + r.f.table("business") + " SET value=99"} {
		if _, err = barrier.ExecContext(ctx, statement); err == nil {
			t.Fatal("barrier identity acquired direct data privileges")
		}
	}
	t.Log("old target transaction held shared gate; exclusive rotation timed out until it completed; two different writer accounts rejected old epoch; fresh registered grant executed and old receipt remained")
}

func TestRecoveryReceiptDiscoveryBoundedAndScoped(t *testing.T) {
	r := newRecoveryFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	for i := 0; i < 101; i++ {
		g := r.grant(t)
		tx, err := recoveryBegin(ctx, r.writer, r.f.schema, r.f.hidden, g)
		if err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	r.f.exec(t, "INSERT INTO "+r.f.hiddenTable("receipts")+" VALUES (?,REPEAT('x',32),'other-scope',?,?)", "exec-"+recoveryRandom(t, 16), r.incarnation, r.targetEpoch)
	cursor := ""
	total := 0
	seen := map[string]bool{}
	for page := 0; page < 3; page++ {
		rows, err := r.writer.QueryContext(ctx, "CALL "+mysqlIdent(r.f.hidden)+".list_receipts(?)", cursor)
		if err != nil {
			t.Fatal(err)
		}
		count := 0
		for rows.Next() {
			var found recoveryGrant
			if err = rows.Scan(&found.ID, &found.Commitment, &found.Scope, &found.Incarnation, &found.TargetEpoch); err != nil {
				t.Fatal(err)
			}
			if found.Scope != r.scope || found.Incarnation != r.incarnation || found.ID <= cursor || seen[found.ID] {
				t.Fatal("receipt pagination crossed scope or repeated a record")
			}
			cursor = found.ID
			seen[found.ID] = true
			count++
		}
		if err = rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
		if count > 100 || (page == 0 && count != 100) || (page == 1 && count != 1) || (page == 2 && count != 0) {
			t.Fatal("fixed receipt cursor did not enforce 100/1/0 bounded pages")
		}
		total += count
	}
	if total != 101 {
		t.Fatal("receipt discovery lost committed execution identities")
	}
	t.Log("fixed target scope discovered 101 committed IDs in pages 100/1/0 and excluded a receipt from another scope")
}
