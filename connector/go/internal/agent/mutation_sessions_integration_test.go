package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/mutationguard"
	"example.com/ai-database-workspace/connector/internal/mutationmysql"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	"example.com/ai-database-workspace/connector/internal/mutationstore"
	"example.com/ai-database-workspace/connector/internal/protocol"
	"example.com/ai-database-workspace/connector/internal/testmysql"
)

type managerProfiles struct {
	values map[string]mutationstore.Profile
	calls  atomic.Int32
}

func (p *managerProfiles) Get(id string) (mutationstore.Profile, error) {
	p.calls.Add(1)
	value, ok := p.values[id]
	if !ok {
		return value, mutationstore.ErrCredentials
	}
	return value, nil
}

type managerPlatform struct {
	mu               sync.Mutex
	claims           map[string]mutationrunner.Execution
	blockID          string
	entered, release chan struct{}
}

func (p *managerPlatform) Claim(ctx context.Context, e mutationrunner.Execution) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.claims[e.ExecutionID]; ok {
		return mutationrunner.ErrConsumed
	}
	p.claims[e.ExecutionID] = e
	return nil
}
func (p *managerPlatform) Permit(ctx context.Context, r mutationrunner.PermitRequest) (mutationrunner.Permit, error) {
	p.mu.Lock()
	registered, ok := p.claims[r.ExecutionID]
	block := p.blockID == r.ExecutionID
	p.mu.Unlock()
	if !ok || registered != r.Execution {
		return mutationrunner.Permit{}, mutationrunner.ErrDenied
	}
	if block {
		close(p.entered)
		select {
		case <-p.release:
		case <-ctx.Done():
			return mutationrunner.Permit{}, ctx.Err()
		}
	}
	id, _ := newID()
	return mutationrunner.Permit{PermitRequest: r, PermitID: id, BudgetMillis: 3000}, nil
}

type managerLab struct {
	f               *testmysql.Fixture
	manifest        mutationmysql.Manifest
	profiles        *managerProfiles
	options         MutationSessionOptions
	platform        *managerPlatform
	keys            mutationstore.PackageKeyStore
	scopes          [2]mutationrunner.Scope
	boot            string
	journalPath     string
	journalBefore   []byte
	controllerCalls atomic.Int32
}

func managerID(t *testing.T) string {
	t.Helper()
	id, err := newID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
func managerIdent(value string) string              { return "`" + value + "`" }
func managerAccount(a mutationmysql.Account) string { return "'" + a.User + "'@'" + a.Host + "'" }
func newManagerLab(t *testing.T) *managerLab {
	t.Helper()
	f := testmysql.New(t)
	catalog := "stage8_g2_" + f.Suffix
	writer := mutationmysql.Account{User: "s8g2_" + f.Suffix + "_mw", Host: "127.0.0.1"}
	recoverer := mutationmysql.Account{User: "s8g2_" + f.Suffix + "_mr", Host: "127.0.0.1"}
	incarnation, _ := mutationmysql.NewEpoch()
	generation, _ := mutationmysql.NewEpoch()
	secret, _ := mutationmysql.NewEpoch()
	plan, err := mutationmysql.BuildInstallation(mutationmysql.InstallSpec{Catalog: catalog, Tables: []string{"orders"}, Writer: writer, Recovery: recoverer, Incarnation: incarnation, Generation: generation})
	if err != nil {
		t.Fatal(err)
	}
	f.Exec(t, "CREATE DATABASE "+managerIdent(catalog)+" CHARACTER SET utf8mb4 COLLATE utf8mb4_bin")
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		for _, schema := range []string{plan.ControlCatalog, catalog} {
			if _, err := f.Admin.ExecContext(ctx, "DROP DATABASE IF EXISTS "+managerIdent(schema)); err != nil {
				t.Error("cannot clean owned manager schema")
			}
		}
		for _, a := range []mutationmysql.Account{writer, recoverer, plan.Definer} {
			if _, err := f.Admin.ExecContext(ctx, "DROP USER IF EXISTS "+managerAccount(a)); err != nil {
				t.Error("cannot clean owned manager account")
			}
		}
	})
	f.Exec(t, "CREATE TABLE "+managerIdent(catalog)+".orders(id BIGINT PRIMARY KEY AUTO_INCREMENT,tenant VARCHAR(20) NOT NULL DEFAULT 'east',label VARCHAR(64) NOT NULL) ENGINE=InnoDB")
	f.Exec(t, "INSERT INTO "+managerIdent(catalog)+".orders(label)VALUES('before')")
	for _, a := range []mutationmysql.Account{writer, recoverer} {
		f.Exec(t, "CREATE USER "+managerAccount(a)+" IDENTIFIED BY '"+secret+"'")
	}
	for _, sql := range plan.Statements {
		f.Exec(t, sql)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	manifest, err := mutationmysql.CaptureInstallation(ctx, f.Admin, plan)
	if err != nil {
		t.Fatal(err)
	}
	connector, owner := managerID(t), managerID(t)
	var scopes [2]mutationrunner.Scope
	for i := range scopes {
		scopes[i] = mutationrunner.Scope{OwnerID: owner, ConnectorID: connector, WorkspaceID: managerID(t), SourceID: managerID(t)}
	}
	macRaw, _ := mutationstore.NewKey()
	mac, _ := mutationstore.DecodeKey(macRaw)
	rootKeyRaw, _ := mutationstore.NewKey()
	rootKey, _ := mutationstore.DecodeKey(rootKeyRaw)
	directory := t.TempDir()
	artifact := filepath.Join(directory, "bundle.json")
	policy := mutationguard.Policy{Database: catalog, Table: "orders", InsertColumns: []string{"id", "tenant", "label"}, UpdateColumns: []string{"label"}, PreviewColumns: []string{"id", "tenant", "label"}, Delete: true, RowPredicates: []mutationguard.Predicate{{Column: "tenant", Operator: "eq", Value: &mutationguard.Value{Kind: "string", Value: "east"}}}, MaxRows: 20, MaxBytes: 1 << 20, Generation: generation}
	bundleRaw, err := mutationmysql.SealBundle(mutationmysql.Bundle{Manifest: manifest, Policies: []mutationguard.Policy{policy}}, mac)
	if err != nil || mutationstore.WriteProtectedArtifact(artifact, bundleRaw) != nil {
		t.Fatal("cannot create private test installation artifact")
	}
	profiles := &managerProfiles{values: map[string]mutationstore.Profile{}}
	for _, scope := range scopes {
		profiles.values[scope.SourceID] = mutationstore.Profile{SourceID: scope.SourceID, ConnectorID: connector, WorkspaceIDs: []string{scope.WorkspaceID}, Writer: mutationstore.Credential{Host: "127.0.0.1", Port: 13308, Database: catalog, Username: writer.User, Password: secret, TLS: "local"}, Recovery: mutationstore.Credential{Host: "127.0.0.1", Port: 13308, Database: catalog, Username: recoverer.User, Password: secret, TLS: "local"}, ManifestPath: artifact, ManifestMACKey: macRaw, JournalKey: rootKeyRaw}
	}
	keys := mutationstore.NewMemoryPackageKeys()
	journalPath := MutationJournalPath(directory, connector, manifest.TargetIdentity())
	store, err := mutationstore.Create(journalPath, rootKey, connector, keys)
	if err != nil {
		t.Fatal(err)
	}
	if store.Close() != nil {
		t.Fatal("cannot close initial journal")
	}
	before, err := os.ReadFile(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	platform := &managerPlatform{claims: map[string]mutationrunner.Execution{}}
	l := &managerLab{f: f, manifest: manifest, profiles: profiles, platform: platform, keys: keys, scopes: scopes, journalPath: journalPath, journalBefore: before}
	l.options = MutationSessionOptions{ConnectorID: connector, Directory: directory, Profiles: profiles, Platform: platform, NamespaceRegistry: mutationstore.NewMemoryPackageNamespaces(), PackageKeys: func(c, target string) (mutationstore.PackageKeyStore, error) {
		if c != connector || target != manifest.TargetIdentity() {
			return nil, mutationstore.ErrCredentials
		}
		return keys, nil
	}, Controller: func(p mutationstore.Profile, m mutationmysql.Manifest) (*mutationmysql.Controller, error) {
		l.controllerCalls.Add(1)
		return mutationmysql.NewWithDatabases(p.Target(), m, f.Open(t, p.Writer.Username, secret), f.Open(t, p.Recovery.Username, secret))
	}}
	l.boot, _ = mutationmysql.NewEpoch()
	return l
}
func (l *managerLab) manager(t *testing.T) *LocalMutationSessions {
	t.Helper()
	m, err := NewLocalMutationSessions(context.Background(), l.options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	if err = m.ObserveAPIBoot(context.Background(), l.boot); err != nil {
		t.Fatal(err)
	}
	return m
}
func managerPlan() mutationguard.Plan {
	return mutationguard.Plan{Operation: "update", Table: "orders", Changes: []mutationguard.Assignment{{Column: "label", Value: mutationguard.Value{Kind: "string", Value: "after"}}}, Where: []mutationguard.Predicate{{Column: "id", Operator: "eq", Value: &mutationguard.Value{Kind: "integer", Value: "1"}}}}
}
func managerExecution(t *testing.T, r *mutationrunner.Runner) mutationrunner.Execution {
	t.Helper()
	preview, err := r.Preview(context.Background(), managerPlan())
	if err != nil {
		t.Fatal(err)
	}
	return mutationrunner.Execution{Binding: preview.Binding, ExecutionID: managerID(t), PreviewID: preview.PreviewID, Commitment: preview.Commitment, Revision: preview.Revision}
}

type managerLostTarget struct {
	mutationrunner.Target
	commit bool
}
type managerLostTx struct {
	mutationrunner.Transaction
	commit bool
}

func (t managerLostTarget) Begin(ctx context.Context, b mutationrunner.Binding) (mutationrunner.Transaction, error) {
	tx, err := t.Target.Begin(ctx, b)
	if err != nil {
		return nil, err
	}
	return managerLostTx{Transaction: tx, commit: t.commit}, nil
}
func (t managerLostTx) Commit() error {
	if t.commit {
		if err := t.Transaction.Commit(); err != nil {
			return err
		}
	} else {
		if err := t.Transaction.Rollback(); err != nil {
			return err
		}
	}
	return errors.New("injected ambiguous target reply")
}
func managerUnknownRunner(t *testing.T, m *LocalMutationSessions, session MutationSession, commit bool) *mutationrunner.Runner {
	t.Helper()
	source := m.sources[session.Binding.SourceID]
	policies := map[string]mutationguard.Policy{}
	for _, p := range source.bundle.Policies {
		policies[p.Table] = p
	}
	r, err := mutationrunner.New(mutationrunner.Config{Binding: session.Binding, Policies: policies, HMACKey: mutationCommitmentKey(source.target.key), Coordinator: source.target.coordinator}, managerLostTarget{Target: source.controller, commit: commit}, source.target.journal, m.options.Clock, m.options.Platform)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	return r
}

func TestMutationManagerRestartRepairsReceiptAndPreservesUnknown(t *testing.T) {
	for _, committed := range []bool{true, false} {
		t.Run(map[bool]string{true: "receipt-proves-commit", false: "missing-receipt-stays-unknown"}[committed], func(t *testing.T) {
			l := newManagerLab(t)
			first := l.manager(t)
			session, err := first.ForScope(context.Background(), l.scopes[0], l.boot)
			if err != nil {
				t.Fatal(err)
			}
			r := managerUnknownRunner(t, first, session, committed)
			e := managerExecution(t, r)
			unknown, err := r.Execute(context.Background(), e)
			if !errors.Is(err, mutationrunner.ErrUnknown) || unknown.State != "outcome_unknown" || unknown.Code != "commit_unproven" || unknown.ReconciliationExpiresAt == "" {
				t.Fatalf("invalid unknown setup: %+v %v", unknown, err)
			}
			r.Close()
			first.Close()
			restarted := l.manager(t)
			current, err := restarted.ForScope(context.Background(), l.scopes[0], l.boot)
			if err != nil {
				t.Fatal("restored unknown blocked receipt lookup:", err)
			}
			if current.Binding.ConnectorBoot == e.ConnectorBoot || current.Binding.TargetEpoch == e.TargetEpoch {
				t.Fatal("restart reused execution epoch")
			}
			record, err := restarted.sources[e.SourceID].target.journal.Get(context.Background(), e.ExecutionID, e.Scope)
			if err != nil {
				t.Fatal(err)
			}
			if current.BlockedCode != "frozen" {
				t.Fatal("a restored unknown silently unfroze the target")
			}
			if record.ReconciliationExpiresAt == 0 || time.Unix(record.ReconciliationExpiresAt, 0).UTC().Format(time.RFC3339) != unknown.ReconciliationExpiresAt {
				t.Fatal("restart renewed or lost the fixed reconciliation limit")
			}
			if committed {
				if record.State != "committed" || record.Code != "" || record.RowCount != 1 {
					t.Fatalf("real receipt did not repair original result: %+v", record)
				}
				if _, err := restarted.sources[e.SourceID].target.journal.LoadLease(context.Background(), e.PreviewID, e.Scope); !errors.Is(err, mutationrunner.ErrNotFound) {
					t.Fatal("known committed recovery retained unnecessary raw payload")
				}
			} else {
				if record.State != "outcome_unknown" || record.Code != unknown.Code {
					t.Fatalf("unknown restart changed immutable code or result: %+v", record)
				}
				if _, err := restarted.sources[e.SourceID].target.journal.LoadLease(context.Background(), e.PreviewID, e.Scope); err != nil {
					t.Fatal("live reconciliation package was lost during restart", err)
				}
			}
			var label string
			if err := l.f.Admin.QueryRow("SELECT label FROM " + managerIdent(l.manifest.Spec.Catalog) + ".orders WHERE id=1").Scan(&label); err != nil {
				t.Fatal(err)
			}
			want := "before"
			if committed {
				want = "after"
			}
			if label != want {
				t.Fatal("restart retried or changed an old business operation")
			}
		})
	}
}

func TestMutationManagerCanonicalAliasesShareJournalAndFreeze(t *testing.T) {
	l := newManagerLab(t)
	m := l.manager(t)
	one, err := m.ForScope(context.Background(), l.scopes[0], l.boot)
	if err != nil {
		t.Fatal(err)
	}
	two, err := m.ForScope(context.Background(), l.scopes[1], l.boot)
	if err != nil {
		t.Fatal(err)
	}
	a, b := m.sources[l.scopes[0].SourceID].target, m.sources[l.scopes[1].SourceID].target
	if a != b || a.journal != b.journal || one.Binding.TargetEpoch != two.Binding.TargetEpoch || len(m.targets) != 1 {
		t.Fatal("source aliases created independent journal/gate authorities")
	}
	r := managerUnknownRunner(t, m, one, true)
	first, second := managerExecution(t, r), managerExecution(t, two.Runner)
	l.platform.blockID = first.ExecutionID
	l.platform.entered = make(chan struct{})
	l.platform.release = make(chan struct{})
	firstDone, secondDone := make(chan mutationrunner.Result, 1), make(chan mutationrunner.Result, 1)
	go func() { result, _ := r.Execute(context.Background(), first); firstDone <- result }()
	<-l.platform.entered
	go func() { result, _ := two.Runner.Execute(context.Background(), second); secondDone <- result }()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := a.journal.Get(context.Background(), second.ExecutionID, second.Scope); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("alias execution was not locally registered")
		}
		time.Sleep(time.Millisecond)
	}
	l.platform.mu.Lock()
	claims := len(l.platform.claims)
	l.platform.mu.Unlock()
	if claims != 1 {
		t.Fatal("alias bypassed shared physical execution coordinator")
	}
	close(l.platform.release)
	if result := <-firstDone; result.State != "outcome_unknown" {
		t.Fatal("first setup did not lose the commit reply")
	}
	if result := <-secondDone; result.State != "rejected" || result.Code != "frozen" {
		t.Fatalf("alias executed after unknown: %+v", result)
	}
	receipt, err := m.sources[second.SourceID].controller.Receipt(context.Background(), second.Scope, second.ExecutionID)
	if err != nil || receipt != nil {
		t.Fatal("frozen alias acquired a committed target effect", err)
	}
}

func TestMutationManagerAliasFirstRecoveryUsesOriginalReceiptScope(t *testing.T) {
	for _, originalProfilePresent := range []bool{true, false} {
		t.Run(map[bool]string{true: "original-profile-proves-receipt", false: "missing-original-profile-stays-unknown"}[originalProfilePresent], func(t *testing.T) {
			l := newManagerLab(t)
			first := l.manager(t)
			a, err := first.ForScope(context.Background(), l.scopes[0], l.boot)
			if err != nil {
				t.Fatal(err)
			}
			r := managerUnknownRunner(t, first, a, true)
			e := managerExecution(t, r)
			unknown, err := r.Execute(context.Background(), e)
			if !errors.Is(err, mutationrunner.ErrUnknown) || unknown.State != "outcome_unknown" {
				t.Fatal("ambiguous real commit setup failed", err)
			}
			r.Close()
			first.Close()
			if !originalProfilePresent {
				delete(l.profiles.values, e.SourceID)
			}
			restarted := l.manager(t)
			b, err := restarted.ForScope(context.Background(), l.scopes[1], l.boot)
			if err != nil {
				t.Fatal("alias-first recovery failed", err)
			}
			target := restarted.sources[l.scopes[1].SourceID].target
			record, err := target.journal.Get(context.Background(), e.ExecutionID, e.Scope)
			if err != nil {
				t.Fatal(err)
			}
			if b.BlockedCode != "frozen" || len(restarted.sessions) != 1 {
				t.Fatal("recovering an original scope manufactured a session or write eligibility")
			}
			if time.Unix(record.ReconciliationExpiresAt, 0).UTC().Format(time.RFC3339) != unknown.ReconciliationExpiresAt {
				t.Fatal("alias recovery changed the fixed reconciliation deadline")
			}
			if originalProfilePresent {
				if record.State != "committed" || record.Code != "" || record.RowCount != 1 {
					t.Fatalf("the first alias could not prove another alias's original commit: %+v", record)
				}
				if original := restarted.sources[e.SourceID]; original == nil || original.target != target {
					t.Fatal("recovery did not resolve the original trusted source to the canonical target")
				}
				if _, err := target.journal.LoadLease(context.Background(), e.PreviewID, e.Scope); !errors.Is(err, mutationrunner.ErrNotFound) {
					t.Fatal("proven commit retained its raw reconciliation package")
				}
			} else if record.State != "outcome_unknown" || record.Code != unknown.Code {
				t.Fatalf("missing original authorization was treated as proof: %+v", record)
			}
			l.platform.mu.Lock()
			claims := len(l.platform.claims)
			l.platform.mu.Unlock()
			if claims != 1 {
				t.Fatal("recovery retried a database mutation")
			}
		})
	}
}

func TestMutationManagerRestoredEmptyJournalFindsOrphanAndFreezes(t *testing.T) {
	l := newManagerLab(t)
	m := l.manager(t)
	session, err := m.ForScope(context.Background(), l.scopes[0], l.boot)
	if err != nil {
		t.Fatal(err)
	}
	e := managerExecution(t, session.Runner)
	if result, err := session.Runner.Execute(context.Background(), e); err != nil || result.State != "committed" {
		t.Fatal("real commit setup failed", err)
	}
	m.Close()
	if err := os.WriteFile(l.journalPath, l.journalBefore, 0600); err != nil {
		t.Fatal("cannot restore this owned disposable journal snapshot")
	}
	restored := l.manager(t)
	session, err = restored.ForScope(context.Background(), l.scopes[0], l.boot)
	if err != nil {
		t.Fatal(err)
	}
	if session.BlockedCode != "frozen" {
		t.Fatal("old valid journal silently restored write eligibility")
	}
	items, _, err := restored.RecoveryReceipts(context.Background(), e.Scope, l.boot, "")
	if err != nil || len(items) != 1 || items[0].ExecutionID != e.ExecutionID || items[0].Commitment != e.Commitment {
		t.Fatal("target enumeration did not discover the lost original execution", err)
	}
	if _, err := session.Runner.Preview(context.Background(), managerPlan()); !errors.Is(err, mutationrunner.ErrFrozen) {
		t.Fatal("orphan discovery automatically unfroze writes")
	}
}

func TestMutationManagerStalePayloadBootRejectedBeforeLoadingCredentials(t *testing.T) {
	profiles := &managerProfiles{values: map[string]mutationstore.Profile{}}
	var calls atomic.Int32
	clock, err := mutationstore.NewClock()
	if err != nil {
		t.Fatal(err)
	}
	connector := managerID(t)
	current := strings.Repeat("a", 64)
	old := strings.Repeat("b", 64)
	m, err := NewLocalMutationSessions(context.Background(), MutationSessionOptions{ConnectorID: connector, Directory: t.TempDir(), Profiles: profiles, Platform: &managerPlatform{claims: map[string]mutationrunner.Execution{}}, Clock: clock, NamespaceRegistry: mutationstore.NewMemoryPackageNamespaces(), PackageKeys: func(string, string) (mutationstore.PackageKeyStore, error) {
		return mutationstore.NewMemoryPackageKeys(), nil
	}, Controller: func(mutationstore.Profile, mutationmysql.Manifest) (*mutationmysql.Controller, error) {
		calls.Add(1)
		return nil, errors.New("must not open")
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if m.ObserveAPIBoot(context.Background(), current) != nil {
		t.Fatal("cannot set current process")
	}
	h := RunnerMutationHandler{Sessions: m}
	scope := mutationrunner.Scope{OwnerID: managerID(t), WorkspaceID: managerID(t), SourceID: managerID(t), ConnectorID: connector}
	for _, operation := range []string{"capability", "preview", "recover"} {
		body := map[string]any{"apiBoot": old}
		if operation == "preview" {
			body["plan"] = managerPlan()
		}
		if operation == "recover" {
			body["after"] = ""
		}
		raw, _ := json.Marshal(body)
		_, _ = h.Handle(context.Background(), protocol.MutationMessage{OwnerID: scope.OwnerID, WorkspaceID: scope.WorkspaceID, SourceID: scope.SourceID, ConnectorID: connector, Operation: operation, Payload: base64.RawURLEncoding.EncodeToString(raw)})
	}
	if calls.Load() != 0 || profiles.calls.Load() != 0 {
		t.Fatal("stale signed task touched credentials or opened a target before boot refusal")
	}
}
