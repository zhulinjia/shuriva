package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"example.com/ai-database-workspace/connector/internal/protocol"
)

func TestScanResultTaskCancellationDoesNotRevokeConnector(t *testing.T) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var status atomic.Int32
	status.Store(http.StatusConflict)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/connector-agent/scan-result" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		w.WriteHeader(int(status.Load()))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "test")
	if err != nil {
		t.Fatal(err)
	}
	task := protocol.Task{ID: "11111111-1111-4111-8111-111111111111", ConnectorID: "22222222-2222-4222-8222-222222222222", WorkspaceID: "33333333-3333-4333-8333-333333333333", SourceID: "44444444-4444-4444-8444-444444444444"}
	if err = client.scanResult(context.Background(), task, "failed", "scope", private); err != nil {
		t.Fatalf("cancelled task must not stop connector: %v", err)
	}
	for _, code := range []int{http.StatusForbidden, http.StatusInternalServerError} {
		status.Store(int32(code))
		err = client.scanResult(context.Background(), task, "failed", "scope", private)
		var response *APIError
		if !errors.As(err, &response) || response.Status != code {
			t.Fatalf("HTTP %d must remain an error, got %v", code, err)
		}
	}
}
