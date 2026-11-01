package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/protocol"
)

type memoryVault struct {
	mu   sync.Mutex
	data map[string]KeyState
}

func (v *memoryVault) Get(id string) (KeyState, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	s, ok := v.data[id]
	if !ok {
		return s, errors.New("missing")
	}
	return s, nil
}
func (v *memoryVault) Set(id string, s KeyState) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.data[id] = s
	return nil
}
func (v *memoryVault) Delete(id string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	delete(v.data, id)
	return nil
}
func validSignature(pub ed25519.PublicKey, signature string, fields ...string) bool {
	sig, err := protocol.Decode(signature, 64)
	return err == nil && ed25519.Verify(pub, []byte(strings.Join(fields, "\n")), sig)
}

func TestServerURLPolicy(t *testing.T) {
	for _, value := range []string{"http://example.com", "http://localhost.evil.test", "https://user:pass@example.com", "https://example.com/path", "https://example.com?q=1", "file:///tmp/x"} {
		if _, err := NewClient(value, "test"); err == nil {
			t.Errorf("accepted %q", value)
		}
	}
	for _, value := range []string{"http://127.0.0.1:3000", "http://localhost:3000", "https://example.com"} {
		if _, err := NewClient(value, "test"); err != nil {
			t.Errorf("rejected %q: %v", value, err)
		}
	}
}
func TestPairAndLostRotationResponseRecovery(t *testing.T) {
	var current ed25519.PublicKey
	platformPublic, platformPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	loseResponse := true
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var ack []string
		switch r.URL.Path {
		case "/api/connector-agent/pair":
			var p protocol.Pair
			if json.NewDecoder(r.Body).Decode(&p) != nil {
				t.Error("invalid pair JSON")
				w.WriteHeader(400)
				return
			}
			key, err := protocol.Decode(p.PublicKey, 32)
			if err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			current = ed25519.PublicKey(key)
			// Verify the same canonical message as the platform.
			if !validSignature(current, p.Signature, "connector-v2", "pair", p.PairingID, p.Proof, p.ConnectorID, p.Name, p.PublicKey, p.AgentVersion, strconv.Itoa(p.Protocol)) || p.Name != "测试连接器" || p.Protocol != 2 {
				t.Error("invalid pair fields")
				w.WriteHeader(400)
				return
			}
			ack = []string{"connector-v2", "pair-ack", p.PairingID, p.ConnectorID, p.PublicKey, p.Proof, "2"}
		case "/api/connector-agent/heartbeat", "/api/connector-agent/probe":
			var p protocol.Signed
			if json.NewDecoder(r.Body).Decode(&p) != nil {
				w.WriteHeader(400)
				return
			}
			op := "heartbeat"
			if r.URL.Path == "/api/connector-agent/probe" {
				op = "probe"
			}
			if !validSignature(current, p.Signature, "connector-v1", op, p.ConnectorID, p.AgentVersion, strconv.Itoa(p.Protocol), strconv.FormatInt(p.Timestamp, 10), p.Nonce) {
				w.WriteHeader(403)
				return
			}
			ack = []string{"connector-v1", op + "-ack", p.ConnectorID, p.Nonce, "1"}
		case "/api/connector-agent/rotate":
			var p protocol.Rotate
			if json.NewDecoder(r.Body).Decode(&p) != nil {
				w.WriteHeader(400)
				return
			}
			if !validSignature(current, p.Signature, "connector-v1", "rotate", p.ConnectorID, p.NewPublicKey, p.AgentVersion, strconv.Itoa(p.Protocol), strconv.FormatInt(p.Timestamp, 10), p.Nonce) {
				w.WriteHeader(403)
				return
			}
			next, err := protocol.Decode(p.NewPublicKey, 32)
			if err != nil {
				w.WriteHeader(400)
				return
			}
			current = ed25519.PublicKey(next)
			ack = []string{"connector-v1", "rotate-ack", p.ConnectorID, p.NewPublicKey, p.Nonce, "1"}
			if loseResponse {
				loseResponse = false
				conn, _, err := w.(http.Hijacker).Hijack()
				if err == nil {
					_ = conn.Close()
				}
				return
			}
		default:
			w.WriteHeader(404)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		version := 1
		if r.URL.Path == "/api/connector-agent/pair" {
			version = 2
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "protocol": version, "signature": protocol.Encode(ed25519.Sign(platformPrivate, []byte(strings.Join(ack, "\n"))))})
	}))
	defer server.Close()
	vault := &memoryVault{data: map[string]KeyState{}}
	path := filepath.Join(t.TempDir(), "config.json")
	secret := make([]byte, 32)
	_, _ = rand.Read(secret)
	code := "11111111-1111-4111-8111-111111111111." + protocol.Encode(secret) + "." + protocol.Encode(platformPublic)
	if err := PairNew(context.Background(), path, server.URL, "测试连接器", code, "test", vault); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), code) {
		t.Fatal("pairing code persisted")
	}
	cfg, err := ReadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewClient(server.URL, "test")
	if err != nil {
		t.Fatal(err)
	}
	if err = Sync(context.Background(), client, cfg, vault); err != nil {
		t.Fatal(err)
	}
	if err = StartRotation(context.Background(), client, cfg, vault); err == nil {
		t.Fatal("simulated lost response should fail")
	}
	state, err := vault.Get(cfg.ConnectorID)
	if err != nil || state.Pending == "" {
		t.Fatal("pending key was not retained")
	}
	if err = Sync(context.Background(), client, cfg, vault); err != nil {
		t.Fatal(err)
	}
	state, err = vault.Get(cfg.ConnectorID)
	if err != nil || state.Pending != "" {
		t.Fatal("rotation was not reconciled")
	}
	if err = Sync(context.Background(), client, cfg, vault); err != nil {
		t.Fatal(err)
	}
	if err = Reset(path, vault); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("local config not removed")
	}
}
func TestInvalidPairingCodeDoesNotCreateIdentity(t *testing.T) {
	v := &memoryVault{data: map[string]KeyState{}}
	path := filepath.Join(t.TempDir(), "config.json")
	err := PairNew(context.Background(), path, "http://127.0.0.1:3000", "test", "invalid", "test", v)
	if err == nil {
		t.Fatal("expected invalid code")
	}
	if len(v.data) != 0 {
		t.Fatal("invalid pairing created a secret")
	}
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("invalid pairing created config")
	}
}
func TestSystemVaultWhenExplicitlyEnabled(t *testing.T) {
	if os.Getenv("CONNECTOR_TEST_KEYRING") != "1" {
		t.Skip("requires system credential manager")
	}
	id, err := newID()
	if err != nil {
		t.Fatal(err)
	}
	vault := SystemVault{}
	state := KeyState{Active: "test-only-value"}
	if err = vault.Set(id, state); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = vault.Delete(id) })
	got, err := vault.Get(id)
	if err != nil || got.Active != state.Active || got.Pending != state.Pending || len(got.Completed) != 0 {
		t.Fatalf("keyring round trip failed: %v", err)
	}
	if err = vault.Delete(id); err != nil {
		t.Fatal(err)
	}
}
func TestConnectorLockPreventsConcurrentOperations(t *testing.T) {
	path := filepath.Join(t.TempDir(), "connector.json")
	release, err := LockConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = LockConfig(path); err == nil {
		t.Fatal("second operation acquired an active lock")
	}
	if err = release(); err != nil {
		t.Fatal(err)
	}
	again, err := LockConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = again(); err != nil {
		t.Fatal(err)
	}
}
func TestGeneratedConnectorIDMatchesV1(t *testing.T) {
	id, err := newID()
	if err != nil {
		t.Fatal(err)
	}
	if !pairingID.MatchString(id) {
		t.Fatalf("invalid UUID: %s", id)
	}
}
func TestRejectsForgedPlatformAcknowledgement(t *testing.T) {
	trusted, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, attacker, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var p protocol.Signed
		_ = json.NewDecoder(r.Body).Decode(&p)
		fields := []string{"connector-v1", "heartbeat-ack", p.ConnectorID, p.Nonce, "1"}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "protocol": 1, "signature": protocol.Encode(ed25519.Sign(attacker, []byte(strings.Join(fields, "\n"))))})
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "test")
	if err != nil {
		t.Fatal(err)
	}
	client.PlatformKey = protocol.Encode(trusted)
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = client.Heartbeat(context.Background(), "11111111-1111-4111-8111-111111111111", private); err == nil || !strings.Contains(err.Error(), "identity verification") {
		t.Fatal("forged platform acknowledgement was accepted")
	}
}

func TestDiagnosticRetryDoesNotDuplicateTask(t *testing.T) {
	platformPublic, platformPrivate, _ := ed25519.GenerateKey(rand.Reader)
	_, connectorPrivate, _ := ed25519.GenerateKey(rand.Reader)
	id := "22222222-2222-4222-8222-222222222222"
	now := time.Now().Unix()
	task := protocol.Task{ID: "11111111-1111-4111-8111-111111111111", ConnectorID: id, ActorID: "owner", Operation: "diagnostic", IssuedAt: now, ExpiresAt: now + 60, Nonce: protocol.Encode(make([]byte, 32)), Protocol: 1}
	task.Signature = protocol.Encode(ed25519.Sign(platformPrivate, []byte(strings.Join(protocol.TaskFields(task), "\n"))))
	receipts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var ack []string
		if r.URL.Path == "/api/connector-agent/heartbeat" {
			var p protocol.Signed
			_ = json.NewDecoder(r.Body).Decode(&p)
			ack = []string{"connector-v1", "heartbeat-ack", id, p.Nonce, "1"}
		} else if r.URL.Path == "/api/connector-agent/result" {
			var p protocol.Result
			_ = json.NewDecoder(r.Body).Decode(&p)
			receipts++
			if receipts == 1 {
				conn, _, _ := w.(http.Hijacker).Hijack()
				_ = conn.Close()
				return
			}
			ack = []string{"connector-v1", "result-ack", id, task.ID, p.Nonce, "1"}
		} else {
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "protocol": 1, "task": task, "signature": protocol.Encode(ed25519.Sign(platformPrivate, []byte(strings.Join(ack, "\n"))))})
	}))
	defer server.Close()
	cfg := Config{ConnectorID: id, PlatformPublicKey: protocol.Encode(platformPublic)}
	vault := &memoryVault{data: map[string]KeyState{id: {Active: protocol.Encode(connectorPrivate)}}}
	client, _ := NewClient(server.URL, "test")
	if err := Sync(context.Background(), client, cfg, vault); err == nil {
		t.Fatal("expected lost response")
	}
	if err := Sync(context.Background(), client, cfg, vault); err != nil {
		t.Fatal(err)
	}
	state, _ := vault.Get(id)
	if receipts != 2 || len(state.Completed) != 1 || state.Completed[0].ID != task.ID {
		t.Fatal("task was not deduplicated")
	}
}
