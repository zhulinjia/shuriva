package g2

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

// This is an isolated SQL contract experiment, not an API or authorization
// implementation. It uses MySQL transactions/constraints instead of a mutex
// to test the design's consumption, close, recovery and outbox atomicity.
type registrationLab struct{ f *mysqlFixture }

var errRegistrationConflict = errors.New("confirmation conflicts with the original registration")

func newRegistrationLab(t *testing.T) *registrationLab {
	f := newMySQLFixture(t)
	f.exec(t, "CREATE TABLE "+f.table("scope_authority")+" (id INT PRIMARY KEY) ENGINE=InnoDB")
	f.exec(t, "INSERT INTO "+f.table("scope_authority")+" VALUES (1),(2)")
	f.exec(t, "CREATE TABLE "+f.table("previews")+" (id VARBINARY(80) PRIMARY KEY, scope_id INT NOT NULL, commitment VARBINARY(80) NOT NULL, state VARBINARY(20) NOT NULL) ENGINE=InnoDB")
	f.exec(t, "CREATE TABLE "+f.table("confirmations")+" (id VARBINARY(80) PRIMARY KEY, preview_id VARBINARY(80) NOT NULL, commitment VARBINARY(80) NOT NULL, scope_id INT NOT NULL, state VARBINARY(20) NOT NULL, execution_id VARBINARY(100) NULL) ENGINE=InnoDB")
	f.exec(t, "CREATE TABLE "+f.table("executions")+" (id VARBINARY(100) PRIMARY KEY, confirmation_id VARBINARY(80) NOT NULL UNIQUE, preview_id VARBINARY(80) NOT NULL UNIQUE, scope_id INT NOT NULL, state VARBINARY(20) NOT NULL) ENGINE=InnoDB")
	f.exec(t, "CREATE TABLE "+f.table("outbox")+" (execution_id VARBINARY(100) PRIMARY KEY, event VARBINARY(40) NOT NULL) ENGINE=InnoDB")
	return &registrationLab{f: f}
}

func (r *registrationLab) preview(t *testing.T, id string, scope int) {
	t.Helper()
	r.f.exec(t, "INSERT INTO "+r.f.table("previews")+" VALUES (?,?,'commitment','pending')", id, scope)
}

func (r *registrationLab) begin(scope int) (*sql.Tx, context.CancelFunc, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	tx, err := r.f.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err == nil {
		var actual int
		err = tx.QueryRowContext(ctx, "SELECT id FROM "+r.f.table("scope_authority")+" WHERE id=? FOR UPDATE", scope).Scan(&actual)
	}
	if err != nil {
		if tx != nil {
			tx.Rollback()
		}
		cancel()
		return nil, func() {}, err
	}
	return tx, cancel, nil
}

func (r *registrationLab) register(preview, confirmation, commitment string, scope int, failBeforeCommit bool) (string, error) {
	tx, cancel, err := r.begin(scope)
	if err != nil {
		return "", err
	}
	defer cancel()
	defer tx.Rollback()
	var p, c, state string
	var previousScope int
	var previous sql.NullString
	err = tx.QueryRow("SELECT preview_id,commitment,state,execution_id,scope_id FROM "+r.f.table("confirmations")+" WHERE id=?", confirmation).Scan(&p, &c, &state, &previous, &previousScope)
	if err == nil {
		if p != preview || c != commitment || previousScope != scope || state != "registered" {
			return "", errRegistrationConflict
		}
		return previous.String, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	if err = tx.QueryRow("SELECT state,commitment FROM "+r.f.table("previews")+" WHERE id=? AND scope_id=?", preview, scope).Scan(&state, &c); err != nil {
		return "", err
	}
	if state != "pending" || c != commitment {
		return "", errRegistrationConflict
	}
	id := "execution-" + confirmation
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{"UPDATE " + r.f.table("previews") + " SET state='consumed' WHERE id=?", []any{preview}},
		{"INSERT INTO " + r.f.table("confirmations") + " VALUES (?,?,?,?,'registered',?)", []any{confirmation, preview, commitment, scope, id}},
		{"INSERT INTO " + r.f.table("executions") + " VALUES (?,?,?,?,'running')", []any{id, confirmation, preview, scope}},
		{"INSERT INTO " + r.f.table("outbox") + " VALUES (?,'execution_registered')", []any{id}},
	} {
		if _, err := tx.Exec(statement.query, statement.args...); err != nil {
			return "", err
		}
	}
	if failBeforeCommit {
		return "", errors.New("injected failure before registration commit")
	}
	return id, tx.Commit()
}

func (r *registrationLab) close(preview, confirmation string, scope int) (string, error) {
	tx, cancel, err := r.begin(scope)
	if err != nil {
		return "", err
	}
	defer cancel()
	defer tx.Rollback()
	var state string
	if err := tx.QueryRow("SELECT state FROM "+r.f.table("previews")+" WHERE id=? AND scope_id=?", preview, scope).Scan(&state); err != nil {
		return "", err
	}
	if state == "consumed" {
		var id string
		if err := tx.QueryRow("SELECT id FROM "+r.f.table("executions")+" WHERE preview_id=? AND scope_id=?", preview, scope).Scan(&id); err != nil {
			return "", err
		}
		return id, nil
	}
	if _, err := tx.Exec("UPDATE "+r.f.table("previews")+" SET state='closed' WHERE id=?", preview); err != nil {
		return "", err
	}
	if state == "pending" {
		if _, err := tx.Exec("INSERT INTO "+r.f.table("confirmations")+" VALUES (?,?,'commitment',?,'closed',NULL)", confirmation, preview, scope); err != nil {
			return "", err
		}
	}
	return "", tx.Commit()
}

func (r *registrationLab) recovery(scope int) ([]string, error) {
	tx, cancel, err := r.begin(scope)
	if err != nil {
		return nil, err
	}
	defer cancel()
	defer tx.Rollback()
	if _, err := tx.Exec("UPDATE "+r.f.table("previews")+" SET state='closed' WHERE scope_id=? AND state='pending'", scope); err != nil {
		return nil, err
	}
	rows, err := tx.Query("SELECT id FROM "+r.f.table("executions")+" WHERE scope_id=? ORDER BY id", scope)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	return ids, tx.Commit()
}

func TestMySQLRegistrationSingleConsumptionAndOutboxAtomicity(t *testing.T) {
	r := newRegistrationLab(t)
	r.preview(t, "preview", 1)
	start := make(chan struct{})
	var wg sync.WaitGroup
	results, failures := make(chan string, 24), make(chan error, 24)
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			id, err := r.register("preview", fmt.Sprintf("confirmation-%02d", i), "commitment", 1, false)
			if err == nil {
				results <- id
			} else if !errors.Is(err, errRegistrationConflict) {
				failures <- err
			}
		}(i)
	}
	close(start)
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
	if len(results) != 1 || mysqlCount(t, r.f.db, "SELECT COUNT(*) FROM "+r.f.table("executions")) != 1 || mysqlCount(t, r.f.db, "SELECT COUNT(*) FROM "+r.f.table("outbox")) != 1 {
		t.Fatal("one preview did not produce exactly one registration and outbox event")
	}
	id := <-results
	confirmation := id[len("execution-"):]
	if repeated, err := r.register("preview", confirmation, "commitment", 1, false); err != nil || repeated != id {
		t.Fatal("same confirmation did not recover the original execution")
	}
	if _, err := r.register("preview", confirmation, "tampered", 1, false); !errors.Is(err, errRegistrationConflict) {
		t.Fatal("same confirmation accepted changed contents")
	}
	if _, err := r.register("preview", confirmation, "commitment", 2, false); !errors.Is(err, errRegistrationConflict) {
		t.Fatal("same confirmation disclosed an execution under a different scope")
	}
	r.preview(t, "rollback-preview", 1)
	if _, err := r.register("rollback-preview", "rollback-confirmation", "commitment", 1, true); err == nil {
		t.Fatal("injected registration failure did not fail")
	}
	if mysqlCount(t, r.f.db, "SELECT COUNT(*) FROM "+r.f.table("executions")) != 1 || mysqlCount(t, r.f.db, "SELECT COUNT(*) FROM "+r.f.table("outbox")) != 1 || mysqlCount(t, r.f.db, "SELECT COUNT(*) FROM "+r.f.table("previews")+" WHERE id='rollback-preview' AND state='pending'") != 1 {
		t.Fatal("registration/outbox failed to roll back together")
	}
	t.Log("24 concurrent different confirmations: one execution/outbox; same-ID retry recovers identity; injected failure rolls back consumption and outbox")
}

func TestMySQLConfirmationCloseAndRecoveryBarrierRaces(t *testing.T) {
	r := newRegistrationLab(t)
	for _, action := range []string{"close", "recovery"} {
		for i := 0; i < 16; i++ {
			preview := fmt.Sprintf("%s-preview-%d", action, i)
			confirmation := fmt.Sprintf("%s-confirmation-%d", action, i)
			r.preview(t, preview, 1)
			start := make(chan struct{})
			var wg sync.WaitGroup
			var registerErr, recoveryErr error
			var registeredID, closedID string
			var recoveredIDs []string
			wg.Add(2)
			go func() {
				defer wg.Done()
				<-start
				registeredID, registerErr = r.register(preview, confirmation, "commitment", 1, false)
			}()
			go func() {
				defer wg.Done()
				<-start
				if action == "close" {
					closedID, recoveryErr = r.close(preview, confirmation, 1)
				} else {
					recoveredIDs, recoveryErr = r.recovery(1)
				}
			}()
			close(start)
			wg.Wait()
			if recoveryErr != nil || (registerErr != nil && !errors.Is(registerErr, errRegistrationConflict)) {
				t.Fatalf("unexpected race result: registration=%v, recovery=%v", registerErr, recoveryErr)
			}
			count := mysqlCount(t, r.f.db, "SELECT COUNT(*) FROM "+r.f.table("executions")+" WHERE preview_id=?", preview)
			if (registerErr == nil && count != 1) || (registerErr != nil && count != 0) {
				t.Fatal("closure/barrier neither returned an existing registration nor sealed it")
			}
			if registerErr == nil {
				if action == "close" && closedID != registeredID {
					t.Fatal("registration won but close did not return the original execution")
				}
				if action == "recovery" {
					found := false
					for _, id := range recoveredIDs {
						found = found || id == registeredID
					}
					if !found {
						t.Fatal("registration won but recovery omitted the original execution")
					}
				}
			} else if closedID != "" {
				t.Fatal("a closure that won before registration returned an invented execution")
			}
			_, lateErr := r.register(preview, confirmation, "commitment", 1, false)
			if registerErr != nil && !errors.Is(lateErr, errRegistrationConflict) {
				t.Fatal("late original confirmation registered after closure/barrier")
			}
		}
	}
	r.preview(t, "other-scope", 2)
	other, err := r.register("other-scope", "other-confirmation", "commitment", 2, false)
	if err != nil {
		t.Fatal(err)
	}
	r.preview(t, "completed", 1)
	completed, err := r.register("completed", "completed-confirmation", "commitment", 1, false)
	if err != nil {
		t.Fatal(err)
	}
	r.f.exec(t, "UPDATE "+r.f.table("executions")+" SET state='committed' WHERE id=?", completed)
	before := mysqlCount(t, r.f.db, "SELECT COUNT(*) FROM "+r.f.table("executions"))
	ids, err := r.recovery(1)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, id := range ids {
		if id == other {
			t.Fatal("recovery leaked another scope's record")
		}
		found = found || id == completed
	}
	if !found || mysqlCount(t, r.f.db, "SELECT COUNT(*) FROM "+r.f.table("executions")) != before {
		t.Fatal("recovery omitted the completed record or created an execution")
	}
	t.Log("32 real transaction races preserve original identity or seal late confirmation; completed records remain discoverable without creating new execution")
}
