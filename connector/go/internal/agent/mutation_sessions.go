package agent

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"example.com/ai-database-workspace/connector/internal/mutationguard"
	"example.com/ai-database-workspace/connector/internal/mutationmysql"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	"example.com/ai-database-workspace/connector/internal/mutationstore"
)

type MutationProfiles interface {
	Get(string) (mutationstore.Profile, error)
}
type MutationSessionOptions struct {
	ConnectorID       string
	Directory         string
	Profiles          MutationProfiles
	Platform          mutationrunner.Platform
	Clock             mutationrunner.Clock
	PackageKeys       func(string, string) (mutationstore.PackageKeyStore, error)
	NamespaceRegistry mutationstore.PackageNamespaceRegistry
	Controller        func(mutationstore.Profile, mutationmysql.Manifest) (*mutationmysql.Controller, error)
}
type localMutationSource struct {
	profile    mutationstore.Profile
	bundle     mutationmysql.Bundle
	controller *mutationmysql.Controller
	target     *localMutationTarget
}
type localMutationTarget struct {
	journal        *mutationstore.Store
	key            []byte
	epoch          string
	needsRecovery  bool
	drained        bool
	recordCursor   string
	coordinator    *mutationrunner.Coordinator
	gate           chan struct{}
	receiptCursors map[mutationrunner.Scope]string
}
type sourceFlight struct {
	done   chan struct{}
	source *localMutationSource
	err    error
}
type targetFlight struct {
	done   chan struct{}
	target *localMutationTarget
	err    error
}

// LocalMutationSessions owns current-process admission and all pooled targets.
// Restore reads never manufacture a prior process's execution permission.
type LocalMutationSessions struct {
	mu                     sync.Mutex
	bootMu                 sync.Mutex
	options                MutationSessionOptions
	apiBoot, connectorBoot string
	sources                map[string]*localMutationSource
	targets                map[string]*localMutationTarget
	packageKeys            map[string]mutationstore.PackageKeyStore
	sourceLoads            map[string]*sourceFlight
	targetLoads            map[string]*targetFlight
	sessions               map[mutationrunner.Scope]MutationSession
	closed                 bool
	failed                 bool
	lifeCtx                context.Context
	bootCtx                context.Context
	bootCancel             context.CancelFunc
	operations             sync.WaitGroup
	stop                   context.CancelFunc
	cleanup                sync.WaitGroup
}

var ErrMutationRetention = errors.New("mutation package retention cleanup failed")

func MutationJournalPath(directory, connector, target string) string {
	h := sha256.Sum256([]byte(connector + "\x00" + target))
	return filepath.Join(directory, "journal-"+hex.EncodeToString(h[:])+".db")
}
func mutationCommitmentKey(key []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("mutation-preview-commitment-key-v1"))
	return mac.Sum(nil)
}
func NewLocalMutationSessions(ctx context.Context, options MutationSessionOptions) (*LocalMutationSessions, error) {
	if !pairingID.MatchString(options.ConnectorID) || !filepath.IsAbs(options.Directory) || options.Profiles == nil || options.Platform == nil || options.PackageKeys == nil || options.NamespaceRegistry == nil {
		return nil, mutationrunner.ErrDenied
	}
	if options.Clock == nil {
		clock, err := mutationstore.NewClock()
		if err != nil {
			return nil, err
		}
		options.Clock = clock
	}
	if options.Controller == nil {
		options.Controller = func(profile mutationstore.Profile, manifest mutationmysql.Manifest) (*mutationmysql.Controller, error) {
			return mutationmysql.New(profile.Target(), manifest)
		}
	}
	boot, err := mutationmysql.NewEpoch()
	if err != nil {
		return nil, err
	}
	background, stop := context.WithCancel(ctx)
	m := &LocalMutationSessions{options: options, connectorBoot: boot, sources: map[string]*localMutationSource{}, targets: map[string]*localMutationTarget{}, packageKeys: map[string]mutationstore.PackageKeyStore{}, sourceLoads: map[string]*sourceFlight{}, targetLoads: map[string]*targetFlight{}, sessions: map[mutationrunner.Scope]MutationSession{}, lifeCtx: background, stop: stop}
	// Cleanup cannot depend on a readable journal or on the first UI request.
	// The protected index is populated before any independent package key exists.
	namespaces, err := options.NamespaceRegistry.List(options.ConnectorID)
	if err != nil || len(namespaces) > 32 {
		stop()
		return nil, ErrMutationRetention
	}
	for _, identity := range namespaces {
		if _, duplicate := m.packageKeys[identity]; duplicate {
			stop()
			return nil, ErrMutationRetention
		}
		if err = m.rememberPackageNamespace(identity, false); err != nil {
			stop()
			return nil, err
		}
	}
	m.cleanup.Add(1)
	go func() {
		defer m.cleanup.Done()
		timer := time.NewTicker(time.Minute)
		defer timer.Stop()
		for {
			select {
			case <-background.Done():
				return
			case <-timer.C:
				m.cleanLeases(background)
			}
		}
	}()
	return m, nil
}

// Cache before Open: a missing/corrupt journal must not orphan OS credentials.
func (m *LocalMutationSessions) rememberPackageNamespace(identity string, register bool) error {
	m.mu.Lock()
	if keys := m.packageKeys[identity]; keys != nil {
		m.mu.Unlock()
		return nil
	}
	count := len(m.packageKeys)
	m.mu.Unlock()
	decoded, err := hex.DecodeString(identity)
	if err != nil || len(decoded) != 32 || hex.EncodeToString(decoded) != identity || count >= 32 {
		return ErrMutationRetention
	}
	if register && m.options.NamespaceRegistry.Register(m.options.ConnectorID, identity) != nil {
		return ErrMutationRetention
	}
	keys, err := m.options.PackageKeys(m.options.ConnectorID, identity)
	if err != nil || keys == nil {
		return ErrMutationRetention
	}
	m.mu.Lock()
	if len(m.packageKeys) >= 32 {
		m.mu.Unlock()
		return ErrMutationRetention
	}
	m.packageKeys[identity] = keys
	m.mu.Unlock()
	if keys.CleanupExpired(time.Now().Unix(), nil) != nil {
		return ErrMutationRetention
	}
	return nil
}
func (m *LocalMutationSessions) ObserveAPIBoot(_ context.Context, boot string) error {
	if len(boot) != 64 {
		return mutationrunner.ErrDenied
	}
	if _, err := hex.DecodeString(boot); err != nil {
		return mutationrunner.ErrDenied
	}
	m.bootMu.Lock()
	defer m.bootMu.Unlock()
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return mutationrunner.ErrDenied
	}
	if m.apiBoot == boot {
		m.mu.Unlock()
		return nil
	}
	// Stop admission and cancel every old operation before waiting on any
	// single target. No manager-wide mutex is held during this drain.
	m.apiBoot = ""
	if m.bootCancel != nil {
		m.bootCancel()
	}
	previous := m.sessions
	// Keep draining runners visible to lease maintenance. Their executions can
	// still be between commit handoff and recording an unknown outcome, even
	// though admission for the old boot has already stopped.
	for _, session := range previous {
		session.Runner.Stop()
	}
	m.mu.Unlock()
	m.operations.Wait()
	for _, session := range previous {
		session.Runner.Close()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return mutationrunner.ErrDenied
	}
	// No old runner is active now, and the empty boot prevented publishing a
	// replacement while draining. Maintenance may safely stop protecting them.
	m.sessions = map[mutationrunner.Scope]MutationSession{}
	for _, target := range m.targets {
		target.needsRecovery = true
		target.drained = false
		target.recordCursor = ""
		target.receiptCursors = map[mutationrunner.Scope]string{}
	}
	m.bootCtx, m.bootCancel = context.WithCancel(m.lifeCtx)
	m.apiBoot = boot
	return nil
}
func (m *LocalMutationSessions) recoverTarget(ctx context.Context, source *localMutationSource) error {
	target := source.target
	if !target.needsRecovery {
		return nil
	}
	// No admission exists while this gate drains old database transactions.
	if !target.drained {
		current, err := source.controller.ReadGate(ctx)
		if err != nil {
			return err
		}
		next, err := source.controller.Recover(ctx, current)
		if err != nil {
			return err
		}
		target.epoch = next
		target.drained = true
	}
	identity := source.bundle.Manifest.TargetIdentity()
	for page := 0; page < 4; page++ {
		records, cursor, err := target.journal.ListTargetRecords(ctx, identity, target.recordCursor)
		if err != nil {
			return err
		}
		for _, record := range records {
			if record.State == "committed" || record.State == "rolled_back" || record.State == "rejected" {
				if err := target.journal.DeleteOwnedLease(ctx, record.Execution); err != nil {
					return err
				}
				continue
			}
			// An absent receipt is never reauthorization. Even a proven commit
			// only repairs its original fact; it does not remove a prior freeze.
			if record.State != "outcome_unknown" {
				record.State = "outcome_unknown"
				record.Code = "recovery_unproven"
			}
			if deadline, retainErr := mutationrunner.RetainReconciliation(ctx, target.journal, record.Execution, mutationCommitmentKey(target.key)); retainErr == nil && record.ReconciliationExpiresAt == 0 {
				record.ReconciliationExpiresAt = deadline
			}
			if err := target.journal.Transition(ctx, record); err != nil {
				return err
			}
			// A physical target can have several source aliases. Receipt readers
			// enforce their own original source/workspace binding, so recovering
			// through the first alias must not query another scope through it.
			// Load the original trusted local profile without creating a session
			// or granting execution authority, and require the same journal/target.
			receiptSource, readErr := m.source(ctx, record.Execution.Scope)
			var receipt *mutationrunner.Receipt
			if readErr == nil {
				if receiptSource.target != target || receiptSource.target.journal != target.journal || receiptSource.bundle.Manifest.TargetIdentity() != identity || record.Execution.TargetIdentity != identity {
					readErr = mutationrunner.ErrDenied
				} else {
					receipt, readErr = receiptSource.controller.Receipt(ctx, record.Execution.Scope, record.Execution.ExecutionID)
				}
			}
			if readErr == nil && receipt != nil && receipt.Commitment == record.Execution.Commitment && receipt.TargetEpoch == record.Execution.TargetEpoch && receipt.TargetIdentity == identity && receipt.Scope == record.Execution.Scope && receipt.RowCount >= 1 && receipt.RowCount <= mutationguard.MaxRows {
				record.State = "committed"
				record.Code = ""
				record.RowCount = receipt.RowCount
			} else {
				if err := target.journal.Freeze(ctx, identity, "recovery_unproven"); err != nil {
					return err
				}
			}
			if err := target.journal.Transition(ctx, record); err != nil {
				return err
			}
			if record.State == "committed" {
				if err := target.journal.DeleteOwnedLease(ctx, record.Execution); err != nil {
					return err
				}
			}
		}
		if cursor == "" {
			target.needsRecovery = false
			return nil
		}
		target.recordCursor = cursor
	}
	return mutationrunner.ErrFrozen // Retry observes saved progress; no new rotation.
}
func (m *LocalMutationSessions) CurrentAPIBoot() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.apiBoot
}

// Enter the current boot while holding only a short manager lock. Database
// recovery is serialized by physical target, and queue waits honor ctx.
// ObserveAPIBoot stops admission before waiting for operations to drain.
func (m *LocalMutationSessions) enter(ctx context.Context, scope mutationrunner.Scope, boot string, requireHealthy bool) (*localMutationSource, context.Context, func(), error) {
	m.mu.Lock()
	if requireHealthy && m.failed {
		m.mu.Unlock()
		return nil, nil, nil, ErrMutationRetention
	}
	if m.closed || boot == "" || boot != m.apiBoot || m.bootCtx == nil {
		m.mu.Unlock()
		return nil, nil, nil, mutationrunner.ErrDenied
	}
	if err := ctx.Err(); err != nil {
		m.mu.Unlock()
		return nil, nil, nil, err
	}
	operation, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(m.bootCtx, cancel)
	m.operations.Add(1)
	m.mu.Unlock()
	finish := func() { stop(); cancel(); m.operations.Done() }
	source, err := m.source(operation, scope)
	if err != nil {
		finish()
		return nil, nil, nil, err
	}
	select {
	case source.target.gate <- struct{}{}:
		if err := operation.Err(); err != nil {
			<-source.target.gate
			finish()
			return nil, nil, nil, err
		}
		return source, operation, func() { <-source.target.gate; finish() }, nil
	case <-operation.Done():
		finish()
		return nil, nil, nil, operation.Err()
	}
}
func (m *LocalMutationSessions) ForScope(ctx context.Context, scope mutationrunner.Scope, apiBoot string) (MutationSession, error) {
	source, operation, leave, err := m.enter(ctx, scope, apiBoot, true)
	if err != nil {
		return MutationSession{}, err
	}
	defer leave()
	ctx = operation
	m.mu.Lock()
	if m.closed || m.failed || apiBoot != m.apiBoot {
		m.mu.Unlock()
		return MutationSession{}, mutationrunner.ErrDenied
	}
	existing, ok := m.sessions[scope]
	m.mu.Unlock()
	if ok {
		frozen, err := source.target.journal.IsFrozen(ctx, existing.Binding.TargetIdentity)
		if err != nil {
			return MutationSession{}, err
		}
		if frozen {
			existing.BlockedCode = "frozen"
		}
		return existing, nil
	}
	if err = m.recoverTarget(ctx, source); err != nil {
		return MutationSession{}, err
	}
	// Check every receipt page for this scope after the drain. Orphaned target
	// records close admission; they are exposed by the separate read endpoint.
	completed := false
	for page := 0; page < 4; page++ {
		items, err := source.controller.ListReceipts(ctx, scope, source.target.receiptCursors[scope])
		if err != nil {
			return MutationSession{}, err
		}
		for _, receipt := range items {
			record, err := source.target.journal.Get(ctx, receipt.ExecutionID, scope)
			if err != nil || record.Execution.Commitment != receipt.Commitment || record.Execution.TargetIdentity != receipt.TargetIdentity || record.Execution.TargetEpoch != receipt.TargetEpoch {
				if err := source.target.journal.Freeze(ctx, receipt.TargetIdentity, "orphaned_receipt"); err != nil {
					return MutationSession{}, err
				}
			}
		}
		if len(items) < 100 {
			completed = true
			delete(source.target.receiptCursors, scope)
			break
		}
		source.target.receiptCursors[scope] = items[len(items)-1].ExecutionID
	}
	if !completed {
		return MutationSession{}, mutationrunner.ErrFrozen
	}
	policies := map[string]mutationguard.Policy{}
	writeColumns := map[string]MutationWriteColumns{}
	generation := ""
	tables := []string{}
	for _, policy := range source.bundle.Policies {
		if generation != "" && generation != policy.Generation {
			return MutationSession{}, mutationrunner.ErrDenied
		}
		generation = policy.Generation
		policies[policy.Table] = policy
		writeColumns[policy.Table] = MutationWriteColumns{Insert: append([]string{}, policy.InsertColumns...), Update: append([]string{}, policy.UpdateColumns...), Filter: append([]string{}, policy.PreviewColumns...), Delete: policy.Delete}
		tables = append(tables, policy.Table)
	}
	sort.Strings(tables)
	binding := mutationrunner.Binding{Scope: scope, APIBoot: apiBoot, ConnectorBoot: m.connectorBoot, TargetIdentity: source.bundle.Manifest.TargetIdentity(), TargetEpoch: source.target.epoch, PolicyGeneration: generation, InstallationGeneration: source.bundle.Manifest.Spec.Generation}
	runner, err := mutationrunner.New(mutationrunner.Config{Binding: binding, Policies: policies, HMACKey: mutationCommitmentKey(source.target.key), Coordinator: source.target.coordinator}, source.controller, source.target.journal, m.options.Clock, m.options.Platform)
	if err != nil {
		return MutationSession{}, err
	}
	session := MutationSession{Runner: runner, Binding: binding, Tables: tables, WriteColumns: writeColumns}
	frozen, err := source.target.journal.IsFrozen(ctx, binding.TargetIdentity)
	if err != nil {
		runner.Close()
		return MutationSession{}, err
	}
	if frozen {
		session.BlockedCode = "frozen"
	}
	m.mu.Lock()
	if m.closed || m.failed || apiBoot != m.apiBoot || ctx.Err() != nil {
		m.mu.Unlock()
		runner.Close()
		return MutationSession{}, mutationrunner.ErrDenied
	}
	m.sessions[scope] = session
	m.mu.Unlock()
	return session, nil
}
func (m *LocalMutationSessions) RecoveryReceipts(ctx context.Context, scope mutationrunner.Scope, apiBoot, after string) ([]mutationrunner.Receipt, string, error) {
	source, operation, leave, err := m.enter(ctx, scope, apiBoot, false)
	if err != nil {
		return nil, "", err
	}
	defer leave()
	ctx = operation
	if err = m.recoverTarget(ctx, source); err != nil {
		return nil, "", err
	}
	items, err := source.controller.ListReceipts(ctx, scope, after)
	if err != nil {
		return nil, "", err
	}
	next := ""
	if len(items) == 100 {
		next = items[len(items)-1].ExecutionID
	}
	return items, next, nil
}
func (m *LocalMutationSessions) cleanLeases(ctx context.Context) {
	m.cleanLeasesAt(ctx, time.Now().Unix())
}

func (m *LocalMutationSessions) cleanLeasesAt(ctx context.Context, now int64) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	keys := make([]mutationstore.PackageKeyStore, 0, len(m.packageKeys))
	for _, key := range m.packageKeys {
		keys = append(keys, key)
	}
	targets := make([]*localMutationTarget, 0, len(m.targets))
	for _, target := range m.targets {
		targets = append(targets, target)
	}
	m.mu.Unlock()
	failed := false
	for _, key := range keys {
		if ctx.Err() != nil {
			return
		}
		if key.CleanupExpired(now, nil) != nil {
			failed = true
		}
	}
	for _, target := range targets {
		if ctx.Err() != nil {
			return
		}
		// Do not let one slow database recovery block cleanup of other targets.
		// Its short-lived journal leases will be reconsidered on the next tick;
		// independent key hard deadlines were swept above.
		select {
		case target.gate <- struct{}{}:
		default:
			continue
		}
		_, err := target.coordinator.TryMaintenance(func() error {
			// Registration is excluded while taking the snapshot and cleaning;
			// the target gate also excludes publishing a new alias session.
			m.mu.Lock()
			seen := map[string]bool{}
			active := []string{}
			for scope, session := range m.sessions {
				source := m.sources[scope.SourceID]
				if source == nil || source.target != target {
					continue
				}
				for _, id := range session.Runner.ActivePreviewIDs() {
					if !seen[id] {
						seen[id] = true
						active = append(active, id)
					}
				}
			}
			m.mu.Unlock()
			return target.journal.CleanupLeases(ctx, now, active)
		})
		if err != nil {
			failed = true
		}
		<-target.gate
	}
	if failed && ctx.Err() == nil {
		m.retentionFailed(ctx)
	}
}
func (m *LocalMutationSessions) retentionFailed(ctx context.Context) {
	m.mu.Lock()
	m.failed = true
	targets := make(map[string]*localMutationTarget, len(m.targets))
	for identity, target := range m.targets {
		targets[identity] = target
	}
	sessions := make([]MutationSession, 0, len(m.sessions))
	for _, session := range m.sessions {
		session.Runner.Stop()
		sessions = append(sessions, session)
	}
	m.mu.Unlock()
	for identity, target := range targets {
		_ = target.journal.Freeze(context.WithoutCancel(ctx), identity, "lease_cleanup_failed")
	}
	for _, session := range sessions {
		session.Runner.Close()
	}
}
func (m *LocalMutationSessions) Close() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	m.apiBoot = ""
	if m.bootCancel != nil {
		m.bootCancel()
	}
	for _, session := range m.sessions {
		session.Runner.Stop()
	}
	m.mu.Unlock()
	m.stop()
	m.bootMu.Lock()
	defer m.bootMu.Unlock()
	m.cleanup.Wait()
	m.operations.Wait()
	for _, session := range m.sessions {
		session.Runner.Close()
	}
	for _, source := range m.sources {
		_ = source.controller.Close()
	}
	for _, target := range m.targets {
		_ = target.journal.Close()
	}
}

var _ MutationSessions = (*LocalMutationSessions)(nil)
var _ MutationRecoveryReader = (*LocalMutationSessions)(nil)
