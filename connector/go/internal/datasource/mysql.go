package datasource

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net"
	"strconv"
	"strings"
	"time"

	mysql "github.com/go-sql-driver/mysql"
)

var (
	ErrConnection  = errors.New("database connection failed")
	ErrPermissions = errors.New("database account is not limited to supported read-only grants")
	ErrScope       = errors.New("database is unavailable or outside the allowed scope")
	ErrLimit       = errors.New("database structure exceeds scan limits")
	ErrMetadata    = errors.New("database metadata scan failed")
)

const maxTables = 256
const maxColumns = 4096
const maxRelations = 2048

type Table struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
}
type Column struct {
	Table    string `json:"table"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Nullable bool   `json:"nullable"`
	Position int    `json:"position"`
}
type Relation struct {
	Table            string `json:"table"`
	Column           string `json:"column"`
	ReferencedTable  string `json:"referencedTable"`
	ReferencedColumn string `json:"referencedColumn"`
	Constraint       string `json:"constraint"`
	Position         int    `json:"position"`
}
type Snapshot struct {
	Database                 string     `json:"database"`
	ServerVersion            string     `json:"serverVersion"`
	Tables                   []Table    `json:"tables"`
	Columns                  []Column   `json:"columns"`
	Relations                []Relation `json:"relations"`
	ExternalRelationsOmitted int        `json:"externalRelationsOmitted"`
}

func open(p Profile) (*sql.DB, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	cfg := mysql.NewConfig()
	cfg.User, cfg.Passwd = p.Username, p.Password
	cfg.Net, cfg.Addr, cfg.DBName = "tcp", net.JoinHostPort(p.Host, strconv.Itoa(p.Port)), p.Database
	cfg.Timeout, cfg.ReadTimeout, cfg.WriteTimeout = 5*time.Second, 10*time.Second, 10*time.Second
	if p.TLS == "required" {
		cfg.TLSConfig = "true"
	} else {
		cfg.TLSConfig = "false"
	}
	connector, err := mysql.NewConnector(cfg)
	if err != nil {
		return nil, ErrConnection
	}
	db := sql.OpenDB(connector)
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(0)
	return db, nil
}

// verifyGrants deliberately accepts a narrow account shape. Unknown grants or roles fail closed.
// The database itself remains the final authority; this is not an SQL execution policy.
type grantQuerier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func verifyGrants(ctx context.Context, db grantQuerier, database string) error {
	var partialRevokes bool
	if err := db.QueryRowContext(ctx, "SELECT @@partial_revokes").Scan(&partialRevokes); err != nil {
		return ErrPermissions
	}
	rows, err := db.QueryContext(ctx, "SHOW GRANTS FOR CURRENT_USER")
	if err != nil {
		return ErrPermissions
	}
	defer rows.Close()
	target := grantScope(database, partialRevokes)
	selectGranted := false
	for rows.Next() {
		var grant string
		if rows.Scan(&grant) != nil {
			return ErrPermissions
		}
		head, _, ok := strings.Cut(grant, " TO ")
		if !ok || !strings.HasPrefix(head, "GRANT ") || strings.Contains(grant, " WITH GRANT OPTION") {
			return ErrPermissions
		}
		privileges, scope, ok := strings.Cut(strings.TrimPrefix(head, "GRANT "), " ON ")
		if !ok {
			return ErrPermissions
		}
		if privileges == "USAGE" && scope == "*.*" {
			continue
		}
		if scope != target {
			return ErrPermissions
		}
		for _, privilege := range strings.Split(privileges, ", ") {
			switch privilege {
			case "SELECT":
				selectGranted = true
			case "SHOW VIEW":
			default:
				return ErrPermissions
			}
		}
	}
	if rows.Err() != nil || !selectGranted {
		return ErrPermissions
	}
	return nil
}

// MySQL treats unescaped _ and % as database-grant wildcards unless partial
// revokes is enabled. SHOW GRANTS preserves the escaping in the grant scope.
func grantScope(database string, partialRevokes bool) string {
	if !partialRevokes {
		database = strings.NewReplacer(`\`, `\\`, `_`, `\_`, `%`, `\%`).Replace(database)
	}
	return "`" + strings.ReplaceAll(database, "`", "``") + "`.*"
}

// Scan returns only authorized metadata for one configured database, with bounded output.
// No SQL supplied by the platform or user is executed.
func Scan(ctx context.Context, p Profile, connectorID, workspaceID string) (Snapshot, error) {
	if connectorID != p.ConnectorID || !ValidID(connectorID) || !ValidID(workspaceID) || !p.Allows(workspaceID) {
		return Snapshot{}, ErrScope
	}
	db, err := open(p)
	if err != nil {
		return Snapshot{}, err
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if db.PingContext(ctx) != nil {
		return Snapshot{}, ErrConnection
	}
	if err := verifyGrants(ctx, db, p.Database); err != nil {
		return Snapshot{}, err
	}
	var exists int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", p.Database).Scan(&exists); err != nil || exists != 1 {
		return Snapshot{}, ErrScope
	}
	s := Snapshot{Database: p.Database, Tables: []Table{}, Columns: []Column{}, Relations: []Relation{}}
	if err := db.QueryRowContext(ctx, "SELECT VERSION()").Scan(&s.ServerVersion); err != nil || !safe(s.ServerVersion, 128) {
		return Snapshot{}, ErrMetadata
	}
	rows, err := db.QueryContext(ctx, "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME LIMIT 257", p.Database)
	if err != nil {
		return Snapshot{}, ErrMetadata
	}
	for rows.Next() {
		var t Table
		if rows.Scan(&t.Name, &t.Kind) != nil || !safe(t.Name, 256) || (t.Kind != "BASE TABLE" && t.Kind != "VIEW") {
			rows.Close()
			return Snapshot{}, ErrMetadata
		}
		s.Tables = append(s.Tables, t)
		if len(s.Tables) > maxTables {
			rows.Close()
			return Snapshot{}, ErrLimit
		}
	}
	if rows.Err() != nil {
		rows.Close()
		return Snapshot{}, ErrMetadata
	}
	rows.Close()
	rows, err = db.QueryContext(ctx, "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, ORDINAL_POSITION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION LIMIT 4097", p.Database)
	if err != nil {
		return Snapshot{}, ErrMetadata
	}
	for rows.Next() {
		var c Column
		var nullable string
		if rows.Scan(&c.Table, &c.Name, &c.Type, &nullable, &c.Position) != nil || !safe(c.Table, 256) || !safe(c.Name, 256) || !safe(c.Type, 2048) || (nullable != "YES" && nullable != "NO") || c.Position < 1 {
			rows.Close()
			return Snapshot{}, ErrMetadata
		}
		c.Nullable = nullable == "YES"
		s.Columns = append(s.Columns, c)
		if len(s.Columns) > maxColumns {
			rows.Close()
			return Snapshot{}, ErrLimit
		}
	}
	if rows.Err() != nil {
		rows.Close()
		return Snapshot{}, ErrMetadata
	}
	rows.Close()
	rows, err = db.QueryContext(ctx, "SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, CONSTRAINT_NAME, ORDINAL_POSITION FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION LIMIT 2049", p.Database)
	if err != nil {
		return Snapshot{}, ErrMetadata
	}
	count := 0
	for rows.Next() {
		var r Relation
		var targetSchema string
		if rows.Scan(&r.Table, &r.Column, &targetSchema, &r.ReferencedTable, &r.ReferencedColumn, &r.Constraint, &r.Position) != nil || !safe(r.Table, 256) || !safe(r.Column, 256) || !safe(targetSchema, 256) || !safe(r.ReferencedTable, 256) || !safe(r.ReferencedColumn, 256) || !safe(r.Constraint, 256) || r.Position < 1 {
			rows.Close()
			return Snapshot{}, ErrMetadata
		}
		count++
		if count > maxRelations {
			rows.Close()
			return Snapshot{}, ErrLimit
		}
		if targetSchema != p.Database {
			s.ExternalRelationsOmitted++
			continue
		}
		s.Relations = append(s.Relations, r)
	}
	if rows.Err() != nil {
		rows.Close()
		return Snapshot{}, ErrMetadata
	}
	rows.Close()
	encoded, err := json.Marshal(s)
	if err != nil || len(encoded) > 1024*1024 {
		return Snapshot{}, ErrLimit
	}
	return s, nil
}
