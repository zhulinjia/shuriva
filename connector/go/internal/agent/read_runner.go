package agent

import (
	"context"
	"errors"
	"sync"
	"time"

	"example.com/ai-database-workspace/connector/internal/datasource"
	"example.com/ai-database-workspace/connector/internal/diagnostics"
	"example.com/ai-database-workspace/connector/internal/protocol"
	"example.com/ai-database-workspace/connector/internal/queryguard"
)

var ErrReadReplay = errors.New("read task was already processed")

// ReadRunner executes at most one locally authorized read at a time. The
// platform feature is opt-in. Transport callers must authenticate cancellation
// and recheck platform authorization before publishing results.
type ReadRunner struct {
	config     Config
	identities Vault
	sources    datasource.Vault
	permit     chan struct{}
	activeMu   sync.Mutex
	active     *activeRead
}

type activeRead struct {
	task   protocol.ReadTask
	cancel context.CancelFunc
}

func NewReadRunner(config Config, identities Vault, sources datasource.Vault) *ReadRunner {
	return &ReadRunner{config: config, identities: identities, sources: sources, permit: make(chan struct{}, 1)}
}

func (r *ReadRunner) Execute(ctx context.Context, task protocol.ReadTask) (datasource.QueryResult, error) {
	if task.Operation != "read_query" {
		return datasource.QueryResult{}, errors.New("invalid read operation")
	}
	result, err := r.execute(ctx, task)
	if err != nil {
		return datasource.QueryResult{}, err
	}
	query, ok := result.(datasource.QueryResult)
	if !ok {
		return datasource.QueryResult{}, errors.New("invalid read result")
	}
	return query, nil
}

func (r *ReadRunner) ExecuteModelSchema(ctx context.Context, task protocol.ReadTask) (datasource.ModelSchema, error) {
	if task.Operation != "model_schema" {
		return datasource.ModelSchema{}, errors.New("invalid model schema operation")
	}
	if !queryguard.Available() {
		return datasource.ModelSchema{}, datasource.ErrQueryUnsupported
	}
	result, err := r.execute(ctx, task)
	if err != nil {
		return datasource.ModelSchema{}, err
	}
	schema, ok := result.(datasource.ModelSchema)
	if !ok {
		return datasource.ModelSchema{}, errors.New("invalid model schema result")
	}
	return schema, nil
}

type ModelAuthorization struct {
	Database       string                  `json:"database"`
	Tables         []datasource.ModelTable `json:"tables"`
	LeaseExpiresAt int64                   `json:"leaseExpiresAt"`
}

func (r *ReadRunner) ExecuteModelAuthorization(ctx context.Context, task protocol.ReadTask) (ModelAuthorization, error) {
	if task.Operation != "model_authorize" {
		return ModelAuthorization{}, errors.New("invalid authorization operation")
	}
	if !queryguard.Available() {
		return ModelAuthorization{}, datasource.ErrQueryUnsupported
	}
	result, err := r.execute(ctx, task)
	if err != nil {
		return ModelAuthorization{}, err
	}
	value, ok := result.(ModelAuthorization)
	if !ok {
		return ModelAuthorization{}, errors.New("invalid authorization result")
	}
	return value, nil
}

func (r *ReadRunner) execute(ctx context.Context, task protocol.ReadTask) (result any, failure error) {
	started := time.Now()
	defer func() {
		outcome := "success"
		if failure != nil {
			outcome = "failed"
		}
		if errors.Is(failure, context.Canceled) || errors.Is(failure, datasource.ErrQueryCancelled) {
			outcome = "cancelled"
		}
		diagnostics.Record(ctx, diagnostics.Event{Code: "connector.read", Outcome: outcome, ConnectorID: task.ConnectorID, SourceID: task.SourceID, TaskID: task.ID, Duration: time.Since(started)})
	}()
	if ctx.Err() != nil {
		return nil, datasource.ErrQueryCancelled
	}
	select {
	case r.permit <- struct{}{}:
		defer func() { <-r.permit }()
	case <-ctx.Done():
		return nil, datasource.ErrQueryCancelled
	}
	request, err := protocol.VerifyReadTask(task, r.config.ConnectorID, r.config.PlatformPublicKey, time.Now())
	if err != nil {
		return nil, err
	}
	if task.Operation == "model_authorize" {
		now := time.Now().Unix()
		if task.IssuedAt < now-2 || task.IssuedAt > now+2 {
			return nil, errors.New("authorization requires synchronized clocks and prompt delivery")
		}
	}
	bounded, cancel := context.WithDeadline(ctx, time.Unix(task.ExpiresAt, 0))
	defer cancel()
	r.activeMu.Lock()
	r.active = &activeRead{task: task, cancel: cancel}
	r.activeMu.Unlock()
	defer func() { r.activeMu.Lock(); r.active = nil; r.activeMu.Unlock() }()
	if r.identities == nil || r.sources == nil {
		return nil, errors.New("local credential store unavailable")
	}
	// Mark before accessing the database; an uncertain outcome is never replayed.
	if _, err = recordTask(r.identities, r.config.ConnectorID, CompletedTask{ID: task.ID, Signature: task.Signature, ExpiresAt: task.ExpiresAt}, time.Now().Unix()); err != nil {
		return nil, err
	}
	if bounded.Err() != nil {
		if errors.Is(bounded.Err(), context.DeadlineExceeded) {
			return nil, datasource.ErrQueryTimeout
		}
		return nil, datasource.ErrQueryCancelled
	}
	profile, err := r.sources.Get(task.SourceID)
	if bounded.Err() != nil {
		if errors.Is(bounded.Err(), context.DeadlineExceeded) {
			return nil, datasource.ErrQueryTimeout
		}
		return nil, datasource.ErrQueryCancelled
	}
	if err != nil {
		return nil, errors.New("local data source unavailable")
	}
	if profile.ID != task.SourceID {
		return nil, datasource.ErrScope
	}
	if (task.Operation == "read_query" || task.Operation == "model_schema") && request.DelegatedScope != nil {
		restricted, err := datasource.IntersectDelegatedReadScope(profile.ReadScopes[task.WorkspaceID], request.DelegatedScope)
		if err != nil {
			return nil, datasource.ErrScope
		}
		// The task is authenticated before this point. Replace the local copy only;
		// never widen or persist the Connector's own policy.
		profile.ReadScopes = map[string]map[string][]string{task.WorkspaceID: restricted}
	}
	if task.Operation == "model_schema" || task.Operation == "model_authorize" {
		if task.Operation == "model_authorize" {
			if !profile.Allows(task.WorkspaceID) || len(profile.ReadScopes[task.WorkspaceID]) == 0 {
				return nil, datasource.ErrScope
			}
			leases, ok := r.sources.(interface {
				AcquireModelLease(string, string, int64) (datasource.Profile, error)
			})
			if !ok {
				return nil, errors.New("model authorization lease unavailable")
			}
			profile, err = leases.AcquireModelLease(task.SourceID, task.ConnectorID, task.ExpiresAt+3)
			if err != nil {
				return nil, err
			}
		}
		schema, err := datasource.CaptureModelSchema(bounded, profile, task.ConnectorID, task.WorkspaceID)
		if err != nil {
			return nil, err
		}
		if task.Operation == "model_authorize" {
			return ModelAuthorization{Database: schema.Database, Tables: schema.Tables, LeaseExpiresAt: task.ExpiresAt}, nil
		}
		return schema, nil
	}
	params := make([]datasource.QueryParameter, len(request.Parameters))
	for i, param := range request.Parameters {
		params[i] = datasource.QueryParameter{Kind: param.Kind, Value: param.Value}
	}
	if request.SchemaVersion != nil {
		return datasource.ExecuteReadVersioned(bounded, profile, task.ConnectorID, task.WorkspaceID, request.SQL, params, request.MaxRows, *request.SchemaVersion)
	}
	return datasource.ExecuteRead(bounded, profile, task.ConnectorID, task.WorkspaceID, request.SQL, params, request.MaxRows)
}

// Cancel verifies the platform signature and the complete running-task scope.
// Returning true indicates a cancellation signal, not that the database has
// already stopped; the Execute result reports the actual outcome.
func (r *ReadRunner) Cancel(message protocol.ReadCancel) (bool, error) {
	if err := protocol.VerifyReadCancel(message, r.config.ConnectorID, r.config.PlatformPublicKey, time.Now()); err != nil {
		return false, err
	}
	r.activeMu.Lock()
	defer r.activeMu.Unlock()
	if r.active == nil {
		return false, nil
	}
	task := r.active.task
	if message.TaskID != task.ID || message.ActorID != task.ActorID || message.WorkspaceID != task.WorkspaceID || message.SourceID != task.SourceID {
		return false, nil
	}
	r.active.cancel()
	return true, nil
}
