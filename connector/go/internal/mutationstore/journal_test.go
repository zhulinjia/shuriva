package mutationstore

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	bolt "go.etcd.io/bbolt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func storeFixture(t *testing.T) (*Store, []byte, string, mutationrunner.Scope) {
	t.Helper()
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "journal.db")
	s, err := Create(path, key, "connector", NewMemoryPackageKeys())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, key, path, mutationrunner.Scope{OwnerID: "owner", WorkspaceID: "workspace", SourceID: "source", ConnectorID: "connector"}
}
func TestEncryptedLeaseAuthenticatesScopeMetadataAndCiphertext(t *testing.T) {
	s, _, path, scope := storeFixture(t)
	ctx := context.Background()
	sensitive := []byte("private-customer-original-value")
	lease := mutationrunner.Lease{ID: "preview", Scope: scope, Commitment: "opaque", ExpiresAt: time.Now().Add(2 * time.Minute).Unix(), ReconciliationExpiresAt: time.Now().Unix() + 86400, Payload: sensitive}
	if err := s.SaveLease(ctx, lease); err != nil {
		t.Fatal(err)
	}
	file, err := os.ReadFile(path)
	if err != nil || bytes.Contains(file, sensitive) {
		t.Fatal("plaintext lease leaked into bbolt")
	}
	loaded, err := s.LoadLease(ctx, lease.ID, scope)
	if err != nil || !bytes.Equal(loaded.Payload, sensitive) {
		t.Fatal("lease did not decrypt")
	}
	foreign := scope
	foreign.WorkspaceID = "other"
	if _, err = s.LoadLease(ctx, lease.ID, foreign); !errors.Is(err, mutationrunner.ErrDenied) {
		t.Fatal("lease crossed scope")
	}
	if err = s.SaveLease(ctx, lease); !errors.Is(err, mutationrunner.ErrConsumed) {
		t.Fatal("lease identity overwritten")
	}
	if err = s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(leasesBucket)
		var value storedLease
		if err := json.Unmarshal(b.Get([]byte(lease.ID)), &value); err != nil {
			return err
		}
		value.ExpiresAt++
		raw, _ := json.Marshal(value)
		return b.Put([]byte(lease.ID), raw)
	}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.LoadLease(ctx, lease.ID, scope); !errors.Is(err, ErrJournal) {
		t.Fatal("lease expiry metadata tampering was not authenticated")
	}
}
func TestJournalSingleConsumptionStateAndAuthenticatedMetadata(t *testing.T) {
	s, _, _, scope := storeFixture(t)
	ctx := context.Background()
	e := mutationrunner.Execution{Binding: mutationrunner.Binding{Scope: scope, TargetIdentity: "target"}, ExecutionID: "execution", PreviewID: "preview", Commitment: "opaque", Revision: 1}
	r := mutationrunner.Record{Execution: e, State: "accepted"}
	if err := s.Accept(ctx, r); err != nil {
		t.Fatal(err)
	}
	var won atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if s.Consume(ctx, e) == nil {
				won.Add(1)
			}
		}()
	}
	wg.Wait()
	if won.Load() != 1 {
		t.Fatal("durable consumption was not one-shot")
	}
	r.State = "execution_started"
	if s.Transition(ctx, r) != nil {
		t.Fatal("start transition refused")
	}
	r.State = "commit_intent"
	if s.Transition(ctx, r) != nil {
		t.Fatal("commit intent refused")
	}
	r.State = "committed"
	if s.Transition(ctx, r) != nil {
		t.Fatal("commit refused")
	}
	r.State = "accepted"
	if s.Transition(ctx, r) == nil {
		t.Fatal("terminal execution became executable")
	}
	if err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(recordsBucket)
		var stored storedRecord
		if err := json.Unmarshal(b.Get([]byte(e.ExecutionID)), &stored); err != nil {
			return err
		}
		stored.Record.State = "accepted"
		stored.Consumed = false
		raw, _ := json.Marshal(stored)
		return b.Put([]byte(e.ExecutionID), raw)
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(ctx, e.ExecutionID, scope); !errors.Is(err, ErrJournal) {
		t.Fatal("same-count execution tampering passed authentication")
	}
}

func TestJournalPreviewMayBeConsumedByOnlyOneExecutionAcrossRestart(t *testing.T) {
	s, key, path, scope := storeFixture(t)
	ctx := context.Background()
	first := mutationrunner.Execution{Binding: mutationrunner.Binding{Scope: scope, TargetIdentity: "target"}, ExecutionID: "first", PreviewID: "same-preview", Commitment: "opaque", Revision: 1}
	second := first
	second.ExecutionID = "second"
	if err := s.Accept(ctx, mutationrunner.Record{Execution: first, State: "accepted"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Accept(ctx, mutationrunner.Record{Execution: second, State: "accepted"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Consume(ctx, first); err != nil {
		t.Fatal(err)
	}
	if err := s.Consume(ctx, second); !errors.Is(err, mutationrunner.ErrConsumed) {
		t.Fatal("second execution consumed the same preview")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path, key, "connector", s.keys)
	if err != nil {
		t.Fatal(err)
	}
	if err := reopened.Consume(ctx, second); !errors.Is(err, mutationrunner.ErrConsumed) {
		t.Fatal("restart lost preview consumption")
	}
	if err := reopened.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(metadataBucket).Delete([]byte("preview-owner-v1:" + first.PreviewID))
	}); err != nil {
		t.Fatal(err)
	}
	if err := reopened.Close(); err != nil {
		t.Fatal(err)
	}
	if compromised, err := Open(path, key, "connector", s.keys); !errors.Is(err, ErrJournal) {
		if compromised != nil {
			compromised.Close()
		}
		t.Fatal("missing owner claim was not detected")
	}
}

func TestDeleteOwnedLeaseCannotRemoveAnotherExecutionPackage(t *testing.T) {
	s, _, _, scope := storeFixture(t)
	ctx := context.Background()
	first := mutationrunner.Execution{Binding: mutationrunner.Binding{Scope: scope, TargetIdentity: "target"}, ExecutionID: "first", PreviewID: "same-preview", Commitment: "opaque", Revision: 1}
	second := first
	second.ExecutionID = "second"
	lease := mutationrunner.Lease{ID: first.PreviewID, Scope: scope, Commitment: first.Commitment, ExpiresAt: time.Now().Unix() + 120, ReconciliationExpiresAt: time.Now().Unix() + 86400, Payload: []byte("protected-material")}
	if err := s.SaveLease(ctx, lease); err != nil {
		t.Fatal(err)
	}
	for _, e := range []mutationrunner.Execution{first, second} {
		if err := s.Accept(ctx, mutationrunner.Record{Execution: e, State: "accepted"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.DeleteOwnedLease(ctx, second); err != nil {
		t.Fatal(err)
	}
	if _, err := s.LoadLease(ctx, first.PreviewID, scope); err != nil {
		t.Fatal("unconsumed execution deleted preview")
	}
	if err := s.Consume(ctx, first); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteOwnedLease(ctx, second); err != nil {
		t.Fatal(err)
	}
	if _, err := s.LoadLease(ctx, first.PreviewID, scope); err != nil {
		t.Fatal("non-owner deleted preview")
	}
	wrong := first
	wrong.WorkspaceID = "different"
	if err := s.DeleteOwnedLease(ctx, wrong); !errors.Is(err, mutationrunner.ErrDenied) {
		t.Fatal("owner binding was not checked")
	}
	if err := s.DeleteOwnedLease(ctx, first); err != nil {
		t.Fatal(err)
	}
	if _, err := s.LoadLease(ctx, first.PreviewID, scope); !errors.Is(err, mutationrunner.ErrNotFound) {
		t.Fatal("owner could not delete its package")
	}
}

func TestUnsupportedJournalFormatIsRefusedWithoutChangingFile(t *testing.T) {
	s, key, path, _ := storeFixture(t)
	if err := s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(metadataBucket).Put([]byte("format"), []byte("stackoryn-mutation-journal-v1"))
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if opened, err := Open(path, key, "connector", s.keys); !errors.Is(err, ErrJournal) {
		if opened != nil {
			opened.Close()
		}
		t.Fatal("unsupported journal format was accepted")
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("refused journal was modified")
	}
}
func TestJournalMissingWrongIdentityKeyAndFileLockRefuse(t *testing.T) {
	s, key, path, _ := storeFixture(t)
	if other, err := Open(path, key, "connector", s.keys); err == nil {
		other.Close()
		t.Fatal("second journal writer acquired file")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if other, err := Open(path, key, "other", s.keys); err == nil {
		other.Close()
		t.Fatal("wrong identity acquired journal")
	}
	wrong := append([]byte(nil), key...)
	wrong[0] ^= 1
	if other, err := Open(path, wrong, "connector", s.keys); err == nil {
		other.Close()
		t.Fatal("wrong key opened journal")
	}
	if other, err := Open(path+"-missing", key, "connector", s.keys); err == nil {
		other.Close()
		t.Fatal("missing journal was recreated")
	}
	if _, err := os.Stat(path + "-missing"); !os.IsNotExist(err) {
		t.Fatal("missing-journal refusal created an empty file")
	}
}
func TestRetentionFixedDeadlineCleanupPreservesOnlyActiveAndTombstone(t *testing.T) {
	s, _, _, scope := storeFixture(t)
	ctx := context.Background()
	now := time.Now().Unix()
	lease := mutationrunner.Lease{ID: "preview", Scope: scope, Commitment: "opaque", ExpiresAt: now + 120, ReconciliationExpiresAt: now + 86400, Payload: []byte("reconciliation")}
	if s.SaveLease(ctx, lease) != nil {
		t.Fatal("save")
	}
	deadline := now + 86400
	if s.RetainLease(ctx, lease.ID, scope, deadline) != nil || s.RetainLease(ctx, lease.ID, scope, deadline) != nil {
		t.Fatal("fixed retention not idempotent")
	}
	if s.RetainLease(ctx, lease.ID, scope, deadline+1) == nil {
		t.Fatal("retention deadline extended")
	}
	if s.CleanupLeases(ctx, now+121, []string{lease.ID}) != nil {
		t.Fatal("active cleanup failed")
	}
	if _, err := s.LoadLease(ctx, lease.ID, scope); err != nil {
		t.Fatal("active lease deleted")
	}
	e := mutationrunner.Execution{Binding: mutationrunner.Binding{Scope: scope, TargetIdentity: "target"}, ExecutionID: "execution", PreviewID: lease.ID, Commitment: "opaque"}
	if s.Accept(ctx, mutationrunner.Record{Execution: e, State: "accepted"}) != nil {
		t.Fatal("accept")
	}
	if s.CleanupLeases(ctx, deadline+1, nil) != nil {
		t.Fatal("expired cleanup failed")
	}
	if _, err := s.LoadLease(ctx, lease.ID, scope); !errors.Is(err, mutationrunner.ErrNotFound) {
		t.Fatal("expired payload retained")
	}
	if _, err := s.Get(ctx, e.ExecutionID, scope); err != nil {
		t.Fatal("cleanup removed tombstone")
	}
	if s.CleanupLeases(ctx, deadline, []string{"x", "x"}) == nil {
		t.Fatal("duplicate active set accepted")
	}
}
func TestTargetJournalPagesAreBoundedAndScopeDoesNotLeak(t *testing.T) {
	s, _, _, scope := storeFixture(t)
	ctx := context.Background()
	for i := 0; i < 101; i++ {
		e := mutationrunner.Execution{Binding: mutationrunner.Binding{Scope: scope, TargetIdentity: "target"}, ExecutionID: time.Unix(int64(i), 0).UTC().Format(time.RFC3339), Commitment: "opaque"}
		if s.Accept(ctx, mutationrunner.Record{Execution: e, State: "accepted"}) != nil {
			t.Fatal("accept")
		}
	}
	e := mutationrunner.Execution{Binding: mutationrunner.Binding{Scope: scope, TargetIdentity: "other"}, ExecutionID: "other", Commitment: "opaque"}
	if s.Accept(ctx, mutationrunner.Record{Execution: e, State: "accepted"}) != nil {
		t.Fatal("other")
	}
	first, next, err := s.ListTargetRecords(ctx, "target", "")
	if err != nil || len(first) != 100 || next == "" {
		t.Fatal("first page")
	}
	second, after, err := s.ListTargetRecords(ctx, "target", next)
	if err != nil || len(second) != 1 || after != "" {
		t.Fatal("last page")
	}
}

func TestAcceptedRestoreCanLoseCertaintyButCannotAcquireRetry(t *testing.T) {
	s, _, _, scope := storeFixture(t)
	ctx := context.Background()
	e := mutationrunner.Execution{Binding: mutationrunner.Binding{Scope: scope, TargetIdentity: "target"}, ExecutionID: "restore", Commitment: "opaque"}
	r := mutationrunner.Record{Execution: e, State: "accepted"}
	if s.Accept(ctx, r) != nil {
		t.Fatal("accept")
	}
	r.State = "outcome_unknown"
	if s.Transition(ctx, r) != nil {
		t.Fatal("restored accepted state could not become conservative unknown")
	}
	if s.Consume(ctx, e) == nil {
		t.Fatal("unknown regained execution")
	}
	r.State = "rolled_back"
	if s.Transition(ctx, r) == nil {
		t.Fatal("unknown became rollback without proof")
	}
	r.State = "committed"
	if s.Transition(ctx, r) != nil {
		t.Fatal("independently proven receipt could not record commit")
	}
}
