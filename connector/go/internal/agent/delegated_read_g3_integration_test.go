//go:build amd64 || arm64

package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/datasource"
	"example.com/ai-database-workspace/connector/internal/protocol"
	"example.com/ai-database-workspace/connector/internal/queryguard"
	"example.com/ai-database-workspace/connector/internal/testmysql"
)

// The test server, schema, user and password are generated solely for this
// guarded instance. The locally approved secret column must not be disclosed
// through an MCP delegation limited to the id column.
func TestDelegatedSignedReadUsesIntersectionOnFreshMySQL(t *testing.T) {
	if os.Getenv("STAGE8_G3_MANIFEST") == "" {
		t.Skip("requires explicit fresh isolated instance")
	}
	f := testmysql.New(t)
	database, user := "stage8_g2_"+f.Suffix, "s8g2_"+f.Suffix+"_read"
	var entropy [24]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		t.Fatal(err)
	}
	password := hex.EncodeToString(entropy[:])
	qdb, account := "`"+database+"`", "'"+user+"'@'127.0.0.1'"
	databaseCreated, userCreated := false, false
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		if userCreated {
			if _, err := f.Admin.ExecContext(ctx, "DROP USER IF EXISTS "+account); err != nil {
				t.Error("cannot remove owned test account")
			}
		}
		if databaseCreated {
			if _, err := f.Admin.ExecContext(ctx, "DROP DATABASE IF EXISTS "+qdb); err != nil {
				t.Error("cannot remove owned test database")
			}
		}
	})
	f.Exec(t, "CREATE DATABASE "+qdb+" CHARACTER SET utf8mb4 COLLATE utf8mb4_bin")
	databaseCreated = true
	f.Exec(t, "CREATE TABLE "+qdb+".customers(id INT NOT NULL PRIMARY KEY, secret VARCHAR(32)) ENGINE=InnoDB")
	f.Exec(t, "INSERT INTO "+qdb+".customers VALUES(1,'synthetic')")
	f.Exec(t, "CREATE USER "+account+" IDENTIFIED BY '"+password+"'")
	userCreated = true
	f.Exec(t, "GRANT SELECT, SHOW VIEW ON `"+strings.ReplaceAll(database, "_", `\_`)+"`.* TO "+account)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	connector := "22222222-2222-4222-8222-222222222222"
	workspace := "33333333-3333-4333-8333-333333333333"
	source := "44444444-4444-4444-8444-444444444444"
	p := datasource.Profile{ID: source, ConnectorID: connector, WorkspaceIDs: []string{workspace}, Host: "127.0.0.1", Port: 13308, Database: database, Username: user, Password: password, TLS: "local", ReadScopes: map[string]map[string][]string{workspace: {"customers": {"id", "secret"}}}}
	vault := &memoryVault{data: map[string]KeyState{connector: {Active: "fixture"}}}
	runner := NewReadRunner(Config{ConnectorID: connector, PlatformPublicKey: protocol.Encode(public)}, vault, fixtureReadSource{profile: p})
	query := func(id, sql string, delegated map[string][]string) (datasource.QueryResult, error) {
		payload, err := json.Marshal(protocol.ReadRequest{SQL: sql, Parameters: []protocol.ReadParameter{}, MaxRows: 10, DelegatedScope: delegated})
		if err != nil {
			return datasource.QueryResult{}, err
		}
		now := time.Now().Unix()
		task := protocol.ReadTask{ID: id, ConnectorID: connector, ActorID: "owner", WorkspaceID: workspace, SourceID: source, Operation: "read_query", Payload: protocol.Encode(payload), IssuedAt: now, ExpiresAt: now + 60, Nonce: protocol.Encode(make([]byte, 32)), Protocol: 1}
		task.Signature = protocol.Encode(ed25519.Sign(private, []byte(strings.Join(protocol.ReadTaskFields(task), "\n"))))
		return runner.Execute(context.Background(), task)
	}
	grant := map[string][]string{"customers": {"id"}}
	schemaPayload, err := json.Marshal(struct {
		DelegatedScope map[string][]string `json:"delegatedScope"`
	}{DelegatedScope: grant})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	schemaTask := protocol.ReadTask{ID: "88888888-8888-4888-8888-888888888888", ConnectorID: connector, ActorID: "owner", WorkspaceID: workspace, SourceID: source, Operation: "model_schema", Payload: protocol.Encode(schemaPayload), IssuedAt: now, ExpiresAt: now + 60, Nonce: protocol.Encode(make([]byte, 32)), Protocol: 1}
	schemaTask.Signature = protocol.Encode(ed25519.Sign(private, []byte(strings.Join(protocol.ReadTaskFields(schemaTask), "\n"))))
	schema, err := runner.ExecuteModelSchema(context.Background(), schemaTask)
	if err != nil || len(schema.Tables) != 1 || len(schema.Tables[0].Columns) != 1 || schema.Tables[0].Columns[0].Name != "id" {
		t.Fatal("delegated schema exposed an unauthorized field or rejected an authorized one", err)
	}
	ordinarySchemaTask := schemaTask
	ordinarySchemaTask.ID = "99999999-9999-4999-8999-999999999999"
	ordinarySchemaTask.Payload = protocol.Encode([]byte("{}"))
	ordinarySchemaTask.Signature = protocol.Encode(ed25519.Sign(private, []byte(strings.Join(protocol.ReadTaskFields(ordinarySchemaTask), "\n"))))
	ordinarySchema, err := runner.ExecuteModelSchema(context.Background(), ordinarySchemaTask)
	if err != nil || len(ordinarySchema.Tables) != 1 || len(ordinarySchema.Tables[0].Columns) != 2 {
		t.Fatal("ordinary local schema authorization changed", err)
	}
	if _, err = query("55555555-5555-4555-8555-555555555555", "SELECT secret FROM customers", grant); err == nil {
		t.Fatal("delegation allowed an unapproved field")
	}
	result, err := query("66666666-6666-4666-8666-666666666666", "SELECT id FROM customers", grant)
	if err != nil || len(result.Rows) != 1 || result.Rows[0][0].Value != "1" {
		t.Fatal("authorized delegated read failed", err)
	}
	if _, err = query("77777777-7777-4777-8777-777777777777", "SELECT secret FROM customers", nil); err != nil {
		t.Fatal("ordinary locally authorized read was changed", err)
	}
	// An external grant can be broader than the Connector's current policy.
	// Both SQL and schema disclosure must still enforce the narrower local side.
	p.ReadScopes = map[string]map[string][]string{workspace: {"customers": {"id"}}}
	runner = NewReadRunner(Config{ConnectorID: connector, PlatformPublicKey: protocol.Encode(public)}, vault, fixtureReadSource{profile: p})
	wider := map[string][]string{"customers": {"id", "secret"}}
	widerPayload, err := json.Marshal(struct {
		DelegatedScope map[string][]string `json:"delegatedScope"`
	}{DelegatedScope: wider})
	if err != nil {
		t.Fatal(err)
	}
	widerSchemaTask := schemaTask
	widerSchemaTask.ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	widerSchemaTask.Payload = protocol.Encode(widerPayload)
	widerSchemaTask.Signature = protocol.Encode(ed25519.Sign(private, []byte(strings.Join(protocol.ReadTaskFields(widerSchemaTask), "\n"))))
	widerSchema, err := runner.ExecuteModelSchema(context.Background(), widerSchemaTask)
	if err != nil || len(widerSchema.Tables) != 1 || len(widerSchema.Tables[0].Columns) != 1 || widerSchema.Tables[0].Columns[0].Name != "id" {
		t.Fatal("delegated schema exceeded local field authorization", err)
	}
	if _, err = query("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "SELECT secret FROM customers", wider); !errors.Is(err, queryguard.ErrDenied) {
		t.Fatal("delegated SQL was not denied by local field authorization", err)
	}
	narrowedResult, err := query("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "SELECT id FROM customers", wider)
	if err != nil || len(narrowedResult.Rows) != 1 || narrowedResult.Rows[0][0].Value != "1" {
		t.Fatal("authorized intersection query failed", err)
	}
}
