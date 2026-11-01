package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"example.com/ai-database-workspace/connector/internal/protocol"
)

func TestPairRetryAndLostResponseRecovery(t *testing.T) {
	platformPublic, platformPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	goodSecret := protocol.Encode(make([]byte, 32))
	badBytes := make([]byte, 32)
	badBytes[0] = 1
	badSecret := protocol.Encode(badBytes)
	code := func(secret string) string {
		return "11111111-1111-4111-8111-111111111111." + secret + "." + protocol.Encode(platformPublic)
	}
	for _, scenario := range []string{"rejected", "request-not-delivered", "response-lost"} {
		t.Run(scenario, func(t *testing.T) {
			var mu sync.Mutex
			var connectorID, publicKey string
			var pairCalls int
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				var fields []string
				switch r.URL.Path {
				case "/api/connector-agent/pair":
					var p protocol.Pair
					body, readErr := io.ReadAll(r.Body)
					if readErr != nil || strings.Contains(string(body), goodSecret) || strings.Contains(string(body), badSecret) || json.Unmarshal(body, &p) != nil {
						t.Error("pairing code leaked or pair payload malformed")
						w.WriteHeader(400)
						return
					}
					pairCalls++
					if pairCalls == 1 && scenario == "request-not-delivered" {
						conn, _, err := w.(http.Hijacker).Hijack()
						if err == nil {
							_ = conn.Close()
						}
						return
					}
					if p.Proof != protocol.PairProof(p, goodSecret) || connectorID != "" {
						w.WriteHeader(403)
						return
					}
					connectorID, publicKey = p.ConnectorID, p.PublicKey
					if scenario == "response-lost" && pairCalls == 1 {
						conn, _, err := w.(http.Hijacker).Hijack()
						if err == nil {
							_ = conn.Close()
						}
						return
					}
					fields = []string{"connector-v2", "pair-ack", p.PairingID, p.ConnectorID, p.PublicKey, p.Proof, "2"}
				case "/api/connector-agent/probe":
					var p protocol.Signed
					if json.NewDecoder(r.Body).Decode(&p) != nil || p.ConnectorID != connectorID || connectorID == "" {
						w.WriteHeader(403)
						return
					}
					pub, decodeErr := protocol.Decode(publicKey, ed25519.PublicKeySize)
					if decodeErr != nil || !validSignature(pub, p.Signature, "connector-v1", "probe", p.ConnectorID, p.AgentVersion, "1", strconv.FormatInt(p.Timestamp, 10), p.Nonce) {
						w.WriteHeader(403)
						return
					}
					fields = []string{"connector-v1", "probe-ack", p.ConnectorID, p.Nonce, "1"}
				default:
					w.WriteHeader(404)
					return
				}
				version := 1
				if r.URL.Path == "/api/connector-agent/pair" {
					version = 2
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "protocol": version, "signature": protocol.Encode(ed25519.Sign(platformPrivate, []byte(strings.Join(fields, "\n"))))})
			}))
			defer server.Close()
			vault := &memoryVault{data: map[string]KeyState{}}
			path := filepath.Join(t.TempDir(), "config.json")
			firstCode := code(goodSecret)
			if scenario == "rejected" {
				firstCode = code(badSecret)
			}
			if err := PairNew(context.Background(), path, server.URL, "test", firstCode, "test", vault); err == nil {
				t.Fatal("expected first attempt to fail")
			}
			before, err := ReadConfig(path)
			if err != nil {
				t.Fatal(err)
			}
			err = PairNew(context.Background(), path, server.URL, "test", code(goodSecret), "test", vault)
			if scenario == "response-lost" {
				if err == nil || !strings.Contains(err.Error(), "supplied code was not used") {
					t.Fatalf("expected existing registration confirmation: %v", err)
				}
			} else if err != nil {
				t.Fatalf("retry failed: %v", err)
			}
			after, err := ReadConfig(path)
			if err != nil {
				t.Fatal(err)
			}
			mu.Lock()
			gotID, calls := connectorID, pairCalls
			mu.Unlock()
			if before.ConnectorID != after.ConnectorID || after.ConnectorID != gotID {
				t.Fatal("retry changed connector identity")
			}
			if scenario == "response-lost" && calls != 1 {
				t.Fatal("registered identity was paired again")
			}
		})
	}
}

func TestPairRecoveryDoesNotTrustUnverifiedPlatform(t *testing.T) {
	platformPublic, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	otherPublic, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	secret := protocol.Encode(make([]byte, 32))
	code := func(pub ed25519.PublicKey) string {
		return "11111111-1111-4111-8111-111111111111." + secret + "." + protocol.Encode(pub)
	}
	for _, heartbeatStatus := range []int{500, 200, 403} {
		t.Run(strconv.Itoa(heartbeatStatus), func(t *testing.T) {
			var mu sync.Mutex
			pairCalls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				if r.URL.Path == "/api/connector-agent/pair" {
					body, _ := io.ReadAll(r.Body)
					if strings.Contains(string(body), secret) {
						t.Error("pairing secret leaked to untrusted service")
					}
					pairCalls++
					w.WriteHeader(403)
					return
				}
				if heartbeatStatus != 200 {
					w.WriteHeader(heartbeatStatus)
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "protocol": 1, "signature": protocol.Encode(make([]byte, 64))})
			}))
			defer server.Close()
			path := filepath.Join(t.TempDir(), "config.json")
			vault := &memoryVault{data: map[string]KeyState{}}
			if err := PairNew(context.Background(), path, server.URL, "test", code(platformPublic), "test", vault); err == nil {
				t.Fatal("expected pair rejection")
			}
			if err := PairNew(context.Background(), path, server.URL, "test", code(platformPublic), "test", vault); err == nil {
				t.Fatal("accepted unverifiable heartbeat")
			}
			if err := PairNew(context.Background(), path, server.URL, "test", code(otherPublic), "test", vault); err == nil {
				t.Fatal("allowed platform key change")
			}
			mu.Lock()
			calls := pairCalls
			mu.Unlock()
			wantCalls := 1
			if heartbeatStatus == 403 {
				wantCalls = 2
			}
			if calls != wantCalls {
				t.Fatalf("unexpected number of pair calls: %d", calls)
			}
		})
	}
}
