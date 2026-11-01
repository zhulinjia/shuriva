package agent

import (
	"context"
	"encoding/json"
	"errors"

	"example.com/ai-database-workspace/connector/internal/mutationguard"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	"example.com/ai-database-workspace/connector/internal/protocol"
)

type MutationSession struct {
	Runner       *mutationrunner.Runner
	Binding      mutationrunner.Binding
	Tables       []string
	BlockedCode  string
	WriteColumns map[string]MutationWriteColumns
}
type MutationWriteColumns struct {
	Insert []string `json:"insert"`
	Update []string `json:"update"`
	Filter []string `json:"filter"`
	Delete bool     `json:"delete"`
}

// Sessions is owned by the local installation manager, never by a browser's
// submitted binding. It creates current-process admission only after recovery.
type MutationSessions interface {
	ObserveAPIBoot(context.Context, string) error
	CurrentAPIBoot() string
	ForScope(context.Context, mutationrunner.Scope, string) (MutationSession, error)
	Close()
}
type MutationRecoveryReader interface {
	RecoveryReceipts(context.Context, mutationrunner.Scope, string, string) ([]mutationrunner.Receipt, string, error)
}
type RunnerMutationHandler struct{ Sessions MutationSessions }

func (h *RunnerMutationHandler) ObserveAPIBoot(ctx context.Context, boot string) error {
	return h.Sessions.ObserveAPIBoot(ctx, boot)
}
func (h *RunnerMutationHandler) Close() { h.Sessions.Close() }
func (h *RunnerMutationHandler) Handle(ctx context.Context, task protocol.MutationMessage) (any, error) {
	scope := mutationrunner.Scope{OwnerID: task.OwnerID, WorkspaceID: task.WorkspaceID, SourceID: task.SourceID, ConnectorID: task.ConnectorID}
	if task.Operation == "recover" {
		var request struct {
			APIBoot string `json:"apiBoot"`
			After   string `json:"after"`
		}
		reader, ok := h.Sessions.(MutationRecoveryReader)
		if !ok || protocol.DecodeMutationPayload(task, &request) != nil {
			return nil, errors.New("mutation recovery unavailable")
		}
		items, next, err := reader.RecoveryReceipts(ctx, scope, request.APIBoot, request.After)
		if err != nil {
			return nil, err
		}
		if items == nil {
			items = []mutationrunner.Receipt{}
		}
		var cursor *string
		if next != "" {
			cursor = &next
		}
		return struct {
			Items      []mutationrunner.Receipt `json:"items"`
			NextCursor *string                  `json:"nextCursor"`
		}{items, cursor}, nil
	}
	expectedBoot := h.Sessions.CurrentAPIBoot()
	if task.Operation == "capability" || task.Operation == "preview" {
		var header map[string]json.RawMessage
		if protocol.DecodeMutationPayload(task, &header) != nil || json.Unmarshal(header["apiBoot"], &expectedBoot) != nil {
			return nil, errors.New("mutation boot missing")
		}
	} else if task.Operation == "execute" {
		var request struct {
			Execution mutationrunner.Execution `json:"execution"`
		}
		if protocol.DecodeMutationPayload(task, &request) != nil {
			return nil, errors.New("mutation execution invalid")
		}
		expectedBoot = request.Execution.APIBoot
	}
	session, err := h.Sessions.ForScope(ctx, scope, expectedBoot)
	if err != nil {
		if task.Operation == "capability" {
			code := "local_configuration_unavailable"
			if errors.Is(err, mutationrunner.ErrFrozen) {
				code = "recovering"
			}
			if errors.Is(err, ErrMutationRetention) {
				code = "retention_cleanup_failed"
			}
			return struct {
				Available bool   `json:"available"`
				Code      string `json:"code"`
			}{false, code}, nil
		}
		return nil, errors.New("mutation source unavailable")
	}
	if session.Runner == nil || session.Binding.Scope != scope {
		return nil, errors.New("invalid mutation session")
	}
	switch task.Operation {
	case "capability":
		var request struct {
			APIBoot string `json:"apiBoot"`
		}
		if protocol.DecodeMutationPayload(task, &request) != nil || request.APIBoot != session.Binding.APIBoot {
			return nil, errors.New("mutation boot refused")
		}
		code := "ready"
		if session.BlockedCode != "" {
			code = session.BlockedCode
		}
		return struct {
			Available              bool                            `json:"available"`
			Code                   string                          `json:"code"`
			ConnectorBoot          string                          `json:"connectorBoot"`
			TargetIdentity         string                          `json:"targetIdentity"`
			Tables                 []string                        `json:"tables"`
			WriteColumns           map[string]MutationWriteColumns `json:"writeColumns"`
			PolicyGeneration       string                          `json:"policyGeneration"`
			InstallationGeneration string                          `json:"installationGeneration"`
			TargetEpoch            string                          `json:"targetEpoch"`
		}{session.BlockedCode == "", code, session.Binding.ConnectorBoot, session.Binding.TargetIdentity, session.Tables, session.WriteColumns, session.Binding.PolicyGeneration, session.Binding.InstallationGeneration, session.Binding.TargetEpoch}, nil
	case "preview":
		var request struct {
			APIBoot string          `json:"apiBoot"`
			Plan    json.RawMessage `json:"plan"`
		}
		if protocol.DecodeMutationPayload(task, &request) != nil || request.APIBoot != session.Binding.APIBoot {
			return nil, errors.New("mutation preview binding refused")
		}
		plan, err := mutationguard.DecodePlan(request.Plan)
		if err != nil {
			return nil, err
		}
		preview, previewErr := session.Runner.Preview(ctx, plan)
		if previewErr != nil {
			return nil, previewErr
		}
		return preview, nil
	case "execute", "status", "cancel":
		var request struct {
			Execution mutationrunner.Execution `json:"execution"`
		}
		if protocol.DecodeMutationPayload(task, &request) != nil || request.Execution.Scope != scope {
			return nil, errors.New("mutation execution scope refused")
		}
		if task.Operation == "execute" {
			if request.Execution.Binding != session.Binding {
				prior, priorErr := session.Runner.Status(ctx, scope, request.Execution.ExecutionID)
				if priorErr == nil && prior.Execution == request.Execution && prior.State != "accepted" && prior.State != "execution_started" && prior.State != "commit_intent" {
					return prior, nil
				}
				session.Runner.Block(context.WithoutCancel(ctx), "recovery_unproven")
				return mutationrunner.Result{Execution: request.Execution, State: "outcome_unknown", Code: "recovery_unproven"}, mutationrunner.ErrUnknown
			}
			value, runErr := session.Runner.Execute(ctx, request.Execution)
			if value.State == "accepted" {
				value.State = "registered"
			}
			if value.State == "execution_started" {
				value.State = "running"
			}
			return value, runErr
		}
		var result mutationrunner.Result
		if task.Operation == "status" {
			result, err = session.Runner.Status(ctx, scope, request.Execution.ExecutionID)
		} else {
			result, err = session.Runner.Cancel(ctx, scope, request.Execution.ExecutionID)
		}
		if result.Execution != request.Execution {
			return nil, errors.New("mutation result binding mismatch")
		}
		if result.State == "" {
			return nil, err
		}
		state := result.State
		if state == "accepted" {
			state = "registered"
		}
		if state == "execution_started" {
			state = "running"
		}
		result.State = state
		return result, nil
	default:
		return nil, errors.New("unsupported mutation operation")
	}
}
