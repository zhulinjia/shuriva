package agent

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"example.com/ai-database-workspace/connector/internal/diagnostics"
	"example.com/ai-database-workspace/connector/internal/mutationguard"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	"example.com/ai-database-workspace/connector/internal/protocol"
)

// Installed only by explicit composition. Ordinary Run keeps this nil during
// G3: neither new code nor a remote message enables production writes.
type MutationHandler interface {
	ObserveAPIBoot(context.Context, string) error
	Handle(context.Context, protocol.MutationMessage) (any, error)
	Close()
}

type mutationDelivery struct{ fingerprint string }

// A retryable poll outage, distinct from an invalid signature or binding.
// Authorization requests still must never be retried after an ambiguous reply.
var ErrMutationTransportUnavailable = errors.New("mutation transport unavailable")

type mutationPacket struct {
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Code   string `json:"code,omitempty"`
}
type mutationRuntime struct {
	mu    sync.Mutex
	tasks map[string]*mutationDelivery
	wait  sync.WaitGroup
}

func mutationResultPacket(result any, err error) mutationPacket {
	if err == nil {
		return mutationPacket{OK: true, Result: result}
	}
	// Only an identified execution fact may survive an error. A zero-value
	// Preview boxed into an interface is not a successful response.
	if fact, ok := result.(mutationrunner.Result); ok && fact.ExecutionID != "" && fact.State != "" {
		return mutationPacket{OK: true, Result: fact}
	}
	code := "unavailable"
	switch {
	case errors.Is(err, mutationrunner.ErrFrozen):
		code = "frozen"
	case errors.Is(err, mutationrunner.ErrDenied), errors.Is(err, mutationguard.ErrDenied):
		code = "denied"
	case errors.Is(err, ErrMutationRetention):
		code = "retention_cleanup_failed"
	}
	return mutationPacket{OK: false, Code: code}
}

// Transport completion is not the same as a committed write. Preserve
// pending/unknown facts in diagnostics so they are never reported as success.
func mutationDiagnosticOutcome(result any, err error) (string, string) {
	if fact, ok := result.(mutationrunner.Result); ok && fact.ExecutionID != "" {
		switch fact.State {
		case "outcome_unknown":
			return "unknown", fact.ExecutionID
		case "registered", "running", "accepted", "execution_started", "commit_intent":
			return "pending", fact.ExecutionID
		case "rejected", "rolled_back":
			return "failed", fact.ExecutionID
		case "committed":
			return "success", fact.ExecutionID
		}
	}
	if errors.Is(err, context.Canceled) {
		return "cancelled", ""
	}
	if errors.Is(err, mutationrunner.ErrDenied) || errors.Is(err, mutationrunner.ErrFrozen) || errors.Is(err, mutationguard.ErrDenied) {
		return "denied", ""
	}
	if err != nil {
		return "failed", ""
	}
	return "success", ""
}

func (c *Client) mutationRequest(ctx context.Context, message protocol.MutationMessage, private ed25519.PrivateKey) (_ protocol.MutationMessage, finalErr error) {
	started := time.Now()
	taskID := message.ID
	if message.Kind == "poll" {
		taskID = ""
	}
	event := diagnostics.Event{Code: "connector.http", ConnectorID: message.ConnectorID, SourceID: message.SourceID, TaskID: taskID}
	defer func() {
		if finalErr != nil && (event.Outcome == "" || event.Outcome == "success") {
			event.Outcome = "failed"
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			event.Outcome = "cancelled"
		}
		event.Duration = time.Since(started)
		diagnostics.Record(ctx, event)
	}()
	protocol.SignMutationMessage(&message, private)
	raw, err := json.Marshal(message)
	if err != nil {
		return protocol.MutationMessage{}, errors.New("invalid mutation request")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Server+"/api/connector-agent/mutations/"+message.Kind, bytes.NewReader(raw))
	if err != nil {
		return protocol.MutationMessage{}, errors.New("invalid mutation request")
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := c.HTTP.Do(request)
	if err != nil {
		event.Outcome = "unavailable"
		return protocol.MutationMessage{}, ErrMutationTransportUnavailable
	}
	event.Outcome, event.RequestID = "success", response.Header.Get("X-Request-Id")
	if response.StatusCode != http.StatusOK {
		event.Outcome = "failed"
		if response.StatusCode == 403 || response.StatusCode == 426 {
			event.Outcome = "denied"
		}
		if response.StatusCode == 429 || response.StatusCode >= 500 {
			event.Outcome = "unavailable"
		}
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 8192))
		return protocol.MutationMessage{}, &APIError{Status: response.StatusCode}
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 2097153))
	decoder.DisallowUnknownFields()
	var reply protocol.MutationMessage
	if decoder.Decode(&reply) != nil {
		return reply, errors.New("invalid mutation reply")
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return reply, errors.New("invalid mutation reply trailing data")
	}
	if protocol.VerifyMutationMessage(reply, message.ConnectorID, c.PlatformKey, time.Now()) != nil || reply.ID != message.ID || reply.OwnerID != message.OwnerID || reply.WorkspaceID != message.WorkspaceID || reply.SourceID != message.SourceID || reply.Operation != message.Operation || reply.ReplyTo != message.Nonce || reply.Kind != message.Kind+"_reply" {
		return protocol.MutationMessage{}, errors.New("mutation reply binding rejected")
	}
	return reply, nil
}

// MutationPlatform never retries a claim or permit after an ambiguous reply.
// The caller freezes/rolls back the same execution instead of obtaining a new ID.
type MutationPlatform struct {
	Client      *Client
	ConnectorID string
	Private     ed25519.PrivateKey
}

func (p *MutationPlatform) call(ctx context.Context, kind string, e mutationrunner.Execution, payload any) (protocol.MutationMessage, error) {
	message, err := protocol.NewMutationMessage(p.ConnectorID, kind, p.Private, time.Now())
	if err != nil {
		return message, err
	}
	message.OwnerID = e.OwnerID
	message.WorkspaceID = e.WorkspaceID
	message.SourceID = e.SourceID
	message.Operation = "execute"
	raw, err := json.Marshal(payload)
	if err != nil {
		return message, errors.New("invalid mutation authorization request")
	}
	message.Payload = protocol.Encode(raw)
	return p.Client.mutationRequest(ctx, message, p.Private)
}
func (p *MutationPlatform) Claim(ctx context.Context, e mutationrunner.Execution) error {
	reply, err := p.call(ctx, "claim", e, e)
	if err != nil {
		return err
	}
	var accepted struct {
		Accepted bool `json:"accepted"`
	}
	if protocol.DecodeMutationPayload(reply, &accepted) != nil || !accepted.Accepted {
		return errors.New("mutation claim refused")
	}
	return nil
}
func (p *MutationPlatform) Permit(ctx context.Context, request mutationrunner.PermitRequest) (mutationrunner.Permit, error) {
	bounded, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
	defer cancel()
	reply, err := p.call(bounded, "permit", request.Execution, request)
	if err != nil {
		return mutationrunner.Permit{}, err
	}
	// The complete object is authenticated by the platform envelope. Keep the
	// inner durable signature explicit, never decode around unknown properties.
	var permit struct {
		mutationrunner.Permit
		Signature string `json:"signature"`
	}
	if protocol.DecodeMutationPayload(reply, &permit) != nil || permit.Signature == "" {
		return mutationrunner.Permit{}, errors.New("invalid mutation permit")
	}
	return permit.Permit, nil
}

func (c *Client) syncMutations(ctx context.Context, cfg Config, private ed25519.PrivateKey) error {
	if c.Mutations == nil {
		return nil
	}
	c.mutationOnce.Do(func() { c.mutations = &mutationRuntime{tasks: map[string]*mutationDelivery{}} })
	runtime := c.mutations
	runtime.mu.Lock()
	active := make([]string, 0, len(runtime.tasks))
	for id := range runtime.tasks {
		active = append(active, id)
	}
	runtime.mu.Unlock()
	message, err := protocol.NewMutationMessage(cfg.ConnectorID, "poll", private, time.Now())
	if err != nil {
		return err
	}
	raw, _ := json.Marshal(struct {
		Active []string `json:"active"`
	}{active})
	message.Payload = protocol.Encode(raw)
	reply, err := c.mutationRequest(ctx, message, private)
	if err != nil {
		return err
	}
	var response struct {
		APIBoot string                    `json:"apiBoot"`
		Task    *protocol.MutationMessage `json:"task"`
	}
	if protocol.DecodeMutationPayload(reply, &response) != nil || len(response.APIBoot) != 64 {
		return errors.New("invalid mutation poll")
	}
	if err = c.Mutations.ObserveAPIBoot(ctx, response.APIBoot); err != nil {
		return errors.New("mutation recovery unavailable")
	}
	if response.Task == nil {
		return nil
	}
	task := *response.Task
	if task.Kind != "task" || protocol.VerifyMutationMessage(task, cfg.ConnectorID, cfg.PlatformPublicKey, time.Now()) != nil {
		return errors.New("invalid mutation task")
	}
	runtime.mu.Lock()
	if previous := runtime.tasks[task.ID]; previous != nil {
		runtime.mu.Unlock()
		if previous.fingerprint != task.Signature {
			return errors.New("conflicting mutation task")
		}
		return nil
	}
	if len(runtime.tasks) >= 8 {
		runtime.mu.Unlock()
		return errors.New("mutation task capacity")
	}
	runtime.tasks[task.ID] = &mutationDelivery{fingerprint: task.Signature}
	runtime.wait.Add(1)
	runtime.mu.Unlock()
	handler := c.Mutations
	go func() {
		defer runtime.wait.Done()
		defer func() { runtime.mu.Lock(); delete(runtime.tasks, task.ID); runtime.mu.Unlock() }()
		operation, stop := context.WithDeadline(ctx, time.Unix(task.ExpiresAt, 0))
		defer stop()
		started := time.Now()
		result, runErr := handler.Handle(operation, task)
		outcome, executionID := mutationDiagnosticOutcome(result, runErr)
		diagnostics.Record(operation, diagnostics.Event{Code: "connector.mutation", Outcome: outcome, ConnectorID: task.ConnectorID, SourceID: task.SourceID, TaskID: task.ID, ExecutionID: executionID, Duration: time.Since(started)})
		packet := mutationResultPacket(result, runErr)
		payload, marshalErr := json.Marshal(packet)
		if marshalErr != nil || len(payload) > protocol.MutationPayloadMax {
			payload, _ = json.Marshal(mutationPacket{OK: false, Code: "preview_too_large"})
		}
		for operation.Err() == nil {
			out, createErr := protocol.NewMutationMessage(cfg.ConnectorID, "result", private, time.Now())
			if createErr != nil {
				return
			}
			out.ID = task.ID
			out.OwnerID = task.OwnerID
			out.WorkspaceID = task.WorkspaceID
			out.SourceID = task.SourceID
			out.Operation = task.Operation
			out.ReplyTo = task.Nonce
			out.Payload = protocol.Encode(payload)
			if _, sendErr := c.mutationRequest(operation, out, private); sendErr == nil {
				return
			}
			timer := time.NewTimer(250 * time.Millisecond)
			select {
			case <-operation.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
	}()
	return nil
}

func (c *Client) closeMutations() {
	if c.Mutations != nil {
		c.Mutations.Close()
	}
	if c.mutations != nil {
		c.mutations.wait.Wait()
	}
}

// CloseMutationTransport drains the explicitly composed mutation adapter.
// The owner must first cancel its Sync context so result delivery can finish.
func (c *Client) CloseMutationTransport() { c.closeMutations() }
