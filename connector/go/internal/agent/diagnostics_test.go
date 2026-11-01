package agent

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"example.com/ai-database-workspace/connector/internal/diagnostics"
	"example.com/ai-database-workspace/connector/internal/protocol"
)

type diagnosticTransport func(*http.Request) (*http.Response, error)

func (f diagnosticTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestHTTPDiagnosticsCorrelateWithoutLoggingPayloadOrTransportErrors(t *testing.T) {
	var log bytes.Buffer
	logger, err := diagnostics.Open(func(string) string { return "" }, &log)
	if err != nil {
		t.Fatal(err)
	}
	defer logger.Close()
	ctx := diagnostics.With(context.Background(), logger)
	const connector = "11111111-1111-4111-8111-111111111111"
	const source = "22222222-2222-4222-8222-222222222222"
	const task = "33333333-3333-4333-8333-333333333333"
	const requestID = "44444444-4444-4444-8444-444444444444"
	const canary = "PASSWORD-super-secret SELECT * FROM secret_table"
	client := &Client{Server: "http://127.0.0.1", HTTP: &http.Client{Transport: diagnosticTransport(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 503, Header: http.Header{"X-Request-Id": []string{requestID}}, Body: io.NopCloser(strings.NewReader(canary))}, nil
	})}}
	body := protocol.ReadResult{ConnectorID: connector, SourceID: source, TaskID: task, Payload: canary}
	if client.post(ctx, "/api/connector-agent/read-result", body, 1, nil) == nil {
		t.Fatal("503 accepted")
	}
	for _, id := range []string{connector, source, task, requestID} {
		if !strings.Contains(log.String(), id) {
			t.Fatal("safe correlation missing")
		}
	}
	if strings.Contains(log.String(), canary) || strings.Contains(log.String(), "secret_table") {
		t.Fatal("response or payload escaped into diagnostics")
	}
	log.Reset()
	client.HTTP.Transport = diagnosticTransport(func(*http.Request) (*http.Response, error) { return nil, errors.New(canary) })
	if client.post(ctx, "/api/connector-agent/read-result", body, 1, nil) == nil {
		t.Fatal("failed transport accepted")
	}
	if strings.Contains(log.String(), canary) || !strings.Contains(log.String(), `"outcome":"unavailable"`) {
		t.Fatal("transport error leaked or was not classified")
	}
}
