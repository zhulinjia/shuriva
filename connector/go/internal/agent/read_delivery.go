package agent

import (
	"context"
	"crypto/ed25519"
	"errors"
	"time"

	"example.com/ai-database-workspace/connector/internal/protocol"
)

// Results are kept only in memory until acknowledged or the task expires.
// Every attempt has a fresh nonce: the platform can safely acknowledge again
// when its earlier response was lost. Never re-execute the database query.
func (c *Client) deliverReadResult(deliveryCtx, readCtx context.Context, task protocol.ReadTask, outcome, payload string, private ed25519.PrivateKey) {
	backoff := 250 * time.Millisecond
	for deliveryCtx.Err() == nil {
		if readCtx.Err() != nil {
			outcome, payload = "failed", "cancelled"
		}
		reply, err := protocol.NewReadResult(task, outcome, payload, private, time.Now())
		if err != nil {
			return
		}
		postCtx, cancelPost := context.WithCancel(deliveryCtx)
		// Interrupt an in-flight successful response when the user cancels.
		// A cancellation acknowledgement itself must use the delivery context.
		stopOnCancel := func() bool { return false }
		if readCtx.Err() == nil {
			stopOnCancel = context.AfterFunc(readCtx, cancelPost)
		}
		err = c.post(postCtx, "/api/connector-agent/read-result", reply, 1, nil,
			"connector-read-v1", "read-result-ack", reply.ConnectorID, reply.TaskID, reply.Nonce, "1")
		stopOnCancel()
		cancelPost()
		if err == nil || deliveryCtx.Err() != nil {
			return
		}
		if readCtx.Err() != nil && outcome != "failed" {
			outcome, payload = "failed", "cancelled"
			continue
		}
		var rejected *APIError
		if errors.As(err, &rejected) && rejected.Status >= 400 && rejected.Status < 500 && rejected.Status != 429 {
			if (rejected.Status == 403 || rejected.Status == 426) && c.readFailure != nil {
				select {
				case c.readFailure <- rejected:
				default:
				}
			}
			return
		}
		timer := time.NewTimer(backoff)
		select {
		case <-deliveryCtx.Done():
			timer.Stop()
			return
		case <-readCtx.Done():
			if outcome != "failed" || payload != "cancelled" {
				timer.Stop()
				outcome, payload = "failed", "cancelled"
				continue
			}
			// Once cancellation has been observed, avoid spinning on its closed
			// context while retrying the cancellation acknowledgement.
			select {
			case <-deliveryCtx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		case <-timer.C:
		}
		if backoff < 2*time.Second {
			backoff *= 2
		}
	}
}
