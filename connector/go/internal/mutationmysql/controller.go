package mutationmysql

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"strconv"
	"strings"
	"time"

	"example.com/ai-database-workspace/connector/internal/mutationconfig"
	"example.com/ai-database-workspace/connector/internal/mutationguard"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	mysql "github.com/go-sql-driver/mysql"
)

var ErrTarget = errors.New("mutation target verification failed")

type Controller struct {
	profile          mutationconfig.Target
	manifest         Manifest
	writer, recovery *sql.DB
}

func openCredential(c mutationconfig.Credential) (*sql.DB, error) {
	if c.Validate() != nil {
		return nil, ErrTarget
	}
	cfg := mysql.NewConfig()
	cfg.User, cfg.Passwd = c.Username, c.Password
	cfg.Net, cfg.Addr, cfg.DBName = "tcp", net.JoinHostPort(c.Host, strconv.Itoa(c.Port)), c.Database
	cfg.Timeout, cfg.ReadTimeout, cfg.WriteTimeout = 3*time.Second, 15*time.Second, 5*time.Second
	cfg.MultiStatements, cfg.InterpolateParams = false, false
	cfg.ClientFoundRows = false
	if c.TLS == "required" {
		cfg.TLSConfig = "true"
	} else {
		cfg.TLSConfig = "false"
	}
	connector, err := mysql.NewConnector(cfg)
	if err != nil {
		return nil, ErrTarget
	}
	db := sql.OpenDB(connector)
	db.SetMaxOpenConns(2)
	db.SetMaxIdleConns(0)
	return db, nil
}
func New(profile mutationconfig.Target, manifest Manifest) (*Controller, error) {
	writer, err := openCredential(profile.Writer)
	if err != nil {
		return nil, err
	}
	recovery, err := openCredential(profile.Recovery)
	if err != nil {
		writer.Close()
		return nil, err
	}
	c, err := NewWithDatabases(profile, manifest, writer, recovery)
	if err != nil {
		writer.Close()
		recovery.Close()
	}
	return c, err
}

// NewWithDatabases supports a guarded isolated pool in tests. Injected pools do
// not bypass any account, server, installation, scope or transaction checks.
func NewWithDatabases(profile mutationconfig.Target, m Manifest, writer, recovery *sql.DB) (*Controller, error) {
	if profile.Validate() != nil || m.Validate() != nil || writer == nil || recovery == nil || profile.Writer.Database != m.Spec.Catalog || profile.Writer.Username != m.Spec.Writer.User || profile.Recovery.Username != m.Spec.Recovery.User {
		return nil, ErrInstallation
	}
	// Public callers cannot mutate an accepted policy/installation underneath
	// an in-flight transaction by retaining a slice or map reference.
	raw, _ := json.Marshal(m)
	var pinned Manifest
	if json.Unmarshal(raw, &pinned) != nil {
		return nil, ErrInstallation
	}
	profile.WorkspaceIDs = append([]string(nil), profile.WorkspaceIDs...)
	return &Controller{profile: profile, manifest: pinned, writer: writer, recovery: recovery}, nil
}
func (c *Controller) Close() error {
	err := c.writer.Close()
	if next := c.recovery.Close(); err == nil {
		err = next
	}
	return err
}
func (c *Controller) Manifest() Manifest {
	raw, _ := json.Marshal(c.manifest)
	var copy Manifest
	_ = json.Unmarshal(raw, &copy)
	return copy
}
func (c *Controller) allowed(scope mutationrunner.Scope) bool {
	return scope.OwnerID != "" && c.profile.Allows(scope.ConnectorID, scope.WorkspaceID, scope.SourceID)
}
func (c *Controller) Begin(ctx context.Context, b mutationrunner.Binding) (mutationrunner.Transaction, error) {
	if !c.allowed(b.Scope) || b.TargetIdentity != c.manifest.TargetIdentity() || b.InstallationGeneration != c.manifest.Spec.Generation || !hex64.MatchString(b.TargetEpoch) || !hex64.MatchString(b.APIBoot) || !hex64.MatchString(b.ConnectorBoot) || b.PolicyGeneration == "" {
		return nil, mutationrunner.ErrDenied
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	conn, err := c.writer.Conn(ctx)
	if err != nil {
		cancel()
		return nil, ErrTarget
	}
	if err = c.verifyConnection(ctx, conn, false); err != nil {
		conn.Close()
		cancel()
		return nil, err
	}
	// These fixed adapter settings are never sourced from a plan or a model.
	for _, statement := range []string{"SET SESSION innodb_lock_wait_timeout=3", "SET SESSION lock_wait_timeout=3", "SET SESSION time_zone='+00:00'"} {
		if _, err = conn.ExecContext(ctx, statement); err != nil {
			conn.Close()
			cancel()
			return nil, ErrTarget
		}
	}
	tx, err := conn.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		conn.Close()
		cancel()
		return nil, ErrTarget
	}
	t := &transaction{controller: c, conn: conn, tx: tx, binding: b, cancel: cancel}
	// Use the trusted read-only inspector to pin control templates under MDL
	// before invoking the gate helper. The inspector itself relies on the
	// reviewed offline installation and DBA maintenance boundary.
	if err = c.verifyControl(ctx, tx); err != nil {
		t.Rollback()
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, "CALL "+qualified(c.manifest.ControlCatalog, "lock_gate")+"(?)", b.TargetEpoch); err != nil {
		t.Rollback()
		return nil, ErrTarget
	}
	if err = c.verifyControl(ctx, tx); err != nil {
		t.Rollback()
		return nil, err
	}
	return t, nil
}

// Verify checks both fixed runtime identities without business DML or target
// row locks. It is a local configuration preflight, never write authorization.
func (c *Controller) Verify(ctx context.Context) error {
	for _, entry := range []struct {
		db       *sql.DB
		recovery bool
	}{{c.writer, false}, {c.recovery, true}} {
		conn, err := entry.db.Conn(ctx)
		if err != nil {
			return ErrTarget
		}
		if err = c.verifyConnection(ctx, conn, entry.recovery); err != nil {
			conn.Close()
			return err
		}
		tx, err := conn.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted, ReadOnly: true})
		if err != nil {
			conn.Close()
			return ErrTarget
		}
		err = c.verifyControl(ctx, tx)
		_ = tx.Rollback()
		conn.Close()
		if err != nil {
			return err
		}
	}
	return nil
}
func (c *Controller) ValidatePolicies(ctx context.Context, policies []mutationguard.Policy) error {
	if len(policies) == 0 || len(policies) > 32 {
		return mutationrunner.ErrDenied
	}
	conn, err := c.writer.Conn(ctx)
	if err != nil {
		return ErrTarget
	}
	defer conn.Close()
	if c.verifyConnection(ctx, conn, false) != nil {
		return ErrInstallation
	}
	tx, err := conn.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted, ReadOnly: true})
	if err != nil {
		return ErrTarget
	}
	defer tx.Rollback()
	if c.verifyControl(ctx, tx) != nil {
		return ErrInstallation
	}
	reader := &transaction{controller: c, conn: conn, tx: tx}
	for _, policy := range policies {
		metadata, err := reader.describe(ctx, policy.Table, false)
		if err != nil || mutationguard.ValidatePolicy(metadata, policy) != nil {
			return mutationrunner.ErrDenied
		}
	}
	return nil
}
func (c *Controller) verifyControl(ctx context.Context, q sqlQueryer) error {
	for _, name := range []string{"gate", "receipts"} {
		proof, err := c.inspect(ctx, q, c.manifest.ControlCatalog, name)
		if err != nil || validateControl(name, proof) != nil || proof.definition != c.manifest.ControlDefinitions[name] {
			return ErrInstallation
		}
	}
	return nil
}

type sqlQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func supportedMode(mode string) bool {
	want := []string{"ONLY_FULL_GROUP_BY", "STRICT_TRANS_TABLES", "NO_ZERO_IN_DATE", "NO_ZERO_DATE", "ERROR_FOR_DIVISION_BY_ZERO", "NO_ENGINE_SUBSTITUTION"}
	return sameStrings(strings.Split(mode, ","), want)
}
func (c *Controller) verifyConnection(ctx context.Context, q sqlQueryer, recovery bool) error {
	var id, version, mode, current, mandatory, roles string
	var lower, activate, flush int
	if err := q.QueryRowContext(ctx, "SELECT @@server_uuid,@@version,@@sql_mode,@@lower_case_table_names,CURRENT_USER(),@@global.mandatory_roles,@@global.activate_all_roles_on_login,CURRENT_ROLE(),@@innodb_flush_log_at_trx_commit").Scan(&id, &version, &mode, &lower, &current, &mandatory, &activate, &roles, &flush); err != nil || id != c.manifest.ServerUUID || version != c.manifest.ServerVersion || lower != 1 || !supportedMode(mode) || mandatory != "" || activate != 0 || roles != "NONE" || flush != 1 {
		return ErrInstallation
	}
	expectedAccount := c.manifest.Spec.Writer
	grants := c.manifest.WriterGrants
	if recovery {
		expectedAccount = c.manifest.Spec.Recovery
		grants = c.manifest.RecoveryGrants
	}
	if current != expectedAccount.User+"@"+expectedAccount.Host {
		return ErrInstallation
	}
	rows, err := q.QueryContext(ctx, "SHOW GRANTS FOR CURRENT_USER()")
	if err != nil {
		return ErrInstallation
	}
	defer rows.Close()
	var actual []string
	for rows.Next() {
		var value string
		if rows.Scan(&value) != nil || len(actual) > 128 {
			return ErrInstallation
		}
		actual = append(actual, value)
	}
	if rows.Err() != nil || !sameStrings(actual, grants) {
		return ErrInstallation
	}
	return nil
}
func scopeRaw(scope mutationrunner.Scope) []byte { raw, _ := json.Marshal(scope); return raw }
func (c *Controller) Receipt(ctx context.Context, scope mutationrunner.Scope, id string) (*mutationrunner.Receipt, error) {
	if !c.allowed(scope) || !uuid.MatchString(id) {
		return nil, mutationrunner.ErrDenied
	}
	conn, err := c.writer.Conn(ctx)
	if err != nil {
		return nil, ErrTarget
	}
	defer conn.Close()
	if c.verifyConnection(ctx, conn, false) != nil {
		return nil, ErrInstallation
	}
	tx, err := conn.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted, ReadOnly: true})
	if err != nil {
		return nil, ErrTarget
	}
	defer tx.Rollback()
	if c.verifyControl(ctx, tx) != nil {
		return nil, ErrInstallation
	}
	rows, err := tx.QueryContext(ctx, "CALL "+qualified(c.manifest.ControlCatalog, "get_receipt")+"(?,?)", id, scopeRaw(scope))
	if err != nil {
		return nil, ErrTarget
	}
	list, err := c.receiptRows(rows, scope)
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, nil
	}
	if len(list) != 1 || list[0].ExecutionID != id {
		return nil, ErrTarget
	}
	return &list[0], nil
}
func (c *Controller) receiptRows(rows *sql.Rows, scope mutationrunner.Scope) ([]mutationrunner.Receipt, error) {
	defer rows.Close()
	if columns(rows, []string{"execution_id", "commitment", "scope", "target_epoch", "row_count"}) != nil {
		return nil, ErrTarget
	}
	var list []mutationrunner.Receipt
	for rows.Next() {
		var r mutationrunner.Receipt
		var actualScope []byte
		if rows.Scan(&r.ExecutionID, &r.Commitment, &actualScope, &r.TargetEpoch, &r.RowCount) != nil || len(list) >= 100 || !uuid.MatchString(r.ExecutionID) || !hex64.MatchString(r.TargetEpoch) || r.RowCount < 1 || r.RowCount > 100 || strictJSON(actualScope, &r.Scope) != nil || r.Scope != scope {
			return nil, ErrTarget
		}
		commitment, err := hex.DecodeString(r.Commitment)
		if err != nil || len(commitment) != 32 {
			return nil, ErrTarget
		}
		r.Commitment = base64.RawURLEncoding.EncodeToString(commitment)
		r.TargetIdentity = c.manifest.TargetIdentity()
		list = append(list, r)
	}
	if rows.Err() != nil || rows.NextResultSet() {
		return nil, ErrTarget
	}
	return list, nil
}
func (c *Controller) ReadGate(ctx context.Context) (string, error) {
	conn, err := c.recovery.Conn(ctx)
	if err != nil {
		return "", ErrTarget
	}
	defer conn.Close()
	if c.verifyConnection(ctx, conn, true) != nil {
		return "", ErrInstallation
	}
	tx, err := conn.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted, ReadOnly: true})
	if err != nil {
		return "", ErrTarget
	}
	defer tx.Rollback()
	if c.verifyControl(ctx, tx) != nil {
		return "", ErrInstallation
	}
	var catalogHex, incarnation, epoch string
	if err := tx.QueryRowContext(ctx, "CALL "+qualified(c.manifest.ControlCatalog, "read_gate")+"()").Scan(&catalogHex, &incarnation, &epoch); err != nil || !strings.EqualFold(catalogHex, hex.EncodeToString([]byte(c.manifest.Spec.Catalog))) || incarnation != c.manifest.Spec.Incarnation || !hex64.MatchString(epoch) {
		return "", ErrInstallation
	}
	return epoch, nil
}

// Recover is a target-only barrier. The application must already have frozen
// all aliases, and must reconcile all pages before admitting any fresh preview.
// A missing receipt or an empty page is never automatic unfreeze permission.
func (c *Controller) Recover(ctx context.Context, expected string) (string, error) {
	if !hex64.MatchString(expected) {
		return "", ErrTarget
	}
	next, err := NewEpoch()
	if err != nil {
		return "", err
	}
	conn, err := c.recovery.Conn(ctx)
	if err != nil {
		return "", ErrTarget
	}
	defer conn.Close()
	if c.verifyConnection(ctx, conn, true) != nil {
		return "", ErrInstallation
	}
	if _, err = conn.ExecContext(ctx, "SET SESSION innodb_lock_wait_timeout=3"); err != nil {
		return "", ErrTarget
	}
	tx, err := conn.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return "", ErrTarget
	}
	defer tx.Rollback()
	if c.verifyControl(ctx, tx) != nil {
		return "", ErrInstallation
	}
	if _, err = tx.ExecContext(ctx, "CALL "+qualified(c.manifest.ControlCatalog, "rotate_gate")+"(?,?)", expected, next); err != nil {
		return "", ErrTarget
	}
	if err = tx.Commit(); err != nil {
		return "", ErrTarget
	}
	return next, nil
}
func (c *Controller) ListReceipts(ctx context.Context, scope mutationrunner.Scope, after string) ([]mutationrunner.Receipt, error) {
	if !c.allowed(scope) || (after != "" && !uuid.MatchString(after)) {
		return nil, mutationrunner.ErrDenied
	}
	conn, err := c.recovery.Conn(ctx)
	if err != nil {
		return nil, ErrTarget
	}
	defer conn.Close()
	if c.verifyConnection(ctx, conn, true) != nil {
		return nil, ErrInstallation
	}
	tx, err := conn.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted, ReadOnly: true})
	if err != nil {
		return nil, ErrTarget
	}
	defer tx.Rollback()
	if c.verifyControl(ctx, tx) != nil {
		return nil, ErrInstallation
	}
	rows, err := tx.QueryContext(ctx, "CALL "+qualified(c.manifest.ControlCatalog, "list_receipts")+"(?,?)", scopeRaw(scope), after)
	if err != nil {
		return nil, ErrTarget
	}
	return c.receiptRows(rows, scope)
}

type transaction struct {
	controller *Controller
	conn       *sql.Conn
	tx         *sql.Tx
	binding    mutationrunner.Binding
	cancel     context.CancelFunc
	closed     bool
	metadata   *mutationguard.Table
}

func (t *transaction) Commit() error {
	if t.closed {
		return ErrTarget
	}
	t.closed = true
	defer t.conn.Close()
	defer t.cancel()
	return t.tx.Commit()
}
func (t *transaction) Rollback() error {
	if t.closed {
		return sql.ErrTxDone
	}
	t.closed = true
	defer t.conn.Close()
	defer t.cancel()
	return t.tx.Rollback()
}
func (t *transaction) PutReceipt(ctx context.Context, r mutationrunner.Receipt) error {
	commitment, err := base64.RawURLEncoding.DecodeString(r.Commitment)
	if r.Scope != t.binding.Scope || r.TargetIdentity != t.binding.TargetIdentity || r.TargetEpoch != t.binding.TargetEpoch || !uuid.MatchString(r.ExecutionID) || err != nil || len(commitment) != 32 || base64.RawURLEncoding.EncodeToString(commitment) != r.Commitment || r.RowCount < 1 || r.RowCount > 100 {
		return mutationrunner.ErrDenied
	}
	_, err = t.tx.ExecContext(ctx, "CALL "+qualified(t.controller.manifest.ControlCatalog, "put_receipt")+"(?,?,?,?,?)", r.ExecutionID, commitment, scopeRaw(r.Scope), r.TargetEpoch, r.RowCount)
	if err != nil {
		return ErrTarget
	}
	return nil
}
func (t *transaction) Exec(ctx context.Context, s mutationguard.Statement) (mutationrunner.ApplyResult, error) {
	var result mutationrunner.ApplyResult
	if t.metadata == nil || mutationguard.VerifyStatement(*t.metadata, s) != nil || (s.Operation != "insert" && s.Operation != "update" && s.Operation != "delete") {
		return result, mutationrunner.ErrDenied
	}
	applied, err := t.tx.ExecContext(ctx, s.SQL, s.Args...)
	if err != nil {
		return result, ErrTarget
	}
	var warnings int
	if t.tx.QueryRowContext(ctx, "SHOW COUNT(*) WARNINGS").Scan(&warnings) != nil || warnings != 0 {
		return result, ErrTarget
	}
	result.Affected, err = applied.RowsAffected()
	if err != nil {
		return result, ErrTarget
	}
	result.LastInsertID, err = applied.LastInsertId()
	if err != nil {
		return result, ErrTarget
	}
	return result, nil
}

var _ mutationrunner.Target = (*Controller)(nil)
