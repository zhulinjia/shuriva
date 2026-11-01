// Isolated cross-language test; all credentials and data are synthetic.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"example.com/ai-database-workspace/connector/internal/agent"
	"example.com/ai-database-workspace/connector/internal/datasource"
)

type identityVault struct {
	mu   sync.Mutex
	data map[string]agent.KeyState
}

func (v *identityVault) Get(id string) (agent.KeyState, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	s, ok := v.data[id]
	if !ok {
		return s, errors.New("missing")
	}
	return s, nil
}
func (v *identityVault) Set(id string, s agent.KeyState) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.data[id] = s
	return nil
}
func (v *identityVault) Delete(id string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	delete(v.data, id)
	return nil
}

type sourceVault struct{ profile datasource.Profile }

func (v sourceVault) Get(id string) (datasource.Profile, error) {
	if id != v.profile.ID {
		return datasource.Profile{}, errors.New("missing")
	}
	return v.profile, nil
}
func (sourceVault) Set(datasource.Profile) error { return errors.New("unsupported") }
func (sourceVault) Delete(string) error          { return errors.New("unsupported") }
func (v sourceVault) AcquireModelLease(id, connectorID string, until int64) (datasource.Profile, error) {
	if id != v.profile.ID || connectorID != v.profile.ConnectorID || until <= time.Now().Unix() {
		return datasource.Profile{}, errors.New("invalid synthetic lease")
	}
	v.profile.ModelLeaseUntil = until
	return v.profile, nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "stage 4 probe failed:", err)
		os.Exit(1)
	}
}
func run() error {
	var in struct{ Server, Code, Owner, Workspace, Source, Database, Username, Password string }
	if err := json.NewDecoder(os.Stdin).Decode(&in); err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "stage4-probe-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	vault := &identityVault{data: map[string]agent.KeyState{}}
	ctx := context.Background()
	path := filepath.Join(dir, "config.json")
	if err = agent.PairNew(ctx, path, in.Server, "isolated test", in.Code, "test", vault); err != nil {
		return err
	}
	cfg, err := agent.ReadConfig(path)
	if err != nil {
		return err
	}
	var request func(method, path string, body any, out any) error
	request = func(method, path string, body any, out any) error {
		if method == "POST" && (strings.HasSuffix(path, "/queries") || strings.HasSuffix(path, "/queries/model-schema")) {
			query, ok := body.(map[string]any)
			if !ok {
				return errors.New("invalid fixture query")
			}
			if strings.HasSuffix(path, "/queries") {
				if _, exists := query["schemaVersion"]; !exists {
					query["schemaVersion"] = nil
				}
			}
			if _, exists := query["scopeToken"]; !exists {
				var authorization struct {
					InstanceID string `json:"instanceId"`
					ScopeToken string `json:"scopeToken"`
				}
				scopePath := strings.TrimSuffix(path, "/model-schema") + "/scope"
				if err := request("GET", scopePath, nil, &authorization); err != nil {
					return err
				}
				query["instanceId"] = authorization.InstanceID
				query["scopeToken"] = authorization.ScopeToken
				query["submittedAt"] = time.Now().UnixMilli()
			}
			if _, exists := query["requestId"]; !exists {
				var id [16]byte
				if _, err := rand.Read(id[:]); err != nil {
					return err
				}
				id[6] = (id[6] & 0x0f) | 0x40
				id[8] = (id[8] & 0x3f) | 0x80
				query["requestId"] = fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
			}
		}
		var data []byte
		if body != nil {
			data, _ = json.Marshal(body)
		}
		req, e := http.NewRequest(method, in.Server+path, bytes.NewReader(data))
		if e != nil {
			return e
		}
		req.Header.Set("Origin", "http://127.0.0.1:5173")
		req.Header.Set("X-Test-Owner", in.Owner)
		req.Header.Set("Content-Type", "application/json")
		res, e := http.DefaultClient.Do(req)
		if e != nil {
			return e
		}
		defer res.Body.Close()
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			return &probeAPIError{method: method, path: path, status: res.StatusCode}
		}
		if out != nil {
			return json.NewDecoder(res.Body).Decode(out)
		}
		return nil
	}
	if err = request("POST", "/api/data-sources", map[string]string{"id": in.Source, "connectorId": cfg.ConnectorID, "name": "synthetic source"}, nil); err != nil {
		return err
	}
	base := "/api/data-sources/workspaces/" + in.Workspace + "/" + in.Source
	if err = request("PUT", base, nil, nil); err != nil {
		return err
	}
	client, err := agent.NewClient(cfg.Server, "test")
	if err != nil {
		return err
	}
	sources := sourceVault{profile: datasource.Profile{ID: in.Source, ConnectorID: cfg.ConnectorID, WorkspaceIDs: []string{in.Workspace}, Host: "127.0.0.1", Port: 13307, Database: in.Database, Username: in.Username, Password: in.Password, TLS: "local", ReadScopes: map[string]map[string][]string{in.Workspace: {"customers": {"id", "name"}}}}}
	client.SourceVault = sources
	var job struct{ ID string }
	query := map[string]any{"sql": "SELECT id, name FROM customers WHERE id = ?", "parameters": []map[string]string{{"kind": "integer", "value": "1"}}, "maxRows": 10}
	// The test server commits the first creation, then drops its response.
	if err = request("POST", base+"/queries", query, &job); err == nil {
		return errors.New("fixture did not lose creation acknowledgement")
	}
	if err = request("POST", base+"/queries", query, &job); err != nil {
		return err
	}
	if job.ID != query["requestId"] {
		return errors.New("retry returned a different query ID")
	}
	// Likewise, the first heartbeat response is lost after task dispatch.
	if err = agent.Sync(ctx, client, cfg, vault); err == nil {
		return errors.New("fixture did not lose heartbeat response")
	}
	if err = agent.Sync(ctx, client, cfg, vault); err != nil {
		return err
	}
	var result struct{ State, Payload string }
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if err = request("GET", base+"/queries/"+job.ID, nil, &result); err != nil {
			return err
		}
		if result.State == "completed" {
			break
		}
		if result.State != "running" && result.State != "queued" {
			return fmt.Errorf("query status: %s", result.State)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if result.State != "completed" {
		return errors.New("query timed out")
	}
	// The fixture deliberately drops the first acknowledgement after commit.
	// A new signed result delivery must succeed without executing SQL again.
	var attempts struct{ Attempts int }
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if err = request("GET", "/fixture/read-attempts", nil, &attempts); err != nil {
			return err
		}
		if attempts.Attempts >= 2 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if attempts.Attempts < 2 {
		return errors.New("lost result acknowledgement was not retried")
	}
	completed := result
	var schemaJob struct{ ID string }
	schemaRequest := map[string]any{}
	if err = request("POST", base+"/queries/model-schema", schemaRequest, &schemaJob); err != nil {
		return err
	}
	if err = agent.Sync(ctx, client, cfg, vault); err != nil {
		return err
	}
	result = struct{ State, Payload string }{}
	deadline = time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if err = request("GET", base+"/queries/"+schemaJob.ID, nil, &result); err != nil {
			return err
		}
		if result.State == "completed" {
			break
		}
		if result.State != "running" && result.State != "queued" {
			return fmt.Errorf("model schema status: %s", result.State)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if result.State != "completed" {
		return errors.New("model schema timed out")
	}
	rawSchema, err := base64.RawURLEncoding.DecodeString(result.Payload)
	if err != nil {
		return errors.New("invalid model schema payload")
	}
	var modelSchema datasource.ModelSchema
	if json.Unmarshal(rawSchema, &modelSchema) != nil || modelSchema.Database != in.Database || len(modelSchema.Tables) != 1 || modelSchema.Tables[0].Name != "customers" || len(modelSchema.Tables[0].Columns) != 2 || modelSchema.Tables[0].Columns[0].Name != "id" || modelSchema.Tables[0].Columns[1].Name != "name" || strings.Contains(string(rawSchema), "secret") {
		return errors.New("model schema includes unauthorized or invalid fields")
	}
	var preview struct {
		SchemaHash  string `json:"schemaHash"`
		Destination struct {
			BaseURL       string `json:"baseUrl"`
			Model         string `json:"model"`
			ConfigVersion string `json:"configVersion"`
		} `json:"destination"`
	}
	if err = request("GET", base+"/queries/"+schemaJob.ID+"/model-preview", nil, &preview); err != nil {
		return err
	}
	planInput := map[string]any{"instanceId": schemaRequest["instanceId"], "scopeToken": schemaRequest["scopeToken"], "submittedAt": time.Now().UnixMilli(), "question": "查询客户编号", "schemaHash": preview.SchemaHash, "baseUrl": preview.Destination.BaseURL, "model": preview.Destination.Model, "configVersion": preview.Destination.ConfigVersion}
	var modelPlan struct {
		Plan struct {
			Kind          string `json:"kind"`
			SQL           string `json:"sql"`
			Parameters    []any  `json:"parameters"`
			MaxRows       int    `json:"maxRows"`
			SchemaVersion string `json:"schemaVersion"`
		} `json:"plan"`
	}
	planDone := make(chan error, 1)
	go func() {
		planDone <- request("POST", base+"/queries/"+schemaJob.ID+"/model-plan", planInput, &modelPlan)
	}()
	deadline = time.Now().Add(25 * time.Second)
	for {
		select {
		case err = <-planDone:
			if err != nil {
				return err
			}
			goto planReady
		default:
			if time.Now().After(deadline) {
				return errors.New("model authorization timed out")
			}
			if err = agent.Sync(ctx, client, cfg, vault); err != nil {
				return err
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
planReady:
	if modelPlan.Plan.Kind != "query" || modelPlan.Plan.SQL != "SELECT `id`, `name` FROM `customers`" {
		return errors.New("invalid model plan")
	}
	var generated struct{ ID string }
	if err = request("POST", base+"/queries", map[string]any{"sql": modelPlan.Plan.SQL, "parameters": modelPlan.Plan.Parameters, "maxRows": modelPlan.Plan.MaxRows, "schemaVersion": modelPlan.Plan.SchemaVersion}, &generated); err != nil {
		return err
	}
	if err = agent.Sync(ctx, client, cfg, vault); err != nil {
		return err
	}
	result = struct{ State, Payload string }{}
	deadline = time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if err = request("GET", base+"/queries/"+generated.ID, nil, &result); err != nil {
			return err
		}
		if result.State == "completed" {
			break
		}
		if result.State != "running" && result.State != "queued" {
			return fmt.Errorf("model query status: %s", result.State)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if result.State != "completed" {
		return errors.New("model query timed out")
	}
	var denied struct{ ID string }
	if err = request("POST", base+"/queries", map[string]any{"sql": "SELECT secret FROM customers", "parameters": []any{}, "maxRows": 10}, &denied); err != nil {
		return err
	}
	if err = agent.Sync(ctx, client, cfg, vault); err != nil {
		return err
	}
	result = struct{ State, Payload string }{}
	deadline = time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if err = request("GET", base+"/queries/"+denied.ID, nil, &result); err != nil {
			return err
		}
		if result.State == "failed" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if result.State != "failed" || result.Payload != "denied" {
		return errors.New("unauthorized field not rejected")
	}
	// Hold a lock only on this test's synthetic table and verify that a
	// cancelled read cannot publish a result, including after lock release.
	if !regexp.MustCompile(`^stage4s_[0-9a-f]{16}$`).MatchString(in.Database) || !regexp.MustCompile(`^s4_[0-9a-f]{12}$`).MatchString(in.Username) {
		return errors.New("invalid synthetic fixture")
	}
	root, err := sql.Open("mysql", "root:stage3-isolated-fixture-only@tcp(127.0.0.1:13307)/?timeout=3s")
	if err != nil {
		return err
	}
	defer root.Close()
	var port int
	var dirName string
	if err = root.QueryRow("SELECT @@port, @@datadir").Scan(&port, &dirName); err != nil || port != 13307 || !strings.HasPrefix(strings.ToLower(strings.ReplaceAll(dirName, "\\", "/")), "i:/wwwroot/stackoryn-com/.cache/stage3-mysql-data/") {
		return errors.New("unexpected fixture instance")
	}
	if err = verifySemanticStructure(ctx, client, cfg, vault, root, request, base, in.Workspace, in.Source, in.Database); err != nil {
		return err
	}
	writer, err := root.Conn(ctx)
	if err != nil {
		return err
	}
	defer writer.Close()
	if _, err = writer.ExecContext(ctx, "LOCK TABLES `"+in.Database+"`.customers WRITE"); err != nil {
		return err
	}
	defer writer.ExecContext(context.Background(), "UNLOCK TABLES")
	var blocked struct{ ID string }
	if err = request("POST", base+"/queries", map[string]any{"sql": "SELECT id FROM customers", "parameters": []any{}, "maxRows": 10}, &blocked); err != nil {
		return err
	}
	if err = agent.Sync(ctx, client, cfg, vault); err != nil {
		return err
	}
	countConnections := func() (int, error) {
		var count int
		e := root.QueryRow("SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER = ?", in.Username).Scan(&count)
		return count, e
	}
	waitForLock := func(label string) error {
		deadline := time.Now().Add(5 * time.Second)
		statement := "SHOW COLUMNS FROM `" + in.Database + "`.`customers`"
		selectFrom := "FROM `" + in.Database + "`.`customers`"
		var lastState string
		for time.Now().Before(deadline) {
			var count int
			err := root.QueryRow("SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER = ? AND STATE = 'Waiting for table metadata lock' AND (INFO = ? OR (UPPER(LEFT(INFO, 7)) = 'SELECT ' AND INSTR(INFO, ?) > 0))", in.Username, statement, selectFrom).Scan(&count)
			if err != nil {
				return err
			}
			if count == 1 {
				return nil
			}
			_ = root.QueryRow("SELECT COALESCE(STATE, '') FROM information_schema.PROCESSLIST WHERE USER = ? LIMIT 1", in.Username).Scan(&lastState)
			time.Sleep(30 * time.Millisecond)
		}
		return fmt.Errorf("%s query never reached the expected metadata lock wait: state=%q", label, lastState)
	}
	if err = waitForLock("cancellation"); err != nil {
		return err
	}
	if err = request("DELETE", base+"/queries/"+blocked.ID, nil, nil); err != nil {
		return err
	}
	if err = agent.Sync(ctx, client, cfg, vault); err != nil {
		return err
	}
	var readBusy struct{ Busy bool }
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if err = request("GET", "/fixture/read-busy/"+cfg.ConnectorID, nil, &readBusy); err != nil {
			return err
		}
		if !readBusy.Busy {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if readBusy.Busy {
		return errors.New("cancellation was not acknowledged")
	}
	if _, err = writer.ExecContext(ctx, "UNLOCK TABLES"); err != nil {
		return err
	}
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		count, e := countConnections()
		if e != nil {
			return e
		}
		if count == 0 {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if count, e := countConnections(); e != nil || count != 0 {
		return errors.New("cancelled fixture connection did not close after unlock")
	}
	result = struct{ State, Payload string }{}
	if err = request("GET", base+"/queries/"+blocked.ID, nil, &result); err != nil || result.State != "cancelled" || result.Payload != "" {
		return errors.New("cancelled query published a result")
	}
	if _, err = writer.ExecContext(ctx, "LOCK TABLES `"+in.Database+"`.customers WRITE"); err != nil {
		return err
	}
	var unbound struct{ ID string }
	if err = request("POST", base+"/queries", map[string]any{"sql": "SELECT id FROM customers", "parameters": []any{}, "maxRows": 10}, &unbound); err != nil {
		return err
	}
	if err = agent.Sync(ctx, client, cfg, vault); err != nil {
		return err
	}
	if err = waitForLock("unbind"); err != nil {
		return err
	}
	if err = request("DELETE", base, nil, nil); err != nil {
		return err
	}
	if err = agent.Sync(ctx, client, cfg, vault); err != nil {
		return err
	}
	deadline = time.Now().Add(5 * time.Second)
	readBusy.Busy = true
	for time.Now().Before(deadline) {
		if err = request("GET", "/fixture/read-busy/"+cfg.ConnectorID, nil, &readBusy); err != nil {
			return err
		}
		if !readBusy.Busy {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if readBusy.Busy {
		return errors.New("unbind cancellation was not acknowledged")
	}
	if _, err = writer.ExecContext(ctx, "UNLOCK TABLES"); err != nil {
		return err
	}
	if err = request("PUT", base, nil, nil); err != nil {
		return err
	}
	result = struct{ State, Payload string }{}
	if err = request("GET", base+"/queries/"+unbound.ID, nil, &result); err != nil || result.State != "cancelled" || result.Payload != "" {
		return errors.New("unbound query published a result")
	}
	var cancelled struct{ ID string }
	if err = request("POST", base+"/queries", map[string]any{"sql": "SELECT id FROM customers", "parameters": []any{}, "maxRows": 10}, &cancelled); err != nil {
		return err
	}
	if err = request("DELETE", base+"/queries/"+cancelled.ID, nil, nil); err != nil {
		return err
	}
	result = struct{ State, Payload string }{}
	if err = request("GET", base+"/queries/"+cancelled.ID, nil, &result); err != nil || result.State != "cancelled" {
		return errors.New("queued cancellation failed")
	}
	if err = request("DELETE", base, nil, nil); err != nil {
		return err
	}
	if err = request("PUT", base, nil, nil); err != nil {
		return err
	}
	result = struct{ State, Payload string }{}
	if err = request("GET", base+"/queries/"+job.ID, nil, &result); err != nil || result.State != "cancelled" || result.Payload != "" {
		return errors.New("unbound results retained")
	}
	// Exercise the actual long-running connector lifecycle and a platform
	// revocation while its query is blocked on our synthetic table.
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		count, e := countConnections()
		if e != nil {
			return e
		}
		if count == 0 {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if count, e := countConnections(); e != nil || count != 0 {
		return errors.New("prior fixture connection did not close")
	}
	if _, err = writer.ExecContext(ctx, "LOCK TABLES `"+in.Database+"`.customers WRITE"); err != nil {
		return err
	}
	var revoked struct{ ID string }
	if err = request("POST", base+"/queries", map[string]any{"sql": "SELECT id FROM customers", "parameters": []any{}, "maxRows": 10}, &revoked); err != nil {
		return err
	}
	var before struct{ Attempts int }
	if err = request("GET", "/fixture/read-attempts", nil, &before); err != nil {
		return err
	}
	runCtx, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	done := make(chan error, 1)
	go func() { done <- agent.RunWithSources(runCtx, cfg, "test", vault, sources, io.Discard) }()
	if err = waitForLock("revocation"); err != nil {
		return err
	}
	if err = request("POST", "/api/connectors/"+cfg.ConnectorID+"/revoke", nil, nil); err != nil {
		return err
	}
	select {
	case runErr := <-done:
		var denied *agent.APIError
		if !errors.As(runErr, &denied) || denied.Status != http.StatusForbidden {
			return errors.New("revoked connector did not stop on forbidden response")
		}
	case <-runCtx.Done():
		return errors.New("revoked connector failed to stop")
	}
	result = struct{ State, Payload string }{}
	statusPath := "/fixture/read-status/" + cfg.ConnectorID + "/" + revoked.ID
	if err = request("GET", statusPath, nil, &result); err != nil || result.State != "cancelled" || result.Payload != "" {
		return errors.New("revoked task retained a result")
	}
	if _, err = writer.ExecContext(ctx, "UNLOCK TABLES"); err != nil {
		return err
	}
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		count, e := countConnections()
		if e != nil {
			return e
		}
		if count == 0 {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if count, e := countConnections(); e != nil || count != 0 {
		return errors.New("revoked fixture connection did not close after unlock")
	}
	result = struct{ State, Payload string }{}
	if err = request("GET", statusPath, nil, &result); err != nil || result.State != "cancelled" || result.Payload != "" {
		return errors.New("revoked task published a late result")
	}
	var after struct{ Attempts int }
	if err = request("GET", "/fixture/read-attempts", nil, &after); err != nil || after.Attempts != before.Attempts {
		return errors.New("revoked connector attempted to deliver a result")
	}
	return json.NewEncoder(os.Stdout).Encode(completed)
}
