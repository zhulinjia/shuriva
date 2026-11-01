package g2

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
	boltErrors "go.etcd.io/bbolt/errors"
)

// These are disposable journal experiments, not the Connector's write runner.
// In particular, a bbolt commit and a MySQL commit are not one transaction.
var journalConflict = errors.New("execution identity has a different commitment")

var (
	journalMeta       = []byte("metadata")
	journalExecutions = []byte("executions")
	journalEpoch      = []byte("epoch")
	journalSequence   = []byte("sequence")
)

type journalCheckpoint struct {
	Epoch    string `json:"epoch"`
	Sequence uint64 `json:"sequence"`
}

func journalOpen(path string) (*bolt.DB, error) {
	return bolt.Open(path, 0600, &bolt.Options{Timeout: 400 * time.Millisecond})
}

func journalInitialize(db *bolt.DB, epoch string) error {
	return db.Update(func(tx *bolt.Tx) error {
		meta, err := tx.CreateBucketIfNotExists(journalMeta)
		if err != nil {
			return err
		}
		if _, err = tx.CreateBucketIfNotExists(journalExecutions); err != nil {
			return err
		}
		if meta.Get(journalEpoch) != nil {
			return errors.New("refuse to reinitialize an existing journal")
		}
		if err = meta.Put(journalEpoch, []byte(epoch)); err != nil {
			return err
		}
		return meta.Put(journalSequence, make([]byte, 8))
	})
}

// Update gives a single local CAS. The callback has no external side effects;
// a successful return only grants the experiment's local marker, never DML.
func journalReserve(db *bolt.DB, executionID, commitment string) (bool, error) {
	won := false
	err := db.Update(func(tx *bolt.Tx) error {
		records, meta := tx.Bucket(journalExecutions), tx.Bucket(journalMeta)
		if records == nil || meta == nil || len(meta.Get(journalSequence)) != 8 {
			return errors.New("journal metadata unavailable")
		}
		if previous := records.Get([]byte(executionID)); previous != nil {
			if string(previous) != commitment {
				return journalConflict
			}
			return nil
		}
		if err := records.Put([]byte(executionID), []byte(commitment)); err != nil {
			return err
		}
		sequence := binary.BigEndian.Uint64(meta.Get(journalSequence))
		if sequence == ^uint64(0) {
			return errors.New("journal sequence exhausted")
		}
		encoded := make([]byte, 8)
		binary.BigEndian.PutUint64(encoded, sequence+1)
		if err := meta.Put(journalSequence, encoded); err != nil {
			return err
		}
		won = true
		return nil
	})
	return won && err == nil, err
}

func journalReadCheckpoint(db *bolt.DB) (journalCheckpoint, error) {
	var checkpoint journalCheckpoint
	err := db.View(func(tx *bolt.Tx) error {
		meta := tx.Bucket(journalMeta)
		if meta == nil || len(meta.Get(journalSequence)) != 8 || len(meta.Get(journalEpoch)) == 0 {
			return errors.New("journal checkpoint unavailable")
		}
		checkpoint.Epoch = string(meta.Get(journalEpoch))
		checkpoint.Sequence = binary.BigEndian.Uint64(meta.Get(journalSequence))
		return nil
	})
	return checkpoint, err
}

func journalReadExecution(db *bolt.DB, id string) (string, error) {
	var value string
	err := db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(journalExecutions)
		if bucket == nil {
			return errors.New("execution bucket unavailable")
		}
		value = string(bucket.Get([]byte(id)))
		return nil
	})
	return value, err
}

func journalCheck(t *testing.T, db *bolt.DB) {
	t.Helper()
	if err := db.View(func(tx *bolt.Tx) error {
		var failures error
		for err := range tx.Check() {
			failures = errors.Join(failures, err)
		}
		return failures
	}); err != nil {
		t.Fatalf("journal integrity check: %v", err)
	}
}

func journalNewFixture(t *testing.T) (string, *bolt.DB) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "disposable-journal.db")
	db, err := journalOpen(path)
	if err != nil {
		t.Fatalf("create disposable journal: %v", err)
	}
	if db.NoSync {
		t.Fatal("experiment must use synchronized commits")
	}
	if err := journalInitialize(db, "g2-journal-epoch"); err != nil {
		_ = db.Close()
		t.Fatalf("initialize disposable journal: %v", err)
	}
	return path, db
}

// Only this test's executable, exact test name and the explicit argument marker
// can enter helper mode. All helper paths are created by the parent test.
func journalHelperArgs(mode string) (string, bool) {
	for i, arg := range os.Args {
		if arg == "--g2-disposable-journal="+mode && i+1 < len(os.Args) {
			return os.Args[i+1], true
		}
	}
	return "", false
}

func journalChild(t *testing.T, testName, mode, path string) ([]byte, error) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal("cannot locate current test executable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, "-test.run=^"+testName+"$", "--", "--g2-disposable-journal="+mode, path)
	journalHideChildWindow(cmd)
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("disposable journal helper exceeded deadline: %s", output)
	}
	return output, err
}

func TestG2JournalFileLockAcrossProcesses(t *testing.T) {
	if path, child := journalHelperArgs("lock-contender"); child {
		db, err := journalOpen(path)
		if db != nil {
			_ = db.Close()
		}
		if !errors.Is(err, boltErrors.ErrTimeout) {
			t.Fatalf("expected competing process lock timeout, got %v", err)
		}
		fmt.Println("g2-file-lock-timeout")
		return
	}
	if path, child := journalHelperArgs("open-after-release"); child {
		db, err := journalOpen(path)
		if err != nil {
			t.Fatalf("open released disposable journal: %v", err)
		}
		if err := db.Close(); err != nil {
			t.Fatal(err)
		}
		fmt.Println("g2-file-lock-released")
		return
	}
	path, db := journalNewFixture(t)
	defer db.Close()
	output, err := journalChild(t, t.Name(), "lock-contender", path)
	if err != nil || !strings.Contains(string(output), "g2-file-lock-timeout") {
		t.Fatalf("second process did not report the expected lock timeout: %v, %s", err, output)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	output, err = journalChild(t, t.Name(), "open-after-release", path)
	if err != nil || !strings.Contains(string(output), "g2-file-lock-released") {
		t.Fatalf("second process could not open after release: %v, %s", err, output)
	}
	t.Log("a distinct process timed out while the writer owned the file; reopening after release succeeded")
}

func TestG2JournalSyncedCommitSurvivesAbruptExit(t *testing.T) {
	if path, child := journalHelperArgs("commit-and-exit"); child {
		db, err := journalOpen(path)
		if err != nil {
			t.Fatal(err)
		}
		if db.NoSync {
			t.Fatal("NoSync is forbidden in this experiment")
		}
		if won, err := journalReserve(db, "execution-synced", "commitment-1"); err != nil || !won {
			t.Fatalf("synchronized marker commit failed: %v", err)
		}
		uncommitted, err := db.Begin(true)
		if err != nil {
			t.Fatal(err)
		}
		if err = uncommitted.Bucket(journalExecutions).Put([]byte("execution-uncommitted"), []byte("must-not-survive")); err != nil {
			t.Fatal(err)
		}
		fmt.Println("g2-synced-before-abrupt-exit")
		// Intentionally bypass Close/Rollback. This exits only this child test
		// process, not MySQL, the Connector, the platform or another application.
		os.Exit(23)
	}
	path, db := journalNewFixture(t)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	output, err := journalChild(t, t.Name(), "commit-and-exit", path)
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 23 || !strings.Contains(string(output), "g2-synced-before-abrupt-exit") {
		t.Fatalf("expected owned child abrupt exit 23 after sync: %v, %s", err, output)
	}
	db, err = journalOpen(path)
	if err != nil {
		t.Fatalf("reopen after owned helper exit: %v", err)
	}
	defer db.Close()
	if got, err := journalReadExecution(db, "execution-synced"); err != nil || got != "commitment-1" {
		t.Fatalf("committed marker lost: value=%q, err=%v", got, err)
	}
	if got, err := journalReadExecution(db, "execution-uncommitted"); err != nil || got != "" {
		t.Fatalf("uncommitted marker survived: value=%q, err=%v", got, err)
	}
	if checkpoint, err := journalReadCheckpoint(db); err != nil || checkpoint.Sequence != 1 {
		t.Fatalf("checkpoint not atomically committed with marker: %+v, %v", checkpoint, err)
	}
	journalCheck(t, db)
	t.Log("synced marker survived os.Exit without Close; an open, uncommitted transaction did not survive")
	t.Log("this does not simulate power loss or a crash during the storage device's commit/flush")
}

func TestG2JournalConcurrentReservationAndConflict(t *testing.T) {
	_, db := journalNewFixture(t)
	defer db.Close()
	const contenders = 32
	var winners atomic.Int32
	errorsByWorker := make(chan error, contenders)
	var workers sync.WaitGroup
	for i := 0; i < contenders; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			won, err := journalReserve(db, "one-execution", "one-commitment")
			if won {
				winners.Add(1)
			}
			errorsByWorker <- err
		}()
	}
	workers.Wait()
	close(errorsByWorker)
	for err := range errorsByWorker {
		if err != nil {
			t.Fatalf("concurrent journal transaction: %v", err)
		}
	}
	if winners.Load() != 1 {
		t.Fatalf("got %d local reservation winners, want one", winners.Load())
	}
	if won, err := journalReserve(db, "one-execution", "different-content"); won || !errors.Is(err, journalConflict) {
		t.Fatalf("same identity with changed content was not rejected: won=%v err=%v", won, err)
	}
	if checkpoint, err := journalReadCheckpoint(db); err != nil || checkpoint.Sequence != 1 {
		t.Fatalf("duplicate/conflicting reservation changed checkpoint: %+v, %v", checkpoint, err)
	}
	journalCheck(t, db)
	t.Logf("%d concurrent local reservations produced exactly one marker; changed-content replay was rejected", contenders)
}

func TestG2JournalFailedUpdateRollsBackAllMarkers(t *testing.T) {
	_, db := journalNewFixture(t)
	defer db.Close()
	abort := errors.New("injected failure before local transaction commit")
	err := db.Update(func(tx *bolt.Tx) error {
		if err := tx.Bucket(journalExecutions).Put([]byte("partial-marker"), []byte("must-roll-back")); err != nil {
			return err
		}
		encoded := make([]byte, 8)
		binary.BigEndian.PutUint64(encoded, 9)
		if err := tx.Bucket(journalMeta).Put(journalSequence, encoded); err != nil {
			return err
		}
		return abort
	})
	if !errors.Is(err, abort) {
		t.Fatalf("Update did not return the injected failure: %v", err)
	}
	if value, err := journalReadExecution(db, "partial-marker"); err != nil || value != "" {
		t.Fatalf("failed transaction leaked an execution marker: %q, %v", value, err)
	}
	if checkpoint, err := journalReadCheckpoint(db); err != nil || checkpoint.Sequence != 0 {
		t.Fatalf("failed transaction advanced checkpoint: %+v, %v", checkpoint, err)
	}
	journalCheck(t, db)
	t.Log("execution marker and checkpoint rolled back together when Update returned an error")
}

func TestG2JournalDamagedMetadataCannotReopen(t *testing.T) {
	path, db := journalNewFixture(t)
	pageSize := db.Info().PageSize
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) < 2*pageSize {
		t.Fatalf("read disposable journal metadata: %v", err)
	}
	// Damage both metadata pages of this newly created disposable fixture only.
	// This is one reproducible corruption case, not arbitrary-corruption coverage.
	clear(data[:2*pageSize])
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	damaged, err := journalOpen(path)
	if damaged != nil {
		_ = damaged.Close()
	}
	if err == nil {
		t.Fatal("journal with both metadata pages damaged unexpectedly reopened")
	}
	t.Logf("both metadata pages damaged: Open rejected the fixture with %T", err)
}

// A reference recovery predicate, not a production implementation. The
// authority checkpoint is outside the restored journal snapshot; equality
// intentionally fails closed even when a local log is ahead and needs review.
func journalResumeAllowed(authority, local journalCheckpoint, authorityAvailable bool) bool {
	return authorityAvailable && authority.Epoch != "" && authority == local
}

func TestG2JournalOldValidBackupNeedsExternalCheckpoint(t *testing.T) {
	path, db := journalNewFixture(t)
	defer db.Close()
	if won, err := journalReserve(db, "before-backup", "first-content"); err != nil || !won {
		t.Fatalf("create first marker: %v", err)
	}
	snapshot := filepath.Join(filepath.Dir(path), "old-valid-backup.db")
	if err := db.View(func(tx *bolt.Tx) error { return tx.CopyFile(snapshot, 0600) }); err != nil {
		t.Fatalf("create transactionally consistent backup: %v", err)
	}
	if won, err := journalReserve(db, "after-backup", "second-content"); err != nil || !won {
		t.Fatalf("create post-backup marker: %v", err)
	}
	authority, err := journalReadCheckpoint(db)
	if err != nil {
		t.Fatal(err)
	}
	// This file models a separately retained platform checkpoint, not a second
	// real service or a cross-database atomic transaction.
	authorityFile := filepath.Join(filepath.Dir(path), "separate-authority-checkpoint.json")
	encoded, err := json.Marshal(authority)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(authorityFile, encoded, 0600); err != nil {
		t.Fatal(err)
	}
	backup, err := journalOpen(snapshot)
	if err != nil {
		t.Fatalf("valid old snapshot did not reopen: %v", err)
	}
	defer backup.Close()
	journalCheck(t, backup)
	local, err := journalReadCheckpoint(backup)
	if err != nil {
		t.Fatal(err)
	}
	if local.Epoch != authority.Epoch || local.Sequence != 1 || authority.Sequence != 2 {
		t.Fatalf("unexpected rollback setup: local=%+v authority=%+v", local, authority)
	}
	if value, err := journalReadExecution(backup, "after-backup"); err != nil || value != "" {
		t.Fatalf("old backup unexpectedly contained a later marker: %q, %v", value, err)
	}
	var independent journalCheckpoint
	data, err := os.ReadFile(authorityFile)
	if err != nil || json.Unmarshal(data, &independent) != nil {
		t.Fatal("independent authority checkpoint unavailable")
	}
	if journalResumeAllowed(independent, local, true) {
		t.Fatal("old valid snapshot incorrectly regained write eligibility")
	}
	if !journalResumeAllowed(independent, authority, true) {
		t.Fatal("matching live checkpoint did not pass the reference predicate")
	}
	if journalResumeAllowed(independent, authority, false) {
		t.Fatal("unavailable authority incorrectly permitted recovery")
	}
	wrongEpoch := authority
	wrongEpoch.Epoch = "different-journal-epoch"
	if journalResumeAllowed(independent, wrongEpoch, true) {
		t.Fatal("different epoch incorrectly permitted recovery")
	}
	t.Log("a structurally valid old snapshot reopened with the same epoch but lacked a newer tombstone")
	t.Log("the independent checkpoint reference rejected rollback, epoch mismatch and absent authority")
	t.Log("real platform/journal atomic handshakes, malicious same-sequence tampering and simultaneous authority backup rollback remain unverified")
}
