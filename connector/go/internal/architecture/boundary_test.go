// Package architecture protects the actual connector dependency boundaries.
package architecture

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

const internal = "example.com/ai-database-workspace/connector/internal/"

// violation expresses real module responsibilities, not a generic rule for
// every package: core must not import infrastructure or orchestration.
func violation(pkg, imported string) bool {
	if pkg == "mutationguard" || pkg == "mutationrunner" || pkg == "mutationconfig" {
		for _, prefix := range []string{"database/sql", "net/http", "github.com/go-sql-driver/", "github.com/jackc/pgx", "github.com/lib/pq", "go.etcd.io/bbolt", "github.com/zalando/go-keyring", "github.com/danieljoos/wincred"} {
			if imported == prefix || strings.HasPrefix(imported, prefix+"/") || (strings.HasSuffix(prefix, "/") && strings.HasPrefix(imported, prefix)) {
				return true
			}
		}
		if strings.HasPrefix(imported, internal) {
			dependency := strings.TrimPrefix(imported, internal)
			return !(pkg == "mutationrunner" && dependency == "mutationguard")
		}
	}
	if pkg == "mutationmysql" && (imported == internal+"mutationstore" || imported == internal+"datasource" || imported == internal+"agent" || imported == internal+"cli") {
		return true
	}
	return false
}

func TestBoundaryRulesDetectRealViolations(t *testing.T) {
	for _, tc := range []struct {
		from, to string
		denied   bool
	}{
		{"mutationrunner", internal + "mutationguard", false},
		{"mutationrunner", internal + "mutationmysql", true},
		{"mutationrunner", "database/sql", true},
		{"mutationrunner", "net/http", true},
		{"mutationguard", "github.com/jackc/pgx/v5", true},
		{"mutationguard", "go.etcd.io/bbolt", true},
		{"mutationconfig", "github.com/zalando/go-keyring", true},
		{"mutationmysql", internal + "mutationstore", true},
		{"mutationmysql", internal + "mutationconfig", false},
	} {
		if got := violation(tc.from, tc.to); got != tc.denied {
			t.Errorf("boundary %s -> %s: denied=%t", tc.from, tc.to, got)
		}
	}
}

func TestConnectorDependenciesRespectBoundaries(t *testing.T) {
	_, current, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate connector")
	}
	root := filepath.Dir(filepath.Dir(current))
	for _, pkg := range []string{"mutationguard", "mutationrunner", "mutationconfig", "mutationmysql"} {
		entries, err := os.ReadDir(filepath.Join(root, pkg))
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
				continue
			}
			file, err := parser.ParseFile(token.NewFileSet(), filepath.Join(root, pkg, entry.Name()), nil, parser.ImportsOnly)
			if err != nil {
				t.Fatal(err)
			}
			for _, spec := range file.Imports {
				name, err := strconv.Unquote(spec.Path.Value)
				if err != nil {
					t.Fatal(err)
				}
				if violation(pkg, name) {
					t.Errorf("%s/%s may not import %s", pkg, entry.Name(), name)
				}
			}
		}
	}
}
