package agent

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	"example.com/ai-database-workspace/connector/internal/mutationstore"
)

type retentionKeys struct {
	mutationstore.PackageKeyStore
	calls atomic.Int32
	now   atomic.Int64
	fail  atomic.Bool
}

func (k *retentionKeys) CleanupExpired(now int64, protected []string) error {
	k.calls.Add(1)
	if k.fail.Load() {
		return errors.New("fake credential service unavailable")
	}
	if advanced := k.now.Load(); advanced != 0 {
		now = advanced
	}
	return k.PackageKeyStore.CleanupExpired(now, protected)
}

func TestMutationRetentionStartupDoesNotDependOnJournalOrSourceRequest(t *testing.T) {
	connector, target := managerID(t), strings.Repeat("a", 64)
	registry := mutationstore.NewMemoryPackageNamespaces()
	if registry.Register(connector, target) != nil {
		t.Fatal("cannot seed trusted namespace")
	}
	keys := &retentionKeys{PackageKeyStore: mutationstore.NewMemoryPackageKeys()}
	id, deadline := strings.Repeat("b", 64), time.Now().Unix()+3600
	if keys.Create(id, make([]byte, 32), deadline) != nil {
		t.Fatal("cannot seed package")
	}
	keys.now.Store(deadline + 1)
	profiles := &managerProfiles{values: map[string]mutationstore.Profile{}}
	m, err := NewLocalMutationSessions(context.Background(), MutationSessionOptions{ConnectorID: connector, Directory: t.TempDir(), Profiles: profiles, Platform: &managerPlatform{claims: map[string]mutationrunner.Execution{}}, NamespaceRegistry: registry, PackageKeys: func(c, identity string) (mutationstore.PackageKeyStore, error) {
		if c != connector || identity != target {
			t.Fatal("escaped registered namespace")
		}
		return keys, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if profiles.calls.Load() != 0 || len(m.targets) != 0 || keys.calls.Load() != 1 {
		t.Fatal("startup cleanup depended on opening a target")
	}
	if _, _, err = keys.Get(id); !mutationstore.PackageMissing(err) {
		t.Fatal("orphan expired package key survived startup")
	}
	keys.fail.Store(true)
	m.cleanLeases(context.Background())
	if _, err = m.ForScope(context.Background(), mutationrunner.Scope{}, "irrelevant"); !errors.Is(err, ErrMutationRetention) {
		t.Fatal("retention failure did not close admission")
	}
	if _, err = NewLocalMutationSessions(context.Background(), m.options); !errors.Is(err, ErrMutationRetention) {
		t.Fatal("startup ignored unavailable credential cleanup")
	}
}

func TestMutationRetentionKeepsNamespaceWhenJournalCannotOpen(t *testing.T) {
	l := newManagerLab(t)
	keys := &retentionKeys{PackageKeyStore: l.keys}
	l.options.PackageKeys = func(string, string) (mutationstore.PackageKeyStore, error) { return keys, nil }
	// This is only this test's owned temporary journal; the real target remains
	// guarded by its explicit 13308 manifest throughout fixture setup/cleanup.
	if os.WriteFile(l.journalPath, []byte("corrupt-owned-journal"), 0600) != nil {
		t.Fatal("cannot seed failed journal")
	}
	m := l.manager(t)
	if _, err := m.ForScope(context.Background(), l.scopes[0], l.boot); err == nil {
		t.Fatal("corrupt journal admitted a session")
	}
	if len(m.targets) != 0 || len(m.packageKeys) != 1 {
		t.Fatal("failed Open lost package namespace")
	}
	id, deadline := strings.Repeat("c", 64), time.Now().Unix()+3600
	if keys.Create(id, make([]byte, 32), deadline) != nil {
		t.Fatal("cannot seed orphan package")
	}
	keys.now.Store(deadline + 1)
	m.cleanLeases(context.Background())
	if _, _, err := keys.Get(id); !mutationstore.PackageMissing(err) {
		t.Fatal("failed-open namespace was not swept")
	}
}
