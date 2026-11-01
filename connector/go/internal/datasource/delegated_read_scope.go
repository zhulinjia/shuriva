package datasource

import (
	"errors"

	"example.com/ai-database-workspace/connector/internal/queryguard"
)

// IntersectDelegatedReadScope returns only columns permitted by both the
// Connector's current local policy and an explicitly delegated scope. Callers
// must first authenticate the delegation and bind it to the workspace and
// source; this function does not turn an untrusted request into a grant.
func IntersectDelegatedReadScope(local, delegated map[string][]string) (map[string][]string, error) {
	if len(local) == 0 || len(delegated) == 0 || len(local) > 256 || len(delegated) > 256 {
		return nil, errors.New("invalid delegated read scope")
	}
	for table, columns := range local {
		if !queryguard.ValidIdentifier(table) || len(columns) == 0 || len(columns) > 256 {
			return nil, errors.New("invalid local read scope")
		}
		seen := make(map[string]struct{}, len(columns))
		for _, column := range columns {
			if !queryguard.ValidIdentifier(column) {
				return nil, errors.New("invalid local read scope")
			}
			if _, duplicate := seen[column]; duplicate {
				return nil, errors.New("invalid local read scope")
			}
			seen[column] = struct{}{}
		}
	}
	result := make(map[string][]string)
	for table, requested := range delegated {
		if !queryguard.ValidIdentifier(table) || len(requested) == 0 || len(requested) > 256 {
			return nil, errors.New("invalid delegated read scope")
		}
		allowed := make(map[string]struct{}, len(local[table]))
		for _, column := range local[table] {
			allowed[column] = struct{}{}
		}
		seen := make(map[string]struct{}, len(requested))
		for _, column := range requested {
			if !queryguard.ValidIdentifier(column) {
				return nil, errors.New("invalid delegated read scope")
			}
			if _, duplicate := seen[column]; duplicate {
				return nil, errors.New("invalid delegated read scope")
			}
			seen[column] = struct{}{}
			if _, ok := allowed[column]; ok {
				result[table] = append(result[table], column)
			}
		}
	}
	if len(result) == 0 {
		return nil, errors.New("delegated read scope has no locally authorized columns")
	}
	return result, nil
}
