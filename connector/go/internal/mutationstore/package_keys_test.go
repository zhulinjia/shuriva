package mutationstore

import (
	"bytes"
	"context"
	"errors"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	bolt "go.etcd.io/bbolt"
	"path/filepath"
	"testing"
	"time"
)

func TestDeletingIndependentPackageKeyMakesValidOldBackupUnreadable(t *testing.T) {
	s, master, path, scope := storeFixture(t)
	ctx := context.Background()
	now := time.Now().Unix()
	lease := mutationrunner.Lease{ID: "snapshot-preview", Scope: scope, Commitment: "opaque", ExpiresAt: now + 120, ReconciliationExpiresAt: now + 86400, Payload: []byte("historical secret from a valid bbolt backup")}
	if err := s.SaveLease(ctx, lease); err != nil {
		t.Fatal(err)
	}
	backup := filepath.Join(filepath.Dir(path), "old-valid.db")
	if err := s.db.View(func(tx *bolt.Tx) error { return tx.CopyFile(backup, 0600) }); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteLease(ctx, lease.ID); err != nil {
		t.Fatal(err)
	}
	old, err := Open(backup, master, "connector", s.keys)
	if err != nil {
		t.Fatal("legal old snapshot did not open: ", err)
	}
	defer old.Close()
	if _, err = old.LoadLease(ctx, lease.ID, scope); !errors.Is(err, ErrPackageExpired) {
		t.Fatal("long-term journal master or valid old pages restored a deleted package key")
	}
}

type failingDeleteKeys struct{ PackageKeyStore }

func (failingDeleteKeys) Delete(string) error { return ErrCredentials }
func TestFailedPackageKeyDeletionIsNotReportedAsPayloadRemoval(t *testing.T) {
	s, _, _, scope := storeFixture(t)
	ctx := context.Background()
	now := time.Now().Unix()
	lease := mutationrunner.Lease{ID: "delete-failure", Scope: scope, Commitment: "opaque", ExpiresAt: now + 120, ReconciliationExpiresAt: now + 86400, Payload: []byte("still protected evidence")}
	if err := s.SaveLease(ctx, lease); err != nil {
		t.Fatal(err)
	}
	s.keys = failingDeleteKeys{s.keys}
	if err := s.DeleteLease(ctx, lease.ID); err == nil {
		t.Fatal("key deletion failure hidden")
	}
	if err := s.CleanupLeases(ctx, now+121, nil); err == nil {
		t.Fatal("expiry claimed success with a surviving key")
	}
	loaded, err := s.LoadLease(ctx, lease.ID, scope)
	if err != nil || !bytes.Equal(loaded.Payload, lease.Payload) {
		t.Fatal("failed deletion erased its forensic evidence")
	}
}
func TestSystemPackageCleanupOnlyHandlesExactOwnNamespace(t *testing.T) {
	now := time.Now().Unix()
	secrets := fakeSecrets{"unrelated:account": "untouched unrelated credential"}
	id := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	requested := ""
	keys := &SystemPackageKeys{namespace: "owned-test-namespace", secrets: secrets, names: func(prefix string) ([]string, error) { requested = prefix; return []string{prefix + id}, nil }}
	key := bytes.Repeat([]byte{7}, 32)
	if err := keys.Create(id, key, now+60); err != nil {
		t.Fatal(err)
	}
	if err := keys.CleanupExpired(now+61, nil); err != nil {
		t.Fatal(err)
	}
	if requested != "owned-test-namespace:" || secrets["unrelated:account"] != "untouched unrelated credential" {
		t.Fatal("cleanup enumerated or deleted another credential namespace")
	}
	if _, _, err := keys.Get(id); !errors.Is(err, ErrPackageExpired) {
		t.Fatal("expired package key remained usable")
	}
	keys.names = func(string) ([]string, error) { return []string{"unrelated:account"}, nil }
	if keys.CleanupExpired(now+62, nil) == nil || secrets["unrelated:account"] != "untouched unrelated credential" {
		t.Fatal("out-of-namespace enumeration accepted")
	}
}
