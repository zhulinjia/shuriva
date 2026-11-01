package agent

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	"example.com/ai-database-workspace/connector/internal/mutationstore"
)

type blockedProfiles struct{ entered, release chan struct{} }

func (p *blockedProfiles) Get(_ string) (mutationstore.Profile, error) {
	close(p.entered)
	<-p.release
	return mutationstore.Profile{}, mutationstore.ErrCredentials
}

func TestMutationManagerSlowCredentialLoadDoesNotBlockAnotherTarget(t *testing.T) {
	connector := managerID(t)
	slow := mutationrunner.Scope{OwnerID: managerID(t), WorkspaceID: managerID(t), SourceID: managerID(t), ConnectorID: connector}
	other := mutationrunner.Scope{OwnerID: slow.OwnerID, WorkspaceID: managerID(t), SourceID: managerID(t), ConnectorID: connector}
	profiles := &blockedProfiles{entered: make(chan struct{}), release: make(chan struct{})}
	m, err := NewLocalMutationSessions(context.Background(), MutationSessionOptions{ConnectorID: connector, Directory: t.TempDir(), Profiles: profiles, Platform: &managerPlatform{claims: map[string]mutationrunner.Execution{}}, NamespaceRegistry: mutationstore.NewMemoryPackageNamespaces(), PackageKeys: func(string, string) (mutationstore.PackageKeyStore, error) {
		return mutationstore.NewMemoryPackageKeys(), nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	boot := strings.Repeat("a", 64)
	if m.ObserveAPIBoot(context.Background(), boot) != nil {
		t.Fatal("boot failed")
	}
	m.mu.Lock()
	m.sources[other.SourceID] = &localMutationSource{profile: mutationstore.Profile{SourceID: other.SourceID, ConnectorID: connector, WorkspaceIDs: []string{other.WorkspaceID}}, target: &localMutationTarget{gate: make(chan struct{}, 1)}}
	m.mu.Unlock()
	done := make(chan error, 1)
	go func() {
		_, _, leave, err := m.enter(context.Background(), slow, boot, true)
		if leave != nil {
			leave()
		}
		done <- err
	}()
	select {
	case <-profiles.entered:
	case <-time.After(time.Second):
		t.Fatal("credential read not reached")
	}
	waitCtx, cancelWait := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancelWait()
	if _, _, _, err := m.enter(waitCtx, slow, boot, true); !errors.Is(err, context.DeadlineExceeded) {
		close(profiles.release)
		t.Fatalf("same-source initialization wait was not cancellable: %v", err)
	}
	_, _, leave, err := m.enter(context.Background(), other, boot, true)
	if err != nil {
		t.Fatal(err)
	}
	leave()
	close(profiles.release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("credential read failed to finish")
	}
	m.mu.Lock()
	m.sources = map[string]*localMutationSource{}
	m.mu.Unlock()
}

func TestMutationManagerTargetGateIsolationCancellationCleanupAndClose(t *testing.T) {
	connector := managerID(t)
	scopeA := mutationrunner.Scope{OwnerID: managerID(t), WorkspaceID: managerID(t), SourceID: managerID(t), ConnectorID: connector}
	scopeAlias := mutationrunner.Scope{OwnerID: scopeA.OwnerID, WorkspaceID: managerID(t), SourceID: managerID(t), ConnectorID: connector}
	scopeB := mutationrunner.Scope{OwnerID: scopeA.OwnerID, WorkspaceID: managerID(t), SourceID: managerID(t), ConnectorID: connector}
	keys := &retentionKeys{PackageKeyStore: mutationstore.NewMemoryPackageKeys()}
	m, err := NewLocalMutationSessions(context.Background(), MutationSessionOptions{ConnectorID: connector, Directory: t.TempDir(), Profiles: &managerProfiles{values: map[string]mutationstore.Profile{}}, Platform: &managerPlatform{claims: map[string]mutationrunner.Execution{}}, NamespaceRegistry: mutationstore.NewMemoryPackageNamespaces(), PackageKeys: func(string, string) (mutationstore.PackageKeyStore, error) { return keys, nil }})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	boot := strings.Repeat("a", 64)
	if err = m.ObserveAPIBoot(context.Background(), boot); err != nil {
		t.Fatal(err)
	}
	targetA := &localMutationTarget{gate: make(chan struct{}, 1)}
	targetB := &localMutationTarget{gate: make(chan struct{}, 1)}
	profile := func(s mutationrunner.Scope) mutationstore.Profile {
		return mutationstore.Profile{SourceID: s.SourceID, ConnectorID: connector, WorkspaceIDs: []string{s.WorkspaceID}}
	}
	m.mu.Lock()
	m.sources[scopeA.SourceID] = &localMutationSource{profile: profile(scopeA), target: targetA}
	m.sources[scopeAlias.SourceID] = &localMutationSource{profile: profile(scopeAlias), target: targetA}
	m.sources[scopeB.SourceID] = &localMutationSource{profile: profile(scopeB), target: targetB}
	m.targets[strings.Repeat("c", 64)] = targetA
	m.packageKeys[strings.Repeat("c", 64)] = keys
	m.mu.Unlock()
	_, active, leave, err := m.enter(context.Background(), scopeA, boot, true)
	if err != nil {
		t.Fatal(err)
	}
	// A different alias for the same physical target waits, and its own
	// deadline cancels the wait without granting access.
	deadline, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	if _, _, _, err := m.enter(deadline, scopeAlias, boot, true); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("same-target wait was not cancellable: %v", err)
	}
	// A different target is admitted independently while A is still busy.
	_, _, leaveB, err := m.enter(context.Background(), scopeB, boot, true)
	if err != nil {
		t.Fatal(err)
	}
	leaveB()
	m.cleanLeases(context.Background())
	if keys.calls.Load() == 0 {
		t.Fatal("busy target prevented independent hard-key cleanup")
	}
	// These synthetic targets deliberately have no DB controllers/journals.
	// Production sources own both; remove only these fakes before disposal.
	m.mu.Lock()
	m.sources = map[string]*localMutationSource{}
	m.targets = map[string]*localMutationTarget{}
	m.mu.Unlock()
	closed := make(chan struct{})
	go func() { m.Close(); close(closed) }()
	select {
	case <-active.Done():
	case <-time.After(time.Second):
		t.Fatal("close did not cancel in-flight operation")
	}
	leave()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("close did not drain after operation exit")
	}
}
