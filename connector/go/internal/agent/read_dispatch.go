package agent

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"time"

	"example.com/ai-database-workspace/connector/internal/datasource"
	"example.com/ai-database-workspace/connector/internal/protocol"
	"example.com/ai-database-workspace/connector/internal/queryguard"
)

func (c *Client) readInProgress() bool { c.readMu.Lock(); defer c.readMu.Unlock(); return c.reading }

func (c *Client) repeatedRead(task protocol.Task) (bool, error) {
	c.readMu.Lock()
	defer c.readMu.Unlock()
	if !c.reading || c.readTask == nil || c.readTask.ID != task.ID {
		return false, nil
	}
	if c.readTask.Signature != task.Signature {
		return false, errors.New("conflicting read task")
	}
	return true, nil
}

// A subsequent signed task supersedes the prior result delivery. Cancel both
// the database operation and its in-memory delivery before accepting it.
func (c *Client) abandonRead() {
	c.readMu.Lock()
	defer c.readMu.Unlock()
	if c.reading {
		c.readCancel()
		c.readDeliveryStop()
	}
}

// dispatchRead never logs query text, parameters, database errors or results.
func (c *Client) dispatchRead(ctx context.Context, cfg Config, task protocol.Task, private ed25519.PrivateKey) error {
	if c.readRunner == nil {
		return errors.New("read execution unavailable")
	}
	c.readMu.Lock()
	if c.reading {
		c.readMu.Unlock()
		return errors.New("read execution already in progress")
	}
	message := protocol.ReadTask{ID: task.ID, ConnectorID: task.ConnectorID, ActorID: task.ActorID, WorkspaceID: task.WorkspaceID, SourceID: task.SourceID, Operation: task.Operation, Payload: task.Payload, IssuedAt: task.IssuedAt, ExpiresAt: task.ExpiresAt, Nonce: task.Nonce, Protocol: task.Protocol, Signature: task.Signature}
	readCtx, cancel := context.WithCancel(ctx)
	deliveryCtx, stopDelivery := context.WithDeadline(ctx, time.Unix(task.ExpiresAt, 0))
	routing := message
	routing.Payload = ""
	c.reading = true
	c.readTask = &routing
	c.readCancel = cancel
	c.readDeliveryStop = stopDelivery
	c.readWait.Add(1)
	c.readMu.Unlock()
	go func() {
		defer c.readWait.Done()
		defer cancel()
		defer stopDelivery()
		defer func() {
			c.readMu.Lock()
			c.reading = false
			c.readTask = nil
			c.readCancel = nil
			c.readDeliveryStop = nil
			c.readMu.Unlock()
		}()
		var result any
		var err error
		if message.Operation == "model_schema" {
			result, err = c.readRunner.ExecuteModelSchema(readCtx, message)
		} else if message.Operation == "model_authorize" {
			result, err = c.readRunner.ExecuteModelAuthorization(readCtx, message)
		} else {
			result, err = c.readRunner.Execute(readCtx, message)
		}
		// The SQL and parameters are no longer needed after execution.
		message.Payload = ""
		outcome, payload := "ok", ""
		if err != nil {
			outcome = "failed"
			switch {
			case errors.Is(err, ErrReadReplay):
				payload = "outcome_unknown"
			case errors.Is(err, datasource.ErrScope), errors.Is(err, queryguard.ErrDenied):
				payload = "denied"
			case errors.Is(err, datasource.ErrQueryTimeout):
				payload = "timeout"
			case errors.Is(err, datasource.ErrQueryCancelled):
				payload = "cancelled"
			case errors.Is(err, datasource.ErrQueryUnsupported):
				payload = "unavailable"
			case errors.Is(err, datasource.ErrSchemaChanged):
				payload = "schema_changed"
			default:
				payload = "error"
			}
		} else {
			raw, marshalErr := json.Marshal(result)
			if marshalErr != nil {
				outcome, payload = "failed", "error"
			} else {
				payload = protocol.Encode(raw)
			}
		}
		c.deliverReadResult(deliveryCtx, readCtx, message, outcome, payload, private)
	}()
	return nil
}

func (c *Client) cancelRead(ctx context.Context, task protocol.Task, private ed25519.PrivateKey) error {
	if c.readRunner == nil {
		return errors.New("read execution unavailable")
	}
	message := protocol.ReadCancel{TaskID: task.ID, ConnectorID: task.ConnectorID, ActorID: task.ActorID, WorkspaceID: task.WorkspaceID, SourceID: task.SourceID, IssuedAt: task.IssuedAt, ExpiresAt: task.ExpiresAt, Nonce: task.Nonce, Signature: task.Signature}
	if err := protocol.VerifyReadCancel(message, c.readRunner.config.ConnectorID, c.readRunner.config.PlatformPublicKey, time.Now()); err != nil {
		return err
	}
	c.readMu.Lock()
	active := c.readTask
	if active != nil && active.ID == message.TaskID && active.ConnectorID == message.ConnectorID && active.ActorID == message.ActorID && active.WorkspaceID == message.WorkspaceID && active.SourceID == message.SourceID {
		c.readCancel()
		c.readMu.Unlock()
		return nil
	}
	c.readMu.Unlock()
	// A lost result or already-finished task still needs to acknowledge cancellation.
	resultTask := protocol.ReadTask{ID: task.ID, ConnectorID: task.ConnectorID, ActorID: task.ActorID, WorkspaceID: task.WorkspaceID, SourceID: task.SourceID, Nonce: task.Nonce}
	reply, err := protocol.NewReadResult(resultTask, "failed", "cancelled", private, time.Now())
	if err != nil {
		return err
	}
	return c.post(ctx, "/api/connector-agent/read-result", reply, 1, nil, "connector-read-v1", "read-result-ack", reply.ConnectorID, reply.TaskID, reply.Nonce, "1")
}
