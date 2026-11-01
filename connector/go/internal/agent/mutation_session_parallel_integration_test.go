package agent

import (
	"context"
	"errors"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/mutationmysql"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	"example.com/ai-database-workspace/connector/internal/mutationstore"
)

func TestMutationManagerBootChangeCancelsAndDrainsOldTargetWork(t *testing.T) {
	l := newManagerLab(t)
	m := l.manager(t)
	session, err := m.ForScope(context.Background(), l.scopes[0], l.boot)
	if err != nil {
		t.Fatal(err)
	}
	execution := managerExecution(t, session.Runner)
	l.platform.blockID = execution.ExecutionID
	l.platform.entered = make(chan struct{})
	l.platform.release = make(chan struct{})
	defer close(l.platform.release)
	finished := make(chan mutationrunner.Result, 1)
	go func() { result, _ := session.Runner.Execute(context.Background(), execution); finished <- result }()
	select {
	case <-l.platform.entered:
	case <-time.After(10 * time.Second):
		t.Fatal("old operation did not reach permit")
	}
	next, err := mutationmysql.NewEpoch()
	if err != nil {
		t.Fatal(err)
	}
	bootDone := make(chan error, 1)
	go func() { bootDone <- m.ObserveAPIBoot(context.Background(), next) }()
	select {
	case err = <-bootDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("boot change did not cancel and drain old work")
	}
	select {
	case result := <-finished:
		if result.State == "committed" {
			t.Fatal("old execution committed after cancellation at permit")
		}
	case <-time.After(time.Second):
		t.Fatal("old runner still active after boot transition")
	}
	var label string
	if err = l.f.Admin.QueryRow("SELECT label FROM " + managerIdent(l.manifest.Spec.Catalog) + ".orders WHERE id=1").Scan(&label); err != nil || label != "before" {
		t.Fatal("cancelled old boot changed business data")
	}
	if _, err = m.ForScope(context.Background(), l.scopes[0], l.boot); !errors.Is(err, mutationrunner.ErrDenied) {
		t.Fatal("old API boot regained admission")
	}
}

func TestMutationManagerIndependentRealTargetsDoNotBlock(t *testing.T) {
	a, b := newManagerLab(t), newManagerLab(t)
	// Both independent catalogs use the same Connector identity, while their
	// fixture servers and users are restricted by the explicit test guard.
	scopeB := b.scopes[0]
	scopeB.ConnectorID = a.scopes[0].ConnectorID
	pB := b.profiles.values[scopeB.SourceID]
	pB.ConnectorID = scopeB.ConnectorID
	a.profiles.values[scopeB.SourceID] = pB
	rootKey, err := mutationstore.DecodeKey(pB.JournalKey)
	if err != nil {
		t.Fatal(err)
	}
	journalB, err := mutationstore.Create(MutationJournalPath(a.options.Directory, scopeB.ConnectorID, b.manifest.TargetIdentity()), rootKey, scopeB.ConnectorID, b.keys)
	if err != nil {
		t.Fatal(err)
	}
	if err = journalB.Close(); err != nil {
		t.Fatal(err)
	}
	tracked := &retentionKeys{PackageKeyStore: b.keys}
	a.options.PackageKeys = func(connector, target string) (mutationstore.PackageKeyStore, error) {
		if connector != scopeB.ConnectorID {
			return nil, mutationstore.ErrCredentials
		}
		switch target {
		case a.manifest.TargetIdentity():
			return a.keys, nil
		case b.manifest.TargetIdentity():
			return tracked, nil
		default:
			return nil, mutationstore.ErrCredentials
		}
	}
	a.options.Controller = func(p mutationstore.Profile, manifest mutationmysql.Manifest) (*mutationmysql.Controller, error) {
		fixture := a.f
		if manifest.TargetIdentity() == b.manifest.TargetIdentity() {
			fixture = b.f
		}
		return mutationmysql.NewWithDatabases(p.Target(), manifest, fixture.Open(t, p.Writer.Username, p.Writer.Password), fixture.Open(t, p.Recovery.Username, p.Recovery.Password))
	}
	m := a.manager(t)
	if _, err = m.ForScope(context.Background(), a.scopes[0], a.boot); err != nil {
		t.Fatal(err)
	}
	if _, err = m.ForScope(context.Background(), scopeB, a.boot); err != nil {
		t.Fatal(err)
	}
	boot, err := mutationmysql.NewEpoch()
	if err != nil {
		t.Fatal(err)
	}
	if err = m.ObserveAPIBoot(context.Background(), boot); err != nil {
		t.Fatal(err)
	}
	targetA := m.sources[a.scopes[0].SourceID].target
	targetA.gate <- struct{}{}
	defer func() { <-targetA.gate }()
	ctxA, cancelA := context.WithCancel(context.Background())
	doneA := make(chan error, 1)
	go func() { _, err := m.ForScope(ctxA, a.scopes[0], boot); doneA <- err }()
	doneB := make(chan error, 1)
	go func() { _, err := m.ForScope(context.Background(), scopeB, boot); doneB <- err }()
	select {
	case err = <-doneB:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("independent real target blocked behind unrelated target")
	}
	prior := tracked.calls.Load()
	m.cleanLeases(context.Background())
	if tracked.calls.Load() <= prior {
		t.Fatal("busy target blocked another namespace cleanup")
	}
	cancelA()
	select {
	case err = <-doneA:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("same-target queue did not cancel: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("same-target queue remained blocked")
	}
}
