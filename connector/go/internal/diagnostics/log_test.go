package diagnostics

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) {
	return 0, errors.New("secret-path-and-token-must-not-appear")
}

func TestWriterFailureIsVisibleWithoutBlockingOperationOrLeakingCause(t *testing.T) {
	var fallback bytes.Buffer
	logger := newLogger(failingWriter{}, &fallback, slog.LevelInfo, nil)
	ctx := With(context.Background(), logger)
	Record(ctx, Event{Code: "connector.lifecycle", Outcome: "started"})
	Record(ctx, Event{Code: "connector.lifecycle", Outcome: "success"})
	if logger.Health() {
		t.Fatal("lost log did not mark diagnostics unhealthy")
	}
	if strings.Contains(fallback.String(), "secret-path-and-token") || strings.Count(fallback.String(), "\n") != 1 || !strings.Contains(fallback.String(), "connector.diagnostics_unavailable") {
		t.Fatal("fallback alert leaked cause or repeated")
	}
	var event map[string]any
	if json.Unmarshal(bytes.TrimSpace(fallback.Bytes()), &event) != nil || event["outcome"] != "failed" {
		t.Fatal("fallback alert is not structured JSON")
	}
	var another bytes.Buffer
	degraded := Fallback(&another)
	if degraded.Health() || !strings.Contains(another.String(), "connector.diagnostics_unavailable") {
		t.Fatal("invalid logger configuration not exposed")
	}
}

func env(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestReviewedMetadataOnlyAndCorrelation(t *testing.T) {
	var out bytes.Buffer
	logger, err := Open(env(nil), &out)
	if err != nil {
		t.Fatal(err)
	}
	defer logger.Close()
	ctx := With(context.Background(), logger)
	const connector = "11111111-1111-4111-8111-111111111111"
	const task = "22222222-2222-4222-8222-222222222222"
	const execution = "33333333-3333-4333-8333-333333333333"
	const request = "44444444-4444-4444-8444-444444444444"
	const canary = "secret-password SELECT * FROM private_table token=very-secret"
	Record(ctx, Event{Code: "connector.http", Outcome: "failed", ConnectorID: connector, TaskID: task, ExecutionID: execution, RequestID: request, SourceID: canary, Duration: 12 * time.Millisecond})
	Record(ctx, Event{Code: canary, Outcome: "failed", RequestID: canary})
	if strings.Contains(out.String(), canary) || strings.Contains(out.String(), "private_table") || strings.Count(out.String(), "\n") != 1 {
		t.Fatal("unexpected or sensitive data escaped diagnostic allowlist")
	}
	var got map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(out.Bytes()), &got); err != nil {
		t.Fatal(err)
	}
	if got["connectorId"] != connector || got["taskId"] != task || got["executionId"] != execution || got["requestId"] != request || got["durationMs"] != float64(12) || got["event"] != "connector.http" {
		t.Fatal("safe correlation missing")
	}
	if _, ok := got["sourceId"]; ok {
		t.Fatal("unvalidated source identifier logged")
	}
}

func TestLevelsAndExplicitRotatingOutput(t *testing.T) {
	var out bytes.Buffer
	logger, err := Open(env(map[string]string{"CONNECTOR_LOG_LEVEL": "error"}), &out)
	if err != nil {
		t.Fatal(err)
	}
	Record(With(context.Background(), logger), Event{Code: "connector.lifecycle", Outcome: "success"})
	logger.Close()
	if out.Len() != 0 {
		t.Fatal("configured level not applied")
	}
	file := filepath.Join(t.TempDir(), "connector.jsonl")
	logger, err = Open(env(map[string]string{"CONNECTOR_LOG_OUTPUT": "file", "CONNECTOR_LOG_FILE": file, "CONNECTOR_LOG_MAX_SIZE_MB": "1"}), &out)
	if err != nil {
		t.Fatal(err)
	}
	Record(With(context.Background(), logger), Event{Code: "connector.lifecycle", Outcome: "started"})
	if err := logger.Close(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(file)
	if err != nil || !json.Valid(bytes.TrimSpace(raw)) {
		t.Fatal("explicit file output not written")
	}
	if _, err := Open(env(map[string]string{"CONNECTOR_LOG_OUTPUT": "file", "CONNECTOR_LOG_FILE": "relative"}), &out); err == nil {
		t.Fatal("relative path accepted")
	}
	if _, err := Open(env(map[string]string{"CONNECTOR_LOG_LEVEL": "unknown"}), &out); err == nil {
		t.Fatal("unknown level accepted")
	}
}

func TestConfiguredFileRotatesAtBoundedSize(t *testing.T) {
	file := filepath.Join(t.TempDir(), "events.jsonl")
	logger, err := Open(env(map[string]string{"CONNECTOR_LOG_OUTPUT": "file", "CONNECTOR_LOG_FILE": file, "CONNECTOR_LOG_MAX_SIZE_MB": "1"}), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	ctx := With(context.Background(), logger)
	for i := 0; i < 15000; i++ {
		Record(ctx, Event{Code: "connector.mutation", Outcome: "failed", ConnectorID: "11111111-1111-4111-8111-111111111111", TaskID: "22222222-2222-4222-8222-222222222222"})
	}
	if err := logger.Close(); err != nil {
		t.Fatal(err)
	}
	backups, err := filepath.Glob(filepath.Join(filepath.Dir(file), "events-*.jsonl"))
	if err != nil || len(backups) == 0 || len(backups) > 3 {
		t.Fatal("diagnostic rotation did not retain bounded backups")
	}
}
