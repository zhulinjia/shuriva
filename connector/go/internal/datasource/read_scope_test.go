package datasource

import "testing"

func TestLocalReadScopeRequiresWorkspaceBaseTableAndKnownColumns(t *testing.T) {
	p := fixtureProfile()
	workspace := p.WorkspaceIDs[0]
	snapshot := Snapshot{
		Database: p.Database,
		Tables:   []Table{{Name: "customers", Kind: "BASE TABLE"}, {Name: "customer_names", Kind: "VIEW"}},
		Columns:  []Column{{Table: "customers", Name: "id"}, {Table: "customers", Name: "name"}, {Table: "customer_names", Name: "name"}},
	}
	for _, tc := range []struct {
		workspace, table string
		columns          []string
	}{
		{"44444444-4444-4444-8444-444444444444", "customers", []string{"id"}},
		{workspace, "customer_names", []string{"name"}},
		{workspace, "customers", []string{"secret"}},
		{workspace, "customers", []string{"id", "id"}},
		{workspace, "customers", []string{"*"}},
	} {
		if err := p.GrantReadScope(tc.workspace, tc.table, tc.columns, snapshot); err == nil {
			t.Fatalf("unauthorized policy accepted: %v", tc)
		}
	}
	if len(p.ReadScopes) != 0 {
		t.Fatal("rejected request changed policy")
	}
	if err := p.GrantReadScope(workspace, "customers", []string{"id", "name"}, snapshot); err != nil {
		t.Fatal(err)
	}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := p.RevokeReadScope(workspace, "customers"); err != nil || len(p.ReadScopes) != 0 {
		t.Fatal("policy not revoked")
	}
}
