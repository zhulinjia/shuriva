package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/protocol"
)

func TestIdleTaskPickupIsPromptAndOfflineRetryDoesNotFlood(t *testing.T) {
	for _, offline := range []bool{false, true} {
		public, platform, _ := ed25519.GenerateKey(rand.Reader)
		_, private, _ := ed25519.GenerateKey(rand.Reader)
		id := "22222222-2222-4222-8222-222222222222"
		var calls atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			count := calls.Add(1)
			if offline {
				w.WriteHeader(503)
				return
			}
			if count > 1 {
				w.WriteHeader(403)
				return
			}
			var msg protocol.Signed
			if json.NewDecoder(r.Body).Decode(&msg) != nil {
				w.WriteHeader(400)
				return
			}
			fields := []string{"connector-v1", "heartbeat-ack", id, msg.Nonce, "1"}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "protocol": 1, "signature": protocol.Encode(ed25519.Sign(platform, []byte(strings.Join(fields, "\n"))))})
		}))
		cfg := Config{ConnectorID: id, PlatformPublicKey: protocol.Encode(public), Server: server.URL}
		vault := &memoryVault{data: map[string]KeyState{id: {Active: protocol.Encode(private)}}}
		duration := 5 * time.Second
		if offline {
			duration = 1200 * time.Millisecond
		}
		ctx, cancel := context.WithTimeout(context.Background(), duration)
		err := RunWithSources(ctx, cfg, "test", vault, nil, io.Discard)
		cancel()
		server.Close()
		if offline {
			if err != nil || calls.Load() != 1 {
				t.Fatalf("offline retry flooded or cancellation failed: %d, %v", calls.Load(), err)
			}
		} else {
			var denied *APIError
			if !errors.As(err, &denied) || denied.Status != 403 || calls.Load() != 2 {
				t.Fatalf("idle task pickup waited too long: %d, %v", calls.Load(), err)
			}
		}
	}
}

func TestRevokedConnectorCancelsActiveRead(t *testing.T) {
	platformPublic, platformPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, connectorPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	connector := "22222222-2222-4222-8222-222222222222"
	workspace := "33333333-3333-4333-8333-333333333333"
	source := "44444444-4444-4444-8444-444444444444"
	now := time.Now().Unix()
	payload, _ := json.Marshal(protocol.ReadRequest{SQL: "SELECT id FROM customers", Parameters: []protocol.ReadParameter{}, MaxRows: 10})
	task := protocol.ReadTask{ID: "11111111-1111-4111-8111-111111111111", ConnectorID: connector, ActorID: "owner", WorkspaceID: workspace, SourceID: source, Operation: "read_query", Payload: protocol.Encode(payload), IssuedAt: now, ExpiresAt: now + 60, Nonce: protocol.Encode(make([]byte, 32)), Protocol: 1}
	task.Signature = protocol.Encode(ed25519.Sign(platformPrivate, []byte(strings.Join(protocol.ReadTaskFields(task), "\n"))))
	sources := &blockingReadSource{started: make(chan struct{}), resume: make(chan struct{})}
	revoked := make(chan struct{})
	var heartbeats, results atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/connector-agent/read-result" {
			results.Add(1)
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if r.URL.Path != "/api/connector-agent/heartbeat" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var msg protocol.Signed
		if json.NewDecoder(r.Body).Decode(&msg) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if heartbeats.Add(1) > 1 {
			<-sources.started
			close(revoked)
			w.WriteHeader(http.StatusForbidden)
			return
		}
		ack := []string{"connector-v1", "heartbeat-ack", connector, msg.Nonce, "1"}
		signature := protocol.Encode(ed25519.Sign(platformPrivate, []byte(strings.Join(ack, "\n"))))
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "protocol": 1, "signature": signature, "task": task})
	}))
	defer server.Close()
	cfg := Config{ConnectorID: connector, PlatformPublicKey: protocol.Encode(platformPublic), Server: server.URL}
	vault := &memoryVault{data: map[string]KeyState{connector: {Active: protocol.Encode(connectorPrivate)}}}
	done := make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	go func() { done <- RunWithSources(ctx, cfg, "test", vault, sources, io.Discard) }()
	select {
	case <-revoked:
	case <-ctx.Done():
		t.Fatal("revocation not observed")
	}
	// Let Run observe the 403 while the source-vault call remains blocked.
	time.Sleep(200 * time.Millisecond)
	close(sources.resume)
	select {
	case err := <-done:
		apiErr, ok := err.(*APIError)
		if !ok || apiErr.Status != 403 {
			t.Fatalf("unexpected lifecycle result: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("revoked connector did not stop")
	}
	if results.Load() != 0 {
		t.Fatal("revoked connector published a read result")
	}
}

func TestRevokedResultImmediatelyStopsConnector(t *testing.T) {
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
	payload, _ := json.Marshal(protocol.ReadRequest{SQL: "SELECT id FROM customers", Parameters: []protocol.ReadParameter{}, MaxRows: 10})
	task := protocol.ReadTask{ID: "11111111-1111-4111-8111-111111111111", ConnectorID: connector, ActorID: "owner", WorkspaceID: "33333333-3333-4333-8333-333333333333", SourceID: "44444444-4444-4444-8444-444444444444", Operation: "read_query", Payload: protocol.Encode(payload), IssuedAt: now, ExpiresAt: now + 60, Nonce: protocol.Encode(make([]byte, 32)), Protocol: 1}
	task.Signature = protocol.Encode(ed25519.Sign(platformPrivate, []byte(strings.Join(protocol.ReadTaskFields(task), "\n"))))
	var sent atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/connector-agent/read-result" {
			sent.Store(true)
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if r.URL.Path != "/api/connector-agent/heartbeat" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var msg protocol.Signed
		if json.NewDecoder(r.Body).Decode(&msg) != nil {
			w.WriteHeader(400)
			return
		}
		ack := []string{"connector-v1", "heartbeat-ack", connector, msg.Nonce, "1"}
		signature := protocol.Encode(ed25519.Sign(platformPrivate, []byte(strings.Join(ack, "\n"))))
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "protocol": 1, "signature": signature, "task": task})
	}))
	defer server.Close()
	cfg := Config{ConnectorID: connector, PlatformPublicKey: protocol.Encode(platformPublic), Server: server.URL}
	vault := &memoryVault{data: map[string]KeyState{connector: {Active: protocol.Encode(connectorPrivate)}}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err = RunWithSources(ctx, cfg, "test", vault, nil, io.Discard)
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.Status != 403 || !sent.Load() {
		t.Fatalf("result rejection did not stop connector: %v", err)
	}
}
