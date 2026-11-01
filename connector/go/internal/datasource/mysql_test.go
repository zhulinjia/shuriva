package datasource

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/zalando/go-keyring"
)

func fixtureProfile() Profile {
	return Profile{ID: "11111111-1111-4111-8111-111111111111", ConnectorID: "33333333-3333-4333-8333-333333333333", WorkspaceIDs: []string{"22222222-2222-4222-8222-222222222222"}, Host: "127.0.0.1", Port: 13307, Database: "stage3_source", Username: "stage3_reader_fix", Password: "stage3-reader-fixture-only", TLS: "local"}
}

func TestProfileScopeAndTransport(t *testing.T) {
	p := fixtureProfile()
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	p.Host = "example.com"
	if p.Validate() == nil {
		t.Fatal("remote plaintext accepted")
	}
	p.TLS = "required"
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	p.Host = "example.com/path"
	if p.Validate() == nil {
		t.Fatal("invalid hostname accepted")
	}
	p = fixtureProfile()
	p.WorkspaceIDs = []string{"untrusted"}
	if _, err := Scan(context.Background(), p, p.ConnectorID, "different"); !errors.Is(err, ErrScope) {
		t.Fatal("scope not rejected")
	}
	p = fixtureProfile()
	if _, err := Scan(context.Background(), p, "44444444-4444-4444-8444-444444444444", p.WorkspaceIDs[0]); !errors.Is(err, ErrScope) {
		t.Fatal("different connector accepted")
	}
	p.Database = "mysql"
	if p.Validate() == nil {
		t.Fatal("system database accepted")
	}
}

func TestGrantScopeEscapesMySQLWildcards(t *testing.T) {
	if got := grantScope("foo_bar%", false); got != "`foo\\_bar\\%`.*" {
		t.Fatalf("unsafe grant scope: %q", got)
	}
	if got := grantScope("foo_bar%", true); got != "`foo_bar%`.*" {
		t.Fatalf("literal grant scope: %q", got)
	}
}

func TestScanIsolatedMySQL(t *testing.T) {
	if os.Getenv("STAGE3_MYSQL_TEST") != "1" {
		t.Skip("requires the dedicated test instance on 127.0.0.1:13307")
	}
	db, err := sql.Open("mysql", "root:stage3-isolated-fixture-only@tcp(127.0.0.1:13307)/stage3_platform?timeout=3s")
	if err != nil {
		t.Fatal("cannot inspect isolated test instance")
	}
	var port int
	var dir string
	err = db.QueryRowContext(context.Background(), "SELECT @@port, @@datadir").Scan(&port, &dir)
	db.Close()
	if err != nil || port != 13307 || !strings.HasPrefix(strings.ToLower(strings.ReplaceAll(dir, "\\", "/")), "i:/wwwroot/stackoryn-com/.cache/stage3-mysql-data/") {
		t.Fatal("unexpected test instance")
	}
	p := fixtureProfile()
	s, err := Scan(context.Background(), p, p.ConnectorID, p.WorkspaceIDs[0])
	if err != nil {
		t.Fatal(err)
	}
	if s.Database != "stage3_source" || len(s.Tables) != 3 || len(s.Columns) != 6 || len(s.Relations) != 1 {
		t.Fatalf("unexpected metadata: tables=%d columns=%d relations=%d", len(s.Tables), len(s.Columns), len(s.Relations))
	}
	if s.Relations[0].ReferencedTable != "customers" {
		t.Fatal("missing foreign key")
	}
	p.Database = "stage3_outside"
	if _, err := Scan(context.Background(), p, p.ConnectorID, p.WorkspaceIDs[0]); err == nil {
		t.Fatal("unauthorized schema accepted")
	}
	p = fixtureProfile()
	p.Username = "stage3_reader" // test fixture has an unescaped wildcard in its grant
	if _, err := Scan(context.Background(), p, p.ConnectorID, p.WorkspaceIDs[0]); !errors.Is(err, ErrPermissions) {
		t.Fatalf("wildcard schema grant was not rejected: %v", err)
	}
	p = fixtureProfile()
	p.Username = "root"
	p.Password = "stage3-isolated-fixture-only"
	if _, err := Scan(context.Background(), p, p.ConnectorID, p.WorkspaceIDs[0]); !errors.Is(err, ErrPermissions) {
		t.Fatalf("privileged account was not rejected: %v", err)
	}
	p = fixtureProfile()
	p.Password = "wrong-fixture-password"
	_, err = Scan(context.Background(), p, p.ConnectorID, p.WorkspaceIDs[0])
	if !errors.Is(err, ErrConnection) || strings.Contains(err.Error(), p.Password) {
		t.Fatal("connection error was not safely reported")
	}
}

func TestSystemVaultSyntheticCredential(t *testing.T) {
	if os.Getenv("STAGE3_KEYRING_TEST") != "1" {
		t.Skip("requires the OS credential store")
	}
	p := fixtureProfile()
	id, err := NewID()
	if err != nil {
		t.Fatal(err)
	}
	p.ID = id
	store := SystemVault{}
	if err = store.Set(p); err != nil {
		t.Fatal(err)
	}
	ids, err := store.List(p.ConnectorID)
	if err != nil || len(ids) != 1 || ids[0] != p.ID {
		t.Fatal("source index missing credential")
	}
	t.Cleanup(func() { _ = store.Delete(id) })
	got, err := store.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != id || got.Password != p.Password || got.ConnectorID != p.ConnectorID {
		t.Fatal("credential store returned incorrect profile")
	}
	firstRevision := got.Revision
	if !ValidID(firstRevision) {
		t.Fatal("missing source configuration revision")
	}
	if err = store.Set(p); err == nil {
		t.Fatal("existing profile overwritten")
	}
	p.WorkspaceIDs = []string{}
	if err = store.Replace(p); err != nil {
		t.Fatal(err)
	}
	got, err = store.Get(id)
	if err != nil || got.Allows("22222222-2222-4222-8222-222222222222") {
		t.Fatal("local revocation failed")
	}
	if !ValidID(got.Revision) || got.Revision == firstRevision {
		t.Fatal("source revision not changed after modification")
	}
	oldConnector := p.ConnectorID
	newConnector := "44444444-4444-4444-8444-444444444444"
	if err = store.Adopt(id, oldConnector, newConnector); err != nil {
		t.Fatal(err)
	}
	if err = store.Adopt(id, oldConnector, newConnector); err != nil {
		t.Fatal("retry adopt failed", err)
	}
	got, err = store.Get(id)
	if err != nil || got.ConnectorID != newConnector {
		t.Fatal("adopt did not transfer source")
	}
	ids, err = store.List(oldConnector)
	if err != nil || len(ids) != 0 {
		t.Fatal("old connector index not cleared")
	}
	ids, err = store.List(newConnector)
	if err != nil || len(ids) != 1 || ids[0] != id {
		t.Fatal("new connector index missing source")
	}
	p.ConnectorID = oldConnector
	if err = store.Replace(p); err == nil {
		t.Fatal("profile moved to another connector")
	}
	if err = store.Delete(id); err != nil {
		t.Fatal(err)
	}
	ids, err = store.List(newConnector)
	if err != nil || len(ids) != 0 {
		t.Fatal("source index retained removed credential")
	}
}

func TestModelLeaseCrashHelper(t *testing.T) {
	if os.Getenv("STAGE5_LEASE_CRASH_HELPER") != "1" {
		t.Skip("subprocess helper")
	}
	until, err := strconv.ParseInt(os.Getenv("STAGE5_LEASE_UNTIL"), 10, 64)
	if err != nil {
		os.Exit(2)
	}
	if _, err = (SystemVault{}).AcquireModelLease(os.Getenv("STAGE5_SOURCE_ID"), os.Getenv("STAGE5_CONNECTOR_ID"), until); err != nil {
		os.Exit(3)
	}
	// Exit directly: no Go test cleanup or application shutdown runs.
	os.Exit(0)
}

func TestModelLeaseSurvivesVaultReopenAndExpires(t *testing.T) {
	if os.Getenv("STAGE3_KEYRING_TEST") != "1" {
		t.Skip("requires the OS credential store")
	}
	p := fixtureProfile()
	var err error
	if p.ID, err = NewID(); err != nil {
		t.Fatal(err)
	}
	if p.ConnectorID, err = NewID(); err != nil {
		t.Fatal(err)
	}
	store := SystemVault{}
	if err = store.Set(p); err != nil {
		t.Fatal(err)
	}
	until := time.Now().Unix() + 5
	t.Cleanup(func() {
		for time.Now().Unix() <= until {
			time.Sleep(100 * time.Millisecond)
		}
		_ = (SystemVault{}).Delete(p.ID)
	})
	// This synthetic existing credential has no generation; reading it must
	// not force regeneration or lose configuration.
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	if err = keyring.Set(service, p.ID, string(raw)); err != nil {
		t.Fatal(err)
	}
	if existing, getErr := store.Get(p.ID); getErr != nil || existing.Revision != "" {
		t.Fatal("existing source not readable")
	}
	child := exec.Command(os.Args[0], "-test.run=^TestModelLeaseCrashHelper$")
	child.Env = append(os.Environ(), "STAGE5_LEASE_CRASH_HELPER=1", "STAGE5_SOURCE_ID="+p.ID, "STAGE5_CONNECTOR_ID="+p.ConnectorID, "STAGE5_LEASE_UNTIL="+strconv.FormatInt(until, 10))
	if output, err := child.CombinedOutput(); err != nil {
		t.Fatalf("lease child failed: %v %s", err, output)
	}
	// The child exits without cleanup; another process must see the persisted
	// policy and prevent changes until the original expiration.
	restarted := SystemVault{}
	p.WorkspaceIDs = nil
	if err = restarted.Replace(p); !errors.Is(err, ErrModelLease) {
		t.Fatalf("revocation not blocked: %v", err)
	}
	if err = restarted.Delete(p.ID); !errors.Is(err, ErrModelLease) {
		t.Fatalf("deletion not blocked: %v", err)
	}
	newConnector, err := NewID()
	if err != nil {
		t.Fatal(err)
	}
	if err = restarted.Adopt(p.ID, p.ConnectorID, newConnector); !errors.Is(err, ErrModelLease) {
		t.Fatalf("adoption not blocked: %v", err)
	}
	for time.Now().Unix() <= until {
		time.Sleep(100 * time.Millisecond)
	}
	if err = restarted.Replace(p); err != nil {
		t.Fatalf("expired lease still blocks revocation: %v", err)
	}
	if updated, getErr := restarted.Get(p.ID); getErr != nil || !ValidID(updated.Revision) {
		t.Fatal("updated source missing revision")
	}
}
