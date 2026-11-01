package datasource

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestSemanticStructureDigestMatchesPlatformAndDetectsTypeDetails(t *testing.T) {
	snapshot := Snapshot{Database: "demo", Columns: []Column{{Table: "customers", Name: "name", Type: "varchar(50)", Nullable: false, Position: 1}}}
	base := SemanticStructureHash(snapshot, "customers")
	if base != "2874096940f6d2228080e404bb588b60ff2f8da74fadeb8bc8d749f3f721606c" {
		t.Fatal("platform and connector digests differ")
	}
	snapshot.Columns[0].Type = "varchar(60)"
	if SemanticStructureHash(snapshot, "customers") == base {
		t.Fatal("type detail change not detected")
	}
	snapshot.Columns[0].Type = "varchar(50)"
	snapshot.Columns[0].Nullable = true
	if SemanticStructureHash(snapshot, "customers") == base {
		t.Fatal("nullability change not detected")
	}
}

func TestModelServerIdentityFailureAndFingerprintBinding(t *testing.T) {
	for _, candidate := range []struct {
		value string
		err   error
	}{
		{"", nil},
		{"bad-value", nil},
		{"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", errors.New("unavailable")},
	} {
		if _, err := validatedServerUUID(candidate.value, candidate.err); !errors.Is(err, ErrQueryUnsupported) {
			t.Fatalf("invalid or unavailable server identity accepted: %v", err)
		}
	}
	first, err := validatedServerUUID("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", nil)
	if err != nil || first != "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" {
		t.Fatal("valid server identity rejected")
	}
	second, err := validatedServerUUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", nil)
	if err != nil {
		t.Fatal(err)
	}
	p := fixtureProfile()
	calculate := func(uuid string) string {
		return fingerprintModelTable(p, p.WorkspaceIDs[0], "customers", uuid, "BASE TABLE", "InnoDB", "2025-01-01", "CREATE TABLE customers (id INT)")
	}
	if calculate(first) == calculate(second) {
		t.Fatal("distinct server instances share a fingerprint")
	}
}

func TestModelSchemaIncludesOnlyLocallyAuthorizedBaseColumns(t *testing.T) {
	p := fixtureProfile()
	w := p.WorkspaceIDs[0]
	p.ReadScopes = map[string]map[string][]string{w: {"customers": {"id", "name", "status"}, "a_view": {"name"}}}
	snapshot := Snapshot{Database: p.Database, Tables: []Table{
		{Name: "customers", Kind: "BASE TABLE"}, {Name: "a_view", Kind: "VIEW"}, {Name: "private", Kind: "BASE TABLE"},
	}, Columns: []Column{
		{Table: "customers", Name: "id", Type: "bigint unsigned"},
		{Table: "customers", Name: "name", Type: "varchar(255)"},
		{Table: "customers", Name: "status", Type: "enum('sensitive-value','other')"},
		{Table: "customers", Name: "password", Type: "varchar(100)"},
		{Table: "a_view", Name: "name", Type: "varchar(100)"},
		{Table: "private", Name: "secret", Type: "text"},
	}}
	got, err := RestrictModelSchema(p, p.ConnectorID, w, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(got)
	if string(raw) != `{"database":"stage3_source","tables":[{"name":"customers","columns":[{"name":"id","type":"bigint"},{"name":"name","type":"varchar"},{"name":"status","type":"enum"}]}]}` {
		t.Fatalf("unexpected filtered metadata: %s", raw)
	}
	for _, forbidden := range []string{"password", "sensitive-value", "a_view", "private", "secret"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("unauthorized metadata included: %s", forbidden)
		}
	}
}

func TestModelSchemaRejectsWrongScopeAndAmbiguousMetadata(t *testing.T) {
	p := fixtureProfile()
	w := p.WorkspaceIDs[0]
	p.ReadScopes = map[string]map[string][]string{w: {"customers": {"id"}}}
	snapshot := Snapshot{Database: p.Database, Tables: []Table{{Name: "customers", Kind: "BASE TABLE"}}, Columns: []Column{{Table: "customers", Name: "id", Type: "int"}}}
	if _, err := RestrictModelSchema(p, p.ConnectorID, "44444444-4444-4444-8444-444444444444", snapshot); err == nil {
		t.Fatal("wrong workspace accepted")
	}
	if _, err := RestrictModelSchema(p, "44444444-4444-4444-8444-444444444444", w, snapshot); err == nil {
		t.Fatal("wrong connector accepted")
	}
	snapshot.Columns = append(snapshot.Columns, snapshot.Columns[0])
	if _, err := RestrictModelSchema(p, p.ConnectorID, w, snapshot); err == nil {
		t.Fatal("duplicate column accepted")
	}
	snapshot.Columns = snapshot.Columns[:1]
	snapshot.Tables = append(snapshot.Tables, Table{Name: "customers", Kind: "VIEW"})
	if _, err := RestrictModelSchema(p, p.ConnectorID, w, snapshot); err == nil {
		t.Fatal("ambiguous table accepted")
	}
}
