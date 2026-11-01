package cli

import (
	"bytes"
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"example.com/ai-database-workspace/connector/internal/agent"
	"example.com/ai-database-workspace/connector/internal/datasource"
	"example.com/ai-database-workspace/connector/internal/protocol"
	_ "github.com/go-sql-driver/mysql"
)

func TestLocalReadScopeCLIWithIsolatedMetadata(t *testing.T) {
	if os.Getenv("STAGE3_MYSQL_TEST") != "1" || os.Getenv("STAGE3_KEYRING_TEST") != "1" {
		t.Skip("requires isolated database and test credential store")
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
	connector, err := datasource.NewID()
	if err != nil {
		t.Fatal(err)
	}
	workspace, err := datasource.NewID()
	if err != nil {
		t.Fatal(err)
	}
	id, err := datasource.NewID()
	if err != nil {
		t.Fatal(err)
	}
	profile := datasource.Profile{ID: id, ConnectorID: connector, WorkspaceIDs: []string{workspace}, Host: "127.0.0.1", Port: 13307, Database: "stage3_source", Username: "stage3_reader_fix", Password: "stage3-reader-fixture-only", TLS: "local"}
	vault := datasource.SystemVault{}
	if err := vault.Set(profile); err != nil {
		t.Fatal("cannot store synthetic credential")
	}
	t.Cleanup(func() { _ = vault.Delete(id) })
	path := filepath.Join(t.TempDir(), "connector.json")
	if err = agent.WriteConfig(path, agent.Config{ConnectorID: connector, Server: "http://127.0.0.1:3000", Name: "fixture", PlatformPublicKey: protocol.Encode(make([]byte, 32))}); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	run := func(args ...string) error { return sourceCommand(context.Background(), args, nil, &out, &stderr, path) }
	if err = run("read-allow", "--id", id, "--workspace", workspace, "--table", "customers", "--columns", "id,name"); err != nil {
		t.Fatal(err)
	}
	stored, err := vault.Get(id)
	if err != nil || len(stored.ReadScopes[workspace]["customers"]) != 2 {
		t.Fatal("policy was not persisted")
	}
	if err = run("read-allow", "--id", id, "--workspace", workspace, "--table", "customer_names", "--columns", "name"); err == nil {
		t.Fatal("view was authorized")
	}
	if err = run("disallow", "--id", id, "--workspace", workspace); err != nil {
		t.Fatal(err)
	}
	stored, err = vault.Get(id)
	if err != nil || len(stored.ReadScopes) != 0 || stored.Allows(workspace) {
		t.Fatal("revocation did not clear local policy")
	}
}
