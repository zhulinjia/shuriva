package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/protocol"
)

func readDeliveryFixture(t *testing.T, handler func(http.ResponseWriter, *http.Request, protocol.ReadResult, ed25519.PrivateKey)) (*Client, protocol.ReadTask, ed25519.PrivateKey) {
	t.Helper()
	platformPublic, platformPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	connectorPublic, connectorPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var result protocol.ReadResult
		if r.URL.Path != "/api/connector-agent/read-result" || json.NewDecoder(r.Body).Decode(&result) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		sig, err := protocol.Decode(result.Signature, ed25519.SignatureSize)
		if err != nil || !ed25519.Verify(connectorPublic, []byte(strings.Join(protocol.ReadResultFields(result), "\n")), sig) {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		handler(w, r, result, platformPrivate)
	}))
	t.Cleanup(server.Close)
	client, err := NewClient(server.URL, "test")
	if err != nil {
		t.Fatal(err)
	}
	client.PlatformKey = protocol.Encode(platformPublic)
	task := protocol.ReadTask{ID: "11111111-1111-4111-8111-111111111111", ConnectorID: "22222222-2222-4222-8222-222222222222", ActorID: "owner", WorkspaceID: "33333333-3333-4333-8333-333333333333", SourceID: "44444444-4444-4444-8444-444444444444", Nonce: protocol.Encode(make([]byte, 32))}
	return client, task, connectorPrivate
}

func acknowledgeRead(w http.ResponseWriter, result protocol.ReadResult, private ed25519.PrivateKey) {
	fields := []string{"connector-read-v1", "read-result-ack", result.ConnectorID, result.TaskID, result.Nonce, "1"}
	signature := protocol.Encode(ed25519.Sign(private, []byte(strings.Join(fields, "\n"))))
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "protocol": 1, "signature": signature})
}

func TestReadDeliveryRetriesLostAcknowledgementWithFreshNonce(t *testing.T) {
	var mu sync.Mutex
	var received []protocol.ReadResult
	client, task, private := readDeliveryFixture(t, func(w http.ResponseWriter, _ *http.Request, result protocol.ReadResult, key ed25519.PrivateKey) {
		mu.Lock()
		received = append(received, result)
		attempt := len(received)
		mu.Unlock()
		if attempt == 1 {
			// The platform has received the result, but its acknowledgement is lost.
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				_ = conn.Close()
			}
			return
		}
		acknowledgeRead(w, result, key)
	})
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	payload := protocol.Encode([]byte(`{"columns":[],"rows":[]}`))
	client.deliverReadResult(ctx, context.Background(), task, "ok", payload, private)
	mu.Lock()
	defer mu.Unlock()
	if len(received) != 2 || received[0].Nonce == received[1].Nonce || received[0].Payload != payload || received[1].Payload != payload {
		t.Fatal("result retry did not preserve content with fresh nonce")
	}
}

func TestReadDeliveryCancelsInFlightAndDiscardsSuccess(t *testing.T) {
	started := make(chan struct{})
	var mu sync.Mutex
	var received []protocol.ReadResult
	client, task, private := readDeliveryFixture(t, func(w http.ResponseWriter, r *http.Request, result protocol.ReadResult, key ed25519.PrivateKey) {
		mu.Lock()
		received = append(received, result)
		attempt := len(received)
		mu.Unlock()
		if attempt == 1 {
			close(started)
			<-r.Context().Done()
			return
		}
		acknowledgeRead(w, result, key)
	})
	delivery, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	read, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		client.deliverReadResult(delivery, read, task, "ok", protocol.Encode([]byte(`{"rows":[]}`)), private)
	}()
	select {
	case <-started:
	case <-delivery.Done():
		t.Fatal("first result was not sent")
	}
	cancel()
	select {
	case <-done:
	case <-delivery.Done():
		t.Fatal("cancelled result delivery did not finish")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(received) != 2 || received[1].Outcome != "failed" || received[1].Payload != "cancelled" || received[0].Nonce == received[1].Nonce {
		t.Fatal("success was retried after cancellation")
	}
}

func TestReadDeliveryStopsWhenConnectorStopsOrIsRejected(t *testing.T) {
	started := make(chan struct{})
	client, task, private := readDeliveryFixture(t, func(w http.ResponseWriter, r *http.Request, _ protocol.ReadResult, _ ed25519.PrivateKey) {
		close(started)
		<-r.Context().Done()
	})
	delivery, stop := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		client.deliverReadResult(delivery, context.Background(), task, "failed", "error", private)
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("delivery did not start")
	}
	stop()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("delivery did not stop")
	}

	var attempts int
	rejected, rejectedTask, rejectedKey := readDeliveryFixture(t, func(w http.ResponseWriter, _ *http.Request, _ protocol.ReadResult, _ ed25519.PrivateKey) {
		attempts++
		w.WriteHeader(http.StatusForbidden)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rejected.deliverReadResult(ctx, context.Background(), rejectedTask, "failed", "error", rejectedKey)
	if attempts != 1 {
		t.Fatal("revoked identity retried result")
	}
}

func TestReadDeliveryDiscardsResultAtDeadlineDuringOutage(t *testing.T) {
	var attempts atomic.Int32
	client, task, private := readDeliveryFixture(t, func(w http.ResponseWriter, _ *http.Request, _ protocol.ReadResult, _ ed25519.PrivateKey) {
		attempts.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	client.deliverReadResult(ctx, context.Background(), task, "ok", protocol.Encode([]byte(`{"rows":[]}`)), private)
	if ctx.Err() == nil || attempts.Load() < 1 || attempts.Load() > 3 {
		t.Fatal("outage delivery did not stop at its deadline")
	}
}

func TestNextSignedTaskAbandonsPreviousReadWithoutWaitingForExpiry(t *testing.T) {
	platformPublic, platformPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, connectorPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	connector := "22222222-2222-4222-8222-222222222222"
	now := time.Now().Unix()
	diagnostic := protocol.Task{ID: "55555555-5555-4555-8555-555555555555", ConnectorID: connector, ActorID: "owner", Operation: "diagnostic", IssuedAt: now, ExpiresAt: now + 60, Nonce: protocol.Encode(make([]byte, 32)), Protocol: 1}
	diagnostic.Signature = protocol.Encode(ed25519.Sign(platformPrivate, []byte(strings.Join(protocol.TaskFields(diagnostic), "\n"))))
	receipts := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var fields []string
		switch r.URL.Path {
		case "/api/connector-agent/heartbeat":
			var heartbeat protocol.Signed
			if json.NewDecoder(r.Body).Decode(&heartbeat) != nil {
				w.WriteHeader(400)
				return
			}
			fields = []string{"connector-v1", "heartbeat-ack", connector, heartbeat.Nonce, "1"}
		case "/api/connector-agent/result":
			var result protocol.Result
			if json.NewDecoder(r.Body).Decode(&result) != nil {
				w.WriteHeader(400)
				return
			}
			receipts <- result.TaskID
			fields = []string{"connector-v1", "result-ack", connector, result.TaskID, result.Nonce, "1"}
		default:
			w.WriteHeader(404)
			return
		}
		signature := protocol.Encode(ed25519.Sign(platformPrivate, []byte(strings.Join(fields, "\n"))))
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "protocol": 1, "signature": signature, "task": diagnostic})
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "test")
	if err != nil {
		t.Fatal(err)
	}
	client.PlatformKey = protocol.Encode(platformPublic)
	cfg := Config{ConnectorID: connector, PlatformPublicKey: client.PlatformKey}
	vault := &memoryVault{data: map[string]KeyState{connector: {Active: protocol.Encode(connectorPrivate)}}}
	client.readRunner = NewReadRunner(cfg, vault, nil)
	client.readRunner.permit <- struct{}{} // Simulate a read that has not started.
	read := protocol.Task{ID: "11111111-1111-4111-8111-111111111111", ConnectorID: connector, ActorID: "owner", WorkspaceID: "33333333-3333-4333-8333-333333333333", SourceID: "44444444-4444-4444-8444-444444444444", Operation: "read_query", IssuedAt: now, ExpiresAt: now + 60, Nonce: protocol.Encode(make([]byte, 32)), Protocol: 1}
	if err = client.dispatchRead(context.Background(), cfg, read, connectorPrivate); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err = syncHeartbeat(ctx, client, cfg, vault, connectorPrivate); err != nil {
		t.Fatal(err)
	}
	select {
	case id := <-receipts:
		if id != diagnostic.ID {
			t.Fatal("incorrect next task")
		}
	default:
		t.Fatal("next task was not processed")
	}
	if client.readInProgress() {
		t.Fatal("previous read was not abandoned")
	}
}
