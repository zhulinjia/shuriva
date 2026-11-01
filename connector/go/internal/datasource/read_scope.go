package datasource

import (
	"errors"

	"example.com/ai-database-workspace/connector/internal/queryguard"
)

// GrantReadScope authorizes named columns of a verified base table for a local
// workspace. The supplied snapshot must be obtained locally from this profile.
func (p *Profile) GrantReadScope(workspace, table string, columns []string, snapshot Snapshot) error {
	if !p.Allows(workspace) || !queryguard.ValidIdentifier(p.Database) || !queryguard.ValidIdentifier(table) || len(columns) == 0 || len(columns) > 256 || snapshot.Database != p.Database {
		return errors.New("invalid query policy")
	}
	base := false
	for _, item := range snapshot.Tables {
		if item.Name == table && item.Kind == "BASE TABLE" {
			base = true
			break
		}
	}
	if !base {
		return errors.New("authorized table must be an existing base table")
	}
	seen := make(map[string]bool, len(columns))
	for _, column := range columns {
		if !queryguard.ValidIdentifier(column) || seen[column] {
			return errors.New("invalid query policy")
		}
		seen[column] = true
		found := false
		for _, item := range snapshot.Columns {
			if item.Table == table && item.Name == column {
				found = true
				break
			}
		}
		if !found {
			return errors.New("authorized column is not present in the selected table")
		}
	}
	if p.ReadScopes == nil {
		p.ReadScopes = make(map[string]map[string][]string)
	}
	if p.ReadScopes[workspace] == nil {
		p.ReadScopes[workspace] = make(map[string][]string)
	}
	if len(p.ReadScopes[workspace]) >= 256 {
		if _, exists := p.ReadScopes[workspace][table]; !exists {
			return errors.New("query policy capacity exceeded")
		}
	}
	p.ReadScopes[workspace][table] = append([]string(nil), columns...)
	return p.Validate()
}

// RevokeReadScope removes all column access to one table in a workspace.
func (p *Profile) RevokeReadScope(workspace, table string) error {
	if !p.Allows(workspace) || !queryguard.ValidIdentifier(table) {
		return errors.New("invalid query policy")
	}
	delete(p.ReadScopes[workspace], table)
	if len(p.ReadScopes[workspace]) == 0 {
		delete(p.ReadScopes, workspace)
	}
	return nil
}
