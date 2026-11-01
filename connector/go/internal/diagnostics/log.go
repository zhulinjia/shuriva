// Package diagnostics writes only explicitly reviewed operational metadata.
package diagnostics

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"gopkg.in/natefinch/lumberjack.v2"
)

var safeID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// Event intentionally offers no arbitrary attributes, message, payload, SQL,
// error or credential fields. Unknown codes/outcomes are discarded.
type Event struct {
	Code        string
	Outcome     string
	ConnectorID string
	SourceID    string
	TaskID      string
	ExecutionID string
	RequestID   string
	Duration    time.Duration
}

var codes = map[string]bool{"connector.lifecycle": true, "connector.http": true, "connector.read": true, "connector.mutation": true}
var outcomes = map[string]bool{"started": true, "success": true, "pending": true, "unknown": true, "unavailable": true, "denied": true, "cancelled": true, "failed": true, "stopped": true}

type Logger struct {
	output *slog.Logger
	closer io.Closer
	writer *trackingWriter
}
type contextKey struct{}

type trackingWriter struct {
	output   io.Writer
	fallback io.Writer
	failed   atomic.Bool
}

func (w *trackingWriter) markFailed() {
	if w.failed.CompareAndSwap(false, true) && w.fallback != nil {
		// Only fixed text and a generated timestamp are emitted; the original
		// I/O error may contain a path or sensitive external content.
		_, _ = fmt.Fprintf(w.fallback, "{\"time\":%q,\"level\":\"ERROR\",\"event\":\"connector.diagnostics_unavailable\",\"outcome\":\"failed\"}\n", time.Now().UTC().Format(time.RFC3339Nano))
	}
}
func (w *trackingWriter) Write(p []byte) (int, error) {
	n, err := w.output.Write(p)
	if err != nil || n != len(p) {
		w.markFailed()
		if err == nil {
			err = io.ErrShortWrite
		}
	}
	return n, err
}
func newLogger(output, fallback io.Writer, level slog.Leveler, closer io.Closer) *Logger {
	writer := &trackingWriter{output: output, fallback: fallback}
	return &Logger{output: slog.New(slog.NewJSONHandler(writer, &slog.HandlerOptions{Level: level})), closer: closer, writer: writer}
}

// Open reads only explicit non-secret logging settings. File output is opt-in;
// rotation reuses the already locked lumberjack library.
func Open(getenv func(string) string, stderr io.Writer) (*Logger, error) {
	if getenv == nil || stderr == nil {
		return nil, errors.New("diagnostic configuration unavailable")
	}
	level := new(slog.LevelVar)
	switch strings.ToLower(getenv("CONNECTOR_LOG_LEVEL")) {
	case "", "info":
		level.Set(slog.LevelInfo)
	case "debug":
		level.Set(slog.LevelDebug)
	case "warn":
		level.Set(slog.LevelWarn)
	case "error":
		level.Set(slog.LevelError)
	default:
		return nil, errors.New("invalid diagnostic level")
	}
	var output io.Writer = stderr
	var closer io.Closer
	switch getenv("CONNECTOR_LOG_OUTPUT") {
	case "", "stderr":
	case "file":
		name := getenv("CONNECTOR_LOG_FILE")
		if !filepath.IsAbs(name) {
			return nil, errors.New("diagnostic file requires an absolute path")
		}
		max := 10
		if value := getenv("CONNECTOR_LOG_MAX_SIZE_MB"); value != "" {
			parsed, err := strconv.Atoi(value)
			if err != nil || parsed < 1 || parsed > 1024 {
				return nil, errors.New("invalid diagnostic file size")
			}
			max = parsed
		}
		probe, err := os.OpenFile(name, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			return nil, errors.New("diagnostic file unavailable")
		}
		if probe.Close() != nil {
			return nil, errors.New("diagnostic file unavailable")
		}
		file := &lumberjack.Logger{Filename: name, MaxSize: max, MaxBackups: 3, MaxAge: 7, Compress: false}
		output, closer = file, file
	default:
		return nil, errors.New("invalid diagnostic output")
	}
	return newLogger(output, stderr, level, closer), nil
}

// Fallback keeps the Connector operational when diagnostic configuration or
// file initialization fails, while exposing the sticky degraded state.
func Fallback(stderr io.Writer) *Logger {
	if stderr == nil {
		stderr = io.Discard
	}
	l := newLogger(stderr, stderr, slog.LevelInfo, nil)
	l.writer.markFailed()
	return l
}
func (l *Logger) Health() bool { return l != nil && l.writer != nil && !l.writer.failed.Load() }
func (l *Logger) Close() error {
	if l == nil || l.closer == nil {
		return nil
	}
	if err := l.closer.Close(); err != nil {
		l.writer.markFailed()
		return errors.New("diagnostics output unavailable")
	}
	return nil
}
func With(ctx context.Context, l *Logger) context.Context {
	return context.WithValue(ctx, contextKey{}, l)
}
func Record(ctx context.Context, e Event) {
	l, _ := ctx.Value(contextKey{}).(*Logger)
	if l == nil || !codes[e.Code] || !outcomes[e.Outcome] {
		return
	}
	fields := []any{slog.String("event", e.Code), slog.String("outcome", e.Outcome)}
	for _, v := range []struct{ name, id string }{{"connectorId", e.ConnectorID}, {"sourceId", e.SourceID}, {"taskId", e.TaskID}, {"executionId", e.ExecutionID}, {"requestId", e.RequestID}} {
		if safeID.MatchString(v.id) {
			fields = append(fields, slog.String(v.name, v.id))
		}
	}
	if e.Duration >= 0 && e.Duration <= 24*time.Hour {
		fields = append(fields, slog.Int64("durationMs", e.Duration.Milliseconds()))
	}
	level := slog.LevelInfo
	if e.Code == "connector.http" && e.Outcome == "success" && e.TaskID == "" {
		level = slog.LevelDebug
	}
	if e.Outcome == "denied" || e.Outcome == "unavailable" || e.Outcome == "unknown" {
		level = slog.LevelWarn
	}
	if e.Outcome == "failed" {
		level = slog.LevelError
	}
	l.output.Log(ctx, level, e.Code, fields...)
}
