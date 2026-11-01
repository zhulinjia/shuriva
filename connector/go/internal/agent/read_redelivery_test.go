package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/protocol"
)

func TestRepeatedHeartbeatDoesNotCancelOrRerunRead(t *testing.T) {
	public, platform, _ := ed25519.GenerateKey(rand.Reader)
	_, private, _ := ed25519.GenerateKey(rand.Reader)
	id := "22222222-2222-4222-8222-222222222222"
	now := time.Now().Unix()
	payload, _ := json.Marshal(protocol.ReadRequest{SQL: "SELECT id FROM customers", Parameters: []protocol.ReadParameter{}, MaxRows: 1})
	task := protocol.ReadTask{ID: "11111111-1111-4111-8111-111111111111", ConnectorID: id, ActorID: "owner", WorkspaceID: "33333333-3333-4333-8333-333333333333", SourceID: "44444444-4444-4444-8444-444444444444", Operation: "read_query", Payload: protocol.Encode(payload), IssuedAt: now, ExpiresAt: now + 60, Nonce: protocol.Encode(make([]byte, 32)), Protocol: 1}
	task.Signature = protocol.Encode(ed25519.Sign(platform, []byte(strings.Join(protocol.ReadTaskFields(task), "\n"))))
	var conflict atomic.Bool
	resultStarted := make(chan struct{}, 1)
	releaseResult := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/connector-agent/heartbeat" {
			var signed protocol.Signed
			_ = json.NewDecoder(r.Body).Decode(&signed)
			sent := task
			if conflict.Load() {
				sent.Payload = protocol.Encode([]byte(`{"sql":"SELECT id FROM others","parameters":[],"maxRows":1}`))
				sent.Signature = protocol.Encode(ed25519.Sign(platform, []byte(strings.Join(protocol.ReadTaskFields(sent), "\n"))))
			}
			fields := []string{"connector-v1", "heartbeat-ack", id, signed.Nonce, "1"}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "protocol": 1, "task": sent, "signature": protocol.Encode(ed25519.Sign(platform, []byte(strings.Join(fields, "\n"))))})
			return
		}
		if r.URL.Path == "/api/connector-agent/read-result" {
			select {
			case resultStarted <- struct{}{}:
			default:
			}
			<-releaseResult
			return
		}
		w.WriteHeader(500)
	}))
	defer server.Close()
	defer close(releaseResult)
	cfg := Config{ConnectorID: id, PlatformPublicKey: protocol.Encode(public)}
	vault := &memoryVault{data: map[string]KeyState{id: {Active: protocol.Encode(private)}}}
	source := &blockingReadSource{started: make(chan struct{}), resume: make(chan struct{})}
	client, _ := NewClient(server.URL, "test")
	client.PlatformKey = cfg.PlatformPublicKey
	client.readRunner = NewReadRunner(cfg, vault, source)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := syncHeartbeat(ctx, client, cfg, vault, private); err != nil {
		t.Fatal(err)
	}
	select {
	case <-source.started:
	case <-time.After(5 * time.Second):
		t.Fatal("read did not start")
	}
	if err := syncHeartbeat(ctx, client, cfg, vault, private); err != nil {
		t.Fatal(err)
	}
	if !client.readInProgress() {
		t.Fatal("redelivery stopped active read")
	}
	close(source.resume)
	select {
	case <-resultStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("result delivery did not start")
	}
	if err := syncHeartbeat(ctx, client, cfg, vault, private); err != nil {
		t.Fatal(err)
	}
	if !client.readInProgress() {
		t.Fatal("redelivery interrupted result retry")
	}
	conflict.Store(true)
	if err := syncHeartbeat(ctx, client, cfg, vault, private); err == nil {
		t.Fatal("conflicting same-ID task accepted")
	}
	cancel()
	client.readWait.Wait()
	state, _ := vault.Get(id)
	if len(state.Completed) != 1 {
		t.Fatal("task recorded more than once")
	}
}

func TestPreviouslyProcessedReadReportsUnknownOutcome(t *testing.T) {
	public, platform, _ := ed25519.GenerateKey(rand.Reader)
	_, private, _ := ed25519.GenerateKey(rand.Reader)
	id := "22222222-2222-4222-8222-222222222222"
	now := time.Now().Unix()
	payload, _ := json.Marshal(protocol.ReadRequest{SQL: "SELECT id FROM customers", Parameters: []protocol.ReadParameter{}, MaxRows: 1})
	task := protocol.ReadTask{ID: "11111111-1111-4111-8111-111111111111", ConnectorID: id, ActorID: "owner", WorkspaceID: "33333333-3333-4333-8333-333333333333", SourceID: "44444444-4444-4444-8444-444444444444", Operation: "read_query", Payload: protocol.Encode(payload), IssuedAt: now, ExpiresAt: now + 60, Nonce: protocol.Encode(make([]byte, 32)), Protocol: 1}
	task.Signature = protocol.Encode(ed25519.Sign(platform, []byte(strings.Join(protocol.ReadTaskFields(task), "\n"))))
	result := make(chan protocol.ReadResult, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var reply protocol.ReadResult
		_ = json.NewDecoder(r.Body).Decode(&reply)
		result <- reply
		fields := []string{"connector-read-v1", "read-result-ack", reply.ConnectorID, reply.TaskID, reply.Nonce, "1"}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "protocol": 1, "signature": protocol.Encode(ed25519.Sign(platform, []byte(strings.Join(fields, "\n"))))})
	}))
	defer server.Close()
	cfg := Config{ConnectorID: id, PlatformPublicKey: protocol.Encode(public)}
	vault := &memoryVault{data: map[string]KeyState{id: {Active: protocol.Encode(private), Completed: []CompletedTask{{ID: task.ID, Signature: task.Signature, ExpiresAt: task.ExpiresAt}}}}}
	source := &blockingReadSource{started: make(chan struct{}), resume: make(chan struct{})}
	client, _ := NewClient(server.URL, "test")
	client.PlatformKey = cfg.PlatformPublicKey
	client.readRunner = NewReadRunner(cfg, vault, source)
	message := protocol.Task{ID: task.ID, ConnectorID: id, ActorID: task.ActorID, WorkspaceID: task.WorkspaceID, SourceID: task.SourceID, Operation: task.Operation, Payload: task.Payload, IssuedAt: task.IssuedAt, ExpiresAt: task.ExpiresAt, Nonce: task.Nonce, Protocol: 1, Signature: task.Signature}
	if err := client.dispatchRead(context.Background(), cfg, message, private); err != nil {
		t.Fatal(err)
	}
	select {
	case reply := <-result:
		if reply.Payload != "outcome_unknown" || reply.TaskNonce != task.Nonce {
			t.Fatal("replayed task did not report unknown outcome")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no replay result")
	}
	client.readWait.Wait()
	select {
	case <-source.started:
		t.Fatal("replayed task accessed data source")
	default:
	}
}
