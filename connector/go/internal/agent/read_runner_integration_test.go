//go:build amd64 || arm64

package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/datasource"
	"example.com/ai-database-workspace/connector/internal/protocol"
)

type fixtureReadSource struct{ profile datasource.Profile }

func (v fixtureReadSource) Get(id string) (datasource.Profile, error) {
	if id != v.profile.ID {
		return datasource.Profile{}, errors.New("missing")
	}
	return v.profile, nil
}
func (fixtureReadSource) Set(datasource.Profile) error { return errors.New("unsupported") }
func (fixtureReadSource) Delete(string) error          { return errors.New("unsupported") }

func TestSignedReadRunnerUsesLocalPolicyOnIsolatedMySQL(t *testing.T) {
	if os.Getenv("STAGE3_MYSQL_TEST") != "1" {
		t.Skip("requires dedicated isolated MySQL")
	}
	db, err := sql.Open("mysql", "root:stage3-isolated-fixture-only@tcp(127.0.0.1:13307)/?timeout=3s")
	if err != nil {
		t.Fatal("test database unavailable")
	}
	defer db.Close()
	var port int
	var dir string
	if err = db.QueryRow("SELECT @@port, @@datadir").Scan(&port, &dir); err != nil || port != 13307 || !strings.HasPrefix(strings.ToLower(strings.ReplaceAll(dir, "\\", "/")), "i:/wwwroot/stackoryn-com/.cache/stage3-mysql-data/") {
		t.Fatal("unexpected test database")
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	connector := "22222222-2222-4222-8222-222222222222"
	workspace := "33333333-3333-4333-8333-333333333333"
	source := "44444444-4444-4444-8444-444444444444"
	p := datasource.Profile{ID: source, ConnectorID: connector, WorkspaceIDs: []string{workspace}, Host: "127.0.0.1", Port: 13307, Database: "stage3_source", Username: "stage3_reader_fix", Password: "stage3-reader-fixture-only", TLS: "local", ReadScopes: map[string]map[string][]string{workspace: {"customers": {"id", "name"}}}}
	vault := &memoryVault{data: map[string]KeyState{connector: {Active: "fixture"}}}
	runner := NewReadRunner(Config{ConnectorID: connector, PlatformPublicKey: protocol.Encode(public)}, vault, fixtureReadSource{profile: p})
	payload, _ := json.Marshal(protocol.ReadRequest{SQL: "SELECT id, name FROM customers WHERE id = ?", Parameters: []protocol.ReadParameter{{Kind: "integer", Value: "1"}}, MaxRows: 10})
	now := time.Now().Unix()
	task := protocol.ReadTask{ID: "11111111-1111-4111-8111-111111111111", ConnectorID: connector, ActorID: "owner", WorkspaceID: workspace, SourceID: source, Operation: "read_query", Payload: protocol.Encode(payload), IssuedAt: now, ExpiresAt: now + 60, Nonce: protocol.Encode(make([]byte, 32)), Protocol: 1}
	signTask := func() {
		task.Signature = protocol.Encode(ed25519.Sign(private, []byte(strings.Join(protocol.ReadTaskFields(task), "\n"))))
	}
	signTask()
	result, err := runner.Execute(context.Background(), task)
	if err != nil || len(result.Columns) != 2 || result.Timezone != "UTC" {
		t.Fatalf("authorized signed query failed: %v", err)
	}
	if _, err = runner.Execute(context.Background(), task); !errors.Is(err, ErrReadReplay) {
		t.Fatal("signed query replay accepted")
	}
	task.ID = "55555555-5555-4555-8555-555555555555"
	task.WorkspaceID = "66666666-6666-4666-8666-666666666666"
	signTask()
	if _, err = runner.Execute(context.Background(), task); !errors.Is(err, datasource.ErrScope) {
		t.Fatalf("different local workspace accepted: %v", err)
	}
}

func TestSignedCancellationStopsBlockedIsolatedQuery(t *testing.T) {
	if os.Getenv("STAGE3_MYSQL_TEST") != "1" {
		t.Skip("requires isolated MySQL")
	}
	root, err := sql.Open("mysql", "root:stage3-isolated-fixture-only@tcp(127.0.0.1:13307)/?timeout=3s")
	if err != nil {
		t.Fatal("test database unavailable")
	}
	defer root.Close()
	var port int
	var dir string
	if err = root.QueryRow("SELECT @@port, @@datadir").Scan(&port, &dir); err != nil || port != 13307 || !strings.HasPrefix(strings.ToLower(strings.ReplaceAll(dir, "\\", "/")), "i:/wwwroot/stackoryn-com/.cache/stage3-mysql-data/") {
		t.Fatal("unexpected test database")
	}
	var token [5]byte
	if _, err = rand.Read(token[:]); err != nil {
		t.Fatal(err)
	}
	suffix := hex.EncodeToString(token[:])
	database := "stage4_cancel_" + suffix
	username := "s4_" + suffix
	if _, err = root.Exec("CREATE DATABASE `" + database + "`"); err != nil {
		t.Fatal("cannot create fixture")
	}
	defer func() { _, _ = root.Exec("DROP DATABASE `" + database + "`") }()
	if _, err = root.Exec("CREATE TABLE `" + database + "`.items (id INT)"); err != nil {
		t.Fatal("cannot create fixture")
	}
	if _, err = root.Exec("CREATE USER '" + username + "'@'localhost' IDENTIFIED BY 'stage4-fixture-only'"); err != nil {
		t.Fatal("cannot create fixture account")
	}
	defer func() { _, _ = root.Exec("DROP USER '" + username + "'@'localhost'") }()
	if _, err = root.Exec("GRANT SELECT, SHOW VIEW ON `" + strings.ReplaceAll(database, "_", `\_`) + "`.* TO '" + username + "'@'localhost'"); err != nil {
		t.Fatal("cannot grant fixture account")
	}
	writer, err := root.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	if _, err = writer.ExecContext(context.Background(), "LOCK TABLES `"+database+"`.items WRITE"); err != nil {
		t.Fatal("cannot hold fixture lock")
	}
	defer func() { _, _ = writer.ExecContext(context.Background(), "UNLOCK TABLES") }()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	connector := "22222222-2222-4222-8222-222222222222"
	workspace := "33333333-3333-4333-8333-333333333333"
	source := "44444444-4444-4444-8444-444444444444"
	p := datasource.Profile{ID: source, ConnectorID: connector, WorkspaceIDs: []string{workspace}, Host: "127.0.0.1", Port: 13307, Database: database, Username: username, Password: "stage4-fixture-only", TLS: "local", ReadScopes: map[string]map[string][]string{workspace: {"items": {"id"}}}}
	vault := &memoryVault{data: map[string]KeyState{connector: {Active: "fixture"}}}
	runner := NewReadRunner(Config{ConnectorID: connector, PlatformPublicKey: protocol.Encode(public)}, vault, fixtureReadSource{profile: p})
	payload, _ := json.Marshal(protocol.ReadRequest{SQL: "SELECT id FROM items", Parameters: []protocol.ReadParameter{}, MaxRows: 10})
	now := time.Now().Unix()
	task := protocol.ReadTask{ID: "11111111-1111-4111-8111-111111111111", ConnectorID: connector, ActorID: "owner", WorkspaceID: workspace, SourceID: source, Operation: "read_query", Payload: protocol.Encode(payload), IssuedAt: now, ExpiresAt: now + 60, Nonce: protocol.Encode(make([]byte, 32)), Protocol: 1}
	task.Signature = protocol.Encode(ed25519.Sign(private, []byte(strings.Join(protocol.ReadTaskFields(task), "\n"))))
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	done := make(chan error, 1)
	go func() { _, err := runner.Execute(ctx, task); done <- err }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		runner.activeMu.Lock()
		active := runner.active != nil
		runner.activeMu.Unlock()
		if active {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("signed task did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(200 * time.Millisecond)
	cancel := protocol.ReadCancel{TaskID: task.ID, ConnectorID: connector, ActorID: task.ActorID, WorkspaceID: workspace, SourceID: source, IssuedAt: now, ExpiresAt: now + 60, Nonce: protocol.Encode(make([]byte, 32))}
	cancel.Signature = protocol.Encode(ed25519.Sign(private, []byte(strings.Join(protocol.ReadCancelFields(cancel), "\n"))))
	if ok, err := runner.Cancel(cancel); err != nil || !ok {
		t.Fatal("signed cancellation rejected")
	}
	select {
	case err := <-done:
		if !errors.Is(err, datasource.ErrQueryCancelled) {
			t.Fatalf("blocked query was not cancelled: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("blocked query did not stop")
	}
}
