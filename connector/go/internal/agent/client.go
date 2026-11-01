package agent

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"example.com/ai-database-workspace/connector/internal/datasource"
	"example.com/ai-database-workspace/connector/internal/diagnostics"
	"example.com/ai-database-workspace/connector/internal/protocol"
)

type APIError struct{ Status int }

// Stable classification without retaining URLs, TLS internals or credentials.
var ErrPlatformUnavailable = errors.New("cannot reach platform; check connectivity and TLS")

func (e *APIError) Error() string {
	if e.Status == 426 {
		return "protocol version is not supported"
	}
	if e.Status == 403 {
		return "connector identity or pairing code was rejected"
	}
	if e.Status == 429 {
		return "platform rate limit reached"
	}
	return fmt.Sprintf("platform returned HTTP %d", e.Status)
}
func validateServer(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", errors.New("server must be an HTTP(S) origin without credentials, path or query")
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", errors.New("server must use HTTPS or loopback HTTP")
	}
	host := strings.ToLower(u.Hostname())
	ip := net.ParseIP(host)
	if u.Scheme == "http" && host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return "", errors.New("HTTP is allowed only on loopback")
	}
	return strings.TrimSuffix(u.String(), "/"), nil
}

type Client struct {
	Mutations        MutationHandler
	mutations        *mutationRuntime
	mutationOnce     sync.Once
	Server           string
	HTTP             *http.Client
	Version          string
	PlatformKey      string
	SourceVault      datasource.Vault
	readRunner       *ReadRunner
	readMu           sync.Mutex
	reading          bool
	readTask         *protocol.ReadTask
	readCancel       context.CancelFunc
	readDeliveryStop context.CancelFunc
	readWait         sync.WaitGroup
	readFailure      chan error
}

func NewClient(server, version string) (*Client, error) {
	normalized, err := validateServer(server)
	if err != nil {
		return nil, err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	return &Client{Server: normalized, Version: version, HTTP: &http.Client{Timeout: 10 * time.Second, Transport: transport, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (c *Client) post(ctx context.Context, path string, body any, expectedProtocol int, taskOut *json.RawMessage, ackFields ...string) (finalErr error) {
	started := time.Now()
	event := diagnostics.Event{Code: "connector.http"}
	defer func() {
		if finalErr != nil && (event.Outcome == "" || event.Outcome == "success") {
			event.Outcome = "failed"
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			event.Outcome = "cancelled"
		}
		event.Duration = time.Since(started)
		diagnostics.Record(ctx, event)
	}()
	switch value := body.(type) {
	case protocol.Pair:
		event.ConnectorID = value.ConnectorID
	case protocol.Signed:
		event.ConnectorID = value.ConnectorID
	case protocol.Rotate:
		event.ConnectorID = value.ConnectorID
	case protocol.Result:
		event.ConnectorID, event.TaskID = value.ConnectorID, value.TaskID
	case protocol.ScanResult:
		event.ConnectorID, event.SourceID, event.TaskID = value.ConnectorID, value.SourceID, value.TaskID
	case protocol.ReadResult:
		event.ConnectorID, event.SourceID, event.TaskID = value.ConnectorID, value.SourceID, value.TaskID
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Server+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := c.HTTP.Do(request)
	if err != nil {
		event.Outcome = "unavailable"
		return ErrPlatformUnavailable
	}
	event.Outcome, event.RequestID = "success", response.Header.Get("X-Request-Id")
	if response.StatusCode != http.StatusOK {
		event.Outcome = "failed"
		if response.StatusCode == 403 || response.StatusCode == 426 {
			event.Outcome = "denied"
		}
		if response.StatusCode == 429 || response.StatusCode >= 500 {
			event.Outcome = "unavailable"
		}
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 8192))
		return &APIError{Status: response.StatusCode}
	}
	var result struct {
		OK        bool            `json:"ok"`
		Protocol  int             `json:"protocol"`
		Signature string          `json:"signature"`
		Task      json.RawMessage `json:"task"`
	}
	limit := int64(8193)
	if path == "/api/connector-agent/heartbeat" {
		limit = 65537
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, limit))
	if err = decoder.Decode(&result); err != nil || !result.OK || result.Protocol != expectedProtocol {
		return errors.New("platform returned an invalid or incompatible response")
	}
	public, err := protocol.Decode(c.PlatformKey, ed25519.PublicKeySize)
	if err != nil {
		return errors.New("trusted platform key is invalid")
	}
	signature, err := protocol.Decode(result.Signature, ed25519.SignatureSize)
	if err != nil || !ed25519.Verify(ed25519.PublicKey(public), []byte(strings.Join(ackFields, "\n")), signature) {
		return errors.New("platform identity verification failed")
	}
	if taskOut != nil {
		*taskOut = result.Task
	}
	return nil
}
func (c *Client) Pair(ctx context.Context, cfg Config, secret string, private ed25519.PrivateKey) error {
	parts := strings.Split(secret, ".")
	if len(parts) != 3 {
		return errors.New("invalid pairing code")
	}
	if _, err := protocol.Decode(parts[1], 32); err != nil {
		return errors.New("invalid pairing code")
	}
	p := protocol.Pair{PairingID: parts[0], ConnectorID: cfg.ConnectorID, Name: cfg.Name, PublicKey: publicKey(private), AgentVersion: c.Version, Protocol: protocol.PairVersion}
	protocol.SignPair(&p, parts[1], private)
	return c.post(ctx, "/api/connector-agent/pair", p, protocol.PairVersion, nil, "connector-v2", "pair-ack", p.PairingID, p.ConnectorID, p.PublicKey, p.Proof, "2")
}
func (c *Client) Heartbeat(ctx context.Context, id string, private ed25519.PrivateKey) (*protocol.Task, error) {
	p, err := protocol.NewHeartbeat(id, c.Version, private, time.Now())
	if err != nil {
		return nil, err
	}
	var raw json.RawMessage
	if err = c.post(ctx, "/api/connector-agent/heartbeat", p, protocol.Version, &raw, "connector-v1", "heartbeat-ack", p.ConnectorID, p.Nonce, "1"); err != nil {
		return nil, err
	}
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var task protocol.Task
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&task); err != nil {
		return nil, errors.New("platform returned an invalid task")
	}
	return &task, nil
}
func (c *Client) Probe(ctx context.Context, id string, private ed25519.PrivateKey) error {
	p, err := protocol.NewProbe(id, c.Version, private, time.Now())
	if err != nil {
		return err
	}
	return c.post(ctx, "/api/connector-agent/probe", p, protocol.Version, nil, "connector-v1", "probe-ack", p.ConnectorID, p.Nonce, "1")
}
func (c *Client) Rotate(ctx context.Context, id string, old ed25519.PrivateKey, next ed25519.PrivateKey) error {
	p, err := protocol.NewRotation(id, c.Version, publicKey(next), old, time.Now())
	if err != nil {
		return err
	}
	return c.post(ctx, "/api/connector-agent/rotate", p, protocol.Version, nil, "connector-v1", "rotate-ack", p.ConnectorID, p.NewPublicKey, p.Nonce, "1")
}

func (c *Client) result(ctx context.Context, id, taskID string, private ed25519.PrivateKey) error {
	p, err := protocol.NewResult(id, c.Version, taskID, private, time.Now())
	if err != nil {
		return err
	}
	return c.post(ctx, "/api/connector-agent/result", p, protocol.Version, nil, "connector-v1", "result-ack", id, taskID, p.Nonce, "1")
}

func (c *Client) scanResult(ctx context.Context, task protocol.Task, outcome, payload string, private ed25519.PrivateKey) error {
	p, err := protocol.NewScanResult(task, c.Version, outcome, payload, private, time.Now())
	if err != nil {
		return err
	}
	err = c.post(ctx, "/api/connector-agent/scan-result", p, 2, nil, "connector-v2", "scan-result-ack", p.ConnectorID, p.TaskID, p.Nonce, "2")
	var rejected *APIError
	if errors.As(err, &rejected) && rejected.Status == http.StatusConflict {
		// An authenticated result for a cancelled or expired task is discarded.
		// A subsequent heartbeat still verifies whether the identity is active.
		return nil
	}
	return err
}

func scanErrorCode(err error) string {
	switch {
	case errors.Is(err, datasource.ErrConnection):
		return "connection"
	case errors.Is(err, datasource.ErrPermissions):
		return "permissions"
	case errors.Is(err, datasource.ErrScope):
		return "scope"
	case errors.Is(err, datasource.ErrLimit):
		return "limit"
	default:
		return "metadata"
	}
}

func (c *Client) runScan(ctx context.Context, task protocol.Task, private ed25519.PrivateKey) error {
	store := c.SourceVault
	if store == nil {
		store = datasource.SystemVault{}
	}
	profile, err := store.Get(task.SourceID)
	if err != nil {
		return c.scanResult(ctx, task, "failed", "local_config", private)
	}
	snapshot, err := datasource.Scan(ctx, profile, task.ConnectorID, task.WorkspaceID)
	if err != nil {
		return c.scanResult(ctx, task, "failed", scanErrorCode(err), private)
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return c.scanResult(ctx, task, "failed", "metadata", private)
	}
	return c.scanResult(ctx, task, "ok", protocol.Encode(raw), private)
}

func syncHeartbeat(ctx context.Context, c *Client, cfg Config, vault Vault, private ed25519.PrivateKey) error {
	task, err := c.Heartbeat(ctx, cfg.ConnectorID, private)
	if err != nil || task == nil {
		return err
	}
	if err = protocol.VerifyTask(*task, cfg.ConnectorID, cfg.PlatformPublicKey, time.Now()); err != nil {
		return err
	}
	if task.Operation == "read_query" || task.Operation == "model_schema" || task.Operation == "model_authorize" {
		repeated, err := c.repeatedRead(*task)
		if err != nil || repeated {
			return err
		}
	}
	if c.readInProgress() && task.Operation != "cancel_read" {
		// A new signed task means the platform no longer needs the previous
		// delivery. Do not wait for an acknowledgement lost during reconnect.
		c.abandonRead()
		c.readWait.Wait()
		if err = protocol.VerifyTask(*task, cfg.ConnectorID, cfg.PlatformPublicKey, time.Now()); err != nil {
			return err
		}
	}
	if task.Operation == "read_query" || task.Operation == "model_schema" || task.Operation == "model_authorize" {
		return c.dispatchRead(ctx, cfg, *task, private)
	}
	if task.Operation == "cancel_read" {
		return c.cancelRead(ctx, *task, private)
	}
	seen, recordErr := recordTask(vault, cfg.ConnectorID, CompletedTask{ID: task.ID, Signature: task.Signature, ExpiresAt: task.ExpiresAt}, time.Now().Unix())
	if recordErr != nil && (!errors.Is(recordErr, ErrReadReplay) || !seen) {
		return recordErr
	}
	if task.Operation == "schema_scan" {
		// A lost scan response is not replayed. The platform will report expiry or
		// the already-committed result; the user can explicitly request a new scan.
		if seen {
			return nil
		}
		return c.runScan(ctx, *task, private)
	}
	return c.result(ctx, cfg.ConnectorID, task.ID, private)
}

// Sync reconciles a persisted pending rotation after network failure before accepting new work.
func Sync(ctx context.Context, c *Client, cfg Config, vault Vault) error {
	c.PlatformKey = cfg.PlatformPublicKey
	if c.readRunner == nil {
		sources := c.SourceVault
		if sources == nil {
			sources = datasource.SystemVault{}
		}
		c.readRunner = NewReadRunner(cfg, vault, sources)
	}
	state, err := vault.Get(cfg.ConnectorID)
	if err != nil {
		return err
	}
	if state.Resetting {
		return errors.New("connector reset is incomplete; run reset again")
	}
	active, err := privateKey(state.Active)
	if err != nil {
		return err
	}
	if state.Pending == "" {
		if err = c.syncMutations(ctx, cfg, active); err != nil {
			return err
		}
		return syncHeartbeat(ctx, c, cfg, vault, active)
	}
	if err = recoverRotation(ctx, c, cfg, vault, state); err != nil {
		return err
	}
	// Identity rotation invalidates the in-memory mutation admission, too.
	if c.Mutations != nil {
		c.Mutations.Close()
		c.Mutations = nil
	}
	state, err = vault.Get(cfg.ConnectorID)
	if err != nil {
		return err
	}
	active, err = privateKey(state.Active)
	if err != nil {
		return err
	}
	return syncHeartbeat(ctx, c, cfg, vault, active)
}

func recoverRotation(ctx context.Context, c *Client, cfg Config, vault Vault, state KeyState) error {
	c.PlatformKey = cfg.PlatformPublicKey
	active, err := privateKey(state.Active)
	if err != nil {
		return err
	}
	pending, err := privateKey(state.Pending)
	if err != nil {
		return err
	}
	err = c.Probe(ctx, cfg.ConnectorID, active)
	if err == nil {
		if err = c.Rotate(ctx, cfg.ConnectorID, active, pending); err != nil {
			return err
		}
	} else {
		var denied *APIError
		if !errors.As(err, &denied) || denied.Status != 403 {
			return err
		}
		if err = c.Probe(ctx, cfg.ConnectorID, pending); err != nil {
			return err
		}
	}
	state, err = vault.Get(cfg.ConnectorID)
	if err != nil {
		return err
	}
	if state.Pending == "" {
		return errors.New("pending rotation was lost")
	}
	state.Active = state.Pending
	state.Pending = ""
	return vault.Set(cfg.ConnectorID, state)
}
func StartRotation(ctx context.Context, c *Client, cfg Config, vault Vault) error {
	state, err := vault.Get(cfg.ConnectorID)
	if err != nil {
		return err
	}
	if state.Resetting {
		return errors.New("connector reset is incomplete; run reset again")
	}
	if state.Pending == "" {
		private, _, err := newKey()
		if err != nil {
			return err
		}
		state.Pending = protocol.Encode(private)
		if err = vault.Set(cfg.ConnectorID, state); err != nil {
			return err
		}
	}
	return recoverRotation(ctx, c, cfg, vault, state)
}
