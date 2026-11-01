package agent

import (
	"context"
	"crypto/hmac"

	"example.com/ai-database-workspace/connector/internal/mutationmysql"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	"example.com/ai-database-workspace/connector/internal/mutationstore"
)

// Source setup can read the OS vault and protected files. A per-source flight
// prevents duplicate initialization without holding the manager mutex during
// these potentially slow operations. Waiters may cancel independently.
func (m *LocalMutationSessions) source(ctx context.Context, scope mutationrunner.Scope) (*localMutationSource, error) {
	m.mu.Lock()
	if m.closed || m.apiBoot == "" || scope.ConnectorID != m.options.ConnectorID || ctx.Err() != nil {
		m.mu.Unlock()
		return nil, mutationrunner.ErrDenied
	}
	if source := m.sources[scope.SourceID]; source != nil {
		m.mu.Unlock()
		if !source.profile.Allows(scope.ConnectorID, scope.WorkspaceID, scope.SourceID) {
			return nil, mutationrunner.ErrDenied
		}
		return source, nil
	}
	if pending := m.sourceLoads[scope.SourceID]; pending != nil {
		m.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-pending.done:
			if pending.err != nil {
				return nil, pending.err
			}
			if !pending.source.profile.Allows(scope.ConnectorID, scope.WorkspaceID, scope.SourceID) {
				return nil, mutationrunner.ErrDenied
			}
			return pending.source, nil
		}
	}
	if len(m.sources)+len(m.sourceLoads) >= 32 {
		m.mu.Unlock()
		return nil, mutationrunner.ErrDenied
	}
	pending := &sourceFlight{done: make(chan struct{})}
	m.sourceLoads[scope.SourceID] = pending
	m.mu.Unlock()

	source, err := m.loadSource(ctx, scope)
	m.mu.Lock()
	if err == nil && (m.closed || m.apiBoot == "" || ctx.Err() != nil) {
		err = mutationrunner.ErrDenied
	}
	if err == nil {
		m.sources[scope.SourceID] = source
	}
	pending.source, pending.err = source, err
	delete(m.sourceLoads, scope.SourceID)
	close(pending.done)
	m.mu.Unlock()
	if err != nil && source != nil {
		_ = source.controller.Close()
	}
	return source, err
}

func (m *LocalMutationSessions) loadSource(ctx context.Context, scope mutationrunner.Scope) (*localMutationSource, error) {
	profile, err := m.options.Profiles.Get(scope.SourceID)
	if err != nil || !profile.Allows(scope.ConnectorID, scope.WorkspaceID, scope.SourceID) {
		return nil, mutationrunner.ErrDenied
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	mac, err := mutationstore.DecodeKey(profile.ManifestMACKey)
	if err != nil {
		return nil, err
	}
	raw, err := mutationstore.ReadProtectedArtifact(profile.ManifestPath)
	if err != nil {
		return nil, err
	}
	bundle, err := mutationmysql.ParseBundle(raw, mac)
	if err != nil {
		return nil, err
	}
	controller, err := m.options.Controller(profile, bundle.Manifest)
	if err != nil {
		return nil, err
	}
	key, err := mutationstore.DecodeKey(profile.JournalKey)
	if err != nil {
		_ = controller.Close()
		return nil, err
	}
	identity := bundle.Manifest.TargetIdentity()
	target, err := m.loadTarget(ctx, identity, key)
	if err != nil {
		_ = controller.Close()
		return nil, err
	}
	return &localMutationSource{profile: profile, bundle: bundle, controller: controller, target: target}, nil
}

// Source aliases for one physical target must share exactly one journal and
// gate; this flight never waits for a different target's initialization.
func (m *LocalMutationSessions) loadTarget(ctx context.Context, identity string, key []byte) (*localMutationTarget, error) {
	m.mu.Lock()
	if target := m.targets[identity]; target != nil {
		m.mu.Unlock()
		if !hmac.Equal(target.key, key) {
			return nil, mutationrunner.ErrDenied
		}
		return target, nil
	}
	if pending := m.targetLoads[identity]; pending != nil {
		m.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-pending.done:
			if pending.err != nil {
				return nil, pending.err
			}
			if !hmac.Equal(pending.target.key, key) {
				return nil, mutationrunner.ErrDenied
			}
			return pending.target, nil
		}
	}
	if m.closed || len(m.targets)+len(m.targetLoads) >= 32 {
		m.mu.Unlock()
		return nil, mutationrunner.ErrDenied
	}
	pending := &targetFlight{done: make(chan struct{})}
	m.targetLoads[identity] = pending
	m.mu.Unlock()

	var target *localMutationTarget
	err := m.rememberPackageNamespace(identity, true)
	if err != nil {
		m.retentionFailed(ctx)
	}
	if err == nil && ctx.Err() != nil {
		err = ctx.Err()
	}
	if err == nil {
		m.mu.Lock()
		packageKeys := m.packageKeys[identity]
		m.mu.Unlock()
		var journal *mutationstore.Store
		journal, err = mutationstore.Open(MutationJournalPath(m.options.Directory, m.options.ConnectorID, identity), key, m.options.ConnectorID, packageKeys)
		if err == nil {
			target = &localMutationTarget{journal: journal, key: key, needsRecovery: true, coordinator: mutationrunner.NewCoordinator(), gate: make(chan struct{}, 1), receiptCursors: map[mutationrunner.Scope]string{}}
		}
	}
	m.mu.Lock()
	if err == nil && (m.closed || ctx.Err() != nil) {
		err = mutationrunner.ErrDenied
	}
	if err == nil {
		m.targets[identity] = target
	}
	pending.target, pending.err = target, err
	delete(m.targetLoads, identity)
	close(pending.done)
	m.mu.Unlock()
	if err != nil && target != nil {
		_ = target.journal.Close()
	}
	return target, err
}
