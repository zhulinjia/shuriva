package agent

import (
	"context"
	"errors"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/mutationguard"
	"example.com/ai-database-workspace/connector/internal/mutationmysql"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
)

type blockingCommittedTarget struct {
	mutationrunner.Target
	committed chan struct{}
	release   chan struct{}
}

type blockingCommittedTransaction struct {
	mutationrunner.Transaction
	committed chan struct{}
	release   chan struct{}
}

func (t blockingCommittedTarget) Begin(ctx context.Context, binding mutationrunner.Binding) (mutationrunner.Transaction, error) {
	tx, err := t.Target.Begin(ctx, binding)
	if err != nil {
		return nil, err
	}
	return blockingCommittedTransaction{Transaction: tx, committed: t.committed, release: t.release}, nil
}

func (t blockingCommittedTransaction) Commit() error {
	if err := t.Transaction.Commit(); err != nil {
		return err
	}
	close(t.committed)
	<-t.release
	return errors.New("injected lost commit response")
}

func TestMutationCleanupPreservesDrainingBootUnknown(t *testing.T) {
	l := newManagerLab(t)
	m := l.manager(t)
	session, err := m.ForScope(context.Background(), l.scopes[0], l.boot)
	if err != nil {
		t.Fatal(err)
	}
	original := session.Runner
	defer original.Close()
	source := m.sources[session.Binding.SourceID]
	policies := map[string]mutationguard.Policy{}
	for _, policy := range source.bundle.Policies {
		policies[policy.Table] = policy
	}
	committed, release := make(chan struct{}), make(chan struct{})
	released := false
	defer func() {
		if !released {
			close(release)
		}
	}()
	target := source.target
	runner, err := mutationrunner.New(mutationrunner.Config{Binding: session.Binding, Policies: policies, HMACKey: mutationCommitmentKey(target.key), Coordinator: target.coordinator}, blockingCommittedTarget{Target: source.controller, committed: committed, release: release}, target.journal, m.options.Clock, m.options.Platform)
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	session.Runner = runner
	m.sessions[l.scopes[0]] = session
	m.mu.Unlock()
	execution := managerExecution(t, runner)
	finished := make(chan mutationrunner.Result, 1)
	go func() { result, _ := runner.Execute(context.Background(), execution); finished <- result }()
	select {
	case <-committed:
	case <-time.After(10 * time.Second):
		t.Fatal("isolated transaction did not commit")
	}
	next, err := mutationmysql.NewEpoch()
	if err != nil {
		t.Fatal(err)
	}
	bootDone := make(chan error, 1)
	go func() { bootDone <- m.ObserveAPIBoot(context.Background(), next) }()
	deadline := time.Now().Add(5 * time.Second)
	for m.CurrentAPIBoot() != "" {
		if time.Now().After(deadline) {
			t.Fatal("boot transition did not stop admission")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case <-bootDone:
		t.Fatal("boot transition did not wait for in-flight commit")
	default:
	}
	m.cleanLeasesAt(context.Background(), time.Now().Unix()+121)
	if _, err = target.journal.LoadLease(context.Background(), execution.PreviewID, execution.Scope); err != nil {
		t.Fatal("cleanup deleted the draining boot's active preview")
	}
	close(release)
	released = true
	select {
	case result := <-finished:
		if result.State != "outcome_unknown" || result.ReconciliationExpiresAt == "" {
			t.Fatal("lost commit response did not retain unknown outcome")
		}
	case <-time.After(8 * time.Second):
		t.Fatal("execution did not finish")
	}
	select {
	case err = <-bootDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("boot transition did not finish draining")
	}
	if _, err = mutationrunner.RetainReconciliation(context.Background(), target.journal, execution, mutationCommitmentKey(target.key)); err != nil {
		t.Fatal("unknown outcome's recovery package was not authenticated")
	}
}

func TestMutationCleanupPreservesUnknownWithTwoExecutionsForOnePreview(t *testing.T) {
	l := newManagerLab(t)
	m := l.manager(t)
	session, err := m.ForScope(context.Background(), l.scopes[0], l.boot)
	if err != nil {
		t.Fatal(err)
	}
	original := session.Runner
	defer original.Close()
	runner := managerUnknownRunner(t, m, session, true)
	m.mu.Lock()
	managed := m.sessions[l.scopes[0]]
	managed.Runner = runner
	m.sessions[l.scopes[0]] = managed
	m.mu.Unlock()
	first := managerExecution(t, runner)
	second := first
	second.ExecutionID = managerID(t)
	l.platform.blockID = first.ExecutionID
	l.platform.entered, l.platform.release = make(chan struct{}), make(chan struct{})
	released := false
	defer func() {
		if !released {
			close(l.platform.release)
		}
	}()
	firstDone, secondDone := make(chan mutationrunner.Result, 1), make(chan mutationrunner.Result, 1)
	go func() { value, _ := runner.Execute(context.Background(), first); firstDone <- value }()
	select {
	case <-l.platform.entered:
	case <-time.After(10 * time.Second):
		t.Fatal("first operation did not reach permit")
	}
	go func() { value, _ := runner.Execute(context.Background(), second); secondDone <- value }()
	target := m.sources[first.SourceID].target
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := target.journal.Get(context.Background(), second.ExecutionID, second.Scope); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("second operation did not register")
		}
		time.Sleep(time.Millisecond)
	}
	ids := runner.ActivePreviewIDs()
	if len(ids) != 2 || ids[0] != first.PreviewID || ids[1] != first.PreviewID {
		t.Fatal("test did not create duplicate active preview IDs")
	}
	// Simulate the short preview TTL expiring while both executions are active.
	// The shared maintenance section must deduplicate IDs and retain the key.
	m.cleanLeasesAt(context.Background(), time.Now().Unix()+121)
	if frozen, err := target.journal.IsFrozen(context.Background(), first.TargetIdentity); err != nil || frozen {
		t.Fatal("duplicate active IDs caused a false freeze")
	}
	if _, err := target.journal.LoadLease(context.Background(), first.PreviewID, first.Scope); err != nil {
		t.Fatal("active preview package was deleted")
	}
	close(l.platform.release)
	released = true
	select {
	case result := <-firstDone:
		if result.State != "outcome_unknown" || result.ReconciliationExpiresAt == "" {
			t.Fatal("lost commit response did not retain original unknown")
		}
	case <-time.After(8 * time.Second):
		t.Fatal("first operation did not finish")
	}
	select {
	case result := <-secondDone:
		if result.State != "rejected" || result.Code != "frozen" {
			t.Fatalf("second execution was not refused: %s/%s", result.State, result.Code)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("second operation did not finish")
	}
	if _, err := target.journal.LoadLease(context.Background(), first.PreviewID, first.Scope); err != nil {
		t.Fatal("second rejected execution deleted the unknown recovery package")
	}
	if _, err := mutationrunner.RetainReconciliation(context.Background(), target.journal, first, mutationCommitmentKey(target.key)); err != nil {
		t.Fatal("original unknown package no longer authenticated")
	}
}

func TestMutationCleanupBeforeRegistrationPreventsExpiredPreviewExecution(t *testing.T) {
	l := newManagerLab(t)
	m := l.manager(t)
	session, err := m.ForScope(context.Background(), l.scopes[0], l.boot)
	if err != nil {
		t.Fatal(err)
	}
	execution := managerExecution(t, session.Runner)
	target := m.sources[execution.SourceID].target
	l.platform.blockID = execution.ExecutionID
	l.platform.entered, l.platform.release = make(chan struct{}), make(chan struct{})
	defer close(l.platform.release)
	inside, proceed, cleaned := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		_, err := target.coordinator.TryMaintenance(func() error {
			close(inside)
			<-proceed
			return target.journal.CleanupLeases(context.Background(), time.Now().Unix()+121, nil)
		})
		cleaned <- err
	}()
	select {
	case <-inside:
	case <-time.After(time.Second):
		t.Fatal("maintenance did not acquire coordinator")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan mutationrunner.Result, 1)
	go func() { result, _ := session.Runner.Execute(ctx, execution); finished <- result }()
	select {
	case <-l.platform.entered:
		close(proceed)
		t.Fatal("execution passed registration during cleanup")
	case <-time.After(80 * time.Millisecond):
	}
	close(proceed)
	if err := <-cleaned; err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-finished:
		if result.State != "rejected" || result.Code != "preview_invalid" {
			t.Fatalf("expired preview was not rejected: %s/%s", result.State, result.Code)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("execution did not finish")
	}
	if _, err := target.journal.LoadLease(context.Background(), execution.PreviewID, execution.Scope); !errors.Is(err, mutationrunner.ErrNotFound) {
		t.Fatal("expired preview package not removed")
	}
	var label string
	if err := l.f.Admin.QueryRow("SELECT label FROM " + managerIdent(l.manifest.Spec.Catalog) + ".orders WHERE id=1").Scan(&label); err != nil || label != "before" {
		t.Fatal("expired preview changed isolated business data")
	}
}

func TestMutationRecoveryDoesNotDeleteAnotherExecutionsUnknownPackage(t *testing.T) {
	l := newManagerLab(t)
	m := l.manager(t)
	session, err := m.ForScope(context.Background(), l.scopes[0], l.boot)
	if err != nil {
		t.Fatal(err)
	}
	original := session.Runner
	defer original.Close()
	runner := managerUnknownRunner(t, m, session, false)
	m.mu.Lock()
	managed := m.sessions[l.scopes[0]]
	managed.Runner = runner
	m.sessions[l.scopes[0]] = managed
	m.mu.Unlock()
	first := managerExecution(t, runner)
	// Sort the non-owner rejected record before the unknown owner to exercise
	// recovery ordering without relying on random UUID order.
	first.ExecutionID = "ffffffff-ffff-4fff-8fff-ffffffffffff"
	second := first
	second.ExecutionID = "00000000-0000-4000-8000-000000000000"
	l.platform.blockID = first.ExecutionID
	l.platform.entered, l.platform.release = make(chan struct{}), make(chan struct{})
	released := false
	defer func() {
		if !released {
			close(l.platform.release)
		}
	}()
	firstDone, secondDone := make(chan mutationrunner.Result, 1), make(chan mutationrunner.Result, 1)
	go func() { result, _ := runner.Execute(context.Background(), first); firstDone <- result }()
	select {
	case <-l.platform.entered:
	case <-time.After(10 * time.Second):
		t.Fatal("first operation did not reach permit")
	}
	go func() { result, _ := runner.Execute(context.Background(), second); secondDone <- result }()
	target := m.sources[first.SourceID].target
	until := time.Now().Add(5 * time.Second)
	for {
		if _, err := target.journal.Get(context.Background(), second.ExecutionID, second.Scope); err == nil {
			break
		}
		if time.Now().After(until) {
			t.Fatal("second did not register")
		}
		time.Sleep(time.Millisecond)
	}
	close(l.platform.release)
	released = true
	firstResult, secondResult := <-firstDone, <-secondDone
	if firstResult.State != "outcome_unknown" || secondResult.State != "rejected" {
		t.Fatal("fixture did not produce original unknown and rejected non-owner")
	}
	m.Close()
	restarted := l.manager(t)
	newSession, err := restarted.ForScope(context.Background(), l.scopes[0], l.boot)
	if err != nil {
		t.Fatal(err)
	}
	if newSession.BlockedCode != "frozen" {
		t.Fatal("unknown operation was automatically unfrozen")
	}
	reopened := restarted.sources[first.SourceID].target
	lease, err := reopened.journal.LoadLease(context.Background(), first.PreviewID, first.Scope)
	if err != nil || lease.ReconciliationExpiresAt <= time.Now().Unix() {
		t.Fatal("recovery deleted original unknown package while processing another execution")
	}
	if _, err = mutationrunner.RetainReconciliation(context.Background(), reopened.journal, first, mutationCommitmentKey(reopened.key)); err != nil {
		t.Fatal("unknown package lost its original authentication")
	}
}
