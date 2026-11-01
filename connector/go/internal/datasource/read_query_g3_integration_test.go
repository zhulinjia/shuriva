//go:build amd64 || arm64

package datasource

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/testmysql"
)

// This fixture uses only the explicit fresh 13308 manifest. Its guarded admin
// connection verifies target identity on every checkout; all names are random.
func TestRefactoredReadOnFreshIsolatedMySQL(t *testing.T) {
	if os.Getenv("STAGE8_G3_MANIFEST") == "" {
		t.Skip("explicit isolated manifest required")
	}
	f := testmysql.New(t)
	dbName, username := "stage8_g2_"+f.Suffix, "s8g2_"+f.Suffix+"_read"
	var entropy [24]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		t.Fatal(err)
	}
	password := hex.EncodeToString(entropy[:])
	qdb, account := "`"+dbName+"`", "'"+username+"'@'127.0.0.1'"
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		if _, err := f.Admin.ExecContext(ctx, "DROP USER IF EXISTS "+account); err != nil {
			t.Error("cannot remove owned test account")
		}
		if _, err := f.Admin.ExecContext(ctx, "DROP DATABASE IF EXISTS "+qdb); err != nil {
			t.Error("cannot remove owned test database")
		}
	})
	f.Exec(t, "CREATE DATABASE "+qdb+" CHARACTER SET utf8mb4 COLLATE utf8mb4_bin")
	f.Exec(t, "CREATE TABLE "+qdb+".customers(id INT NOT NULL PRIMARY KEY, name VARCHAR(32) NOT NULL, amount DECIMAL(30,10), secret VARCHAR(32)) ENGINE=InnoDB")
	f.Exec(t, "INSERT INTO "+qdb+".customers VALUES(1,'one',12345678901234567890.1234567890,'hidden'),(2,'two',2.0000000000,'hidden')")
	f.Exec(t, "CREATE USER "+account+" IDENTIFIED BY '"+password+"'")
	f.Exec(t, "GRANT SELECT, SHOW VIEW ON `"+strings.ReplaceAll(dbName, "_", `\_`)+"`.* TO "+account)
	p := fixtureProfile()
	p.Host, p.Port, p.Database, p.Username, p.Password = "127.0.0.1", 13308, dbName, username, password
	workspace := p.WorkspaceIDs[0]
	p.ReadScopes = map[string]map[string][]string{workspace: {"customers": {"id", "name", "amount"}}}
	result, err := ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "SELECT id, name, amount FROM customers WHERE id >= ? ORDER BY id", []QueryParameter{{Kind: "integer", Value: "1"}}, 1)
	if err != nil {
		t.Fatalf("authorized isolated query failed: %v", err)
	}
	if !result.Truncated || result.Reason != "rows" || len(result.Rows) != 1 || result.Rows[0][0].Value != "1" || result.Rows[0][1].Value != "one" || result.Rows[0][2].Value != "12345678901234567890.1234567890" {
		t.Fatal("isolated result lost truncation or exact values")
	}
	if _, err = ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "SELECT secret FROM customers", nil, 10); err == nil {
		t.Fatal("ungranted column accepted")
	}
	if _, err = ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "UPDATE customers SET name='changed'", nil, 10); err == nil {
		t.Fatal("write accepted by read path")
	}
	model, err := CaptureModelSchema(context.Background(), p, p.ConnectorID, workspace)
	if err != nil || len(model.Tables) != 1 {
		t.Fatal("authorized fixture schema unavailable")
	}
	version := model.Tables[0].Version
	if _, err = ExecuteReadVersioned(context.Background(), p, p.ConnectorID, workspace, "SELECT id FROM customers", nil, 10, version); err != nil {
		t.Fatal("matching schema denied")
	}
	f.Exec(t, "ALTER TABLE "+qdb+".customers MODIFY name VARCHAR(64) NOT NULL")
	if _, err = ExecuteReadVersioned(context.Background(), p, p.ConnectorID, workspace, "SELECT id FROM customers", nil, 10, version); !errors.Is(err, ErrSchemaChanged) {
		t.Fatal("changed schema was not rejected")
	}
}
