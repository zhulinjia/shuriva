package datasource

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"example.com/ai-database-workspace/connector/internal/queryguard"
)

// ModelSchema is deliberately smaller than a scan snapshot. It contains only
// local read-authorized base-table columns and no comments or enum values.
type ModelSchema struct {
	Database string       `json:"database"`
	Tables   []ModelTable `json:"tables"`
}

type ModelTable struct {
	Name          string        `json:"name"`
	Columns       []ModelColumn `json:"columns"`
	Version       string        `json:"version,omitempty"`
	StructureHash string        `json:"structureHash,omitempty"`
}

// SemanticStructureHash binds saved semantics to exact physical columns, without
// disclosing full types (which can contain private enum values) to the model.
func SemanticStructureHash(snapshot Snapshot, table string) string {
	parts := []string{"semantic-structure-v1", snapshot.Database, table, "BASE TABLE"}
	var columns []Column
	for _, column := range snapshot.Columns {
		if column.Table == table {
			columns = append(columns, column)
		}
	}
	sort.Slice(columns, func(i, j int) bool { return columns[i].Position < columns[j].Position })
	for _, column := range columns {
		nullable := "0"
		if column.Nullable {
			nullable = "1"
		}
		parts = append(parts, column.Name, column.Type, nullable, strconv.Itoa(column.Position))
	}
	hash := sha256.New()
	for _, part := range parts {
		var size [8]byte
		for i := 0; i < 8; i++ {
			size[7-i] = byte(uint64(len(part)) >> (8 * i))
		}
		hash.Write(size[:])
		hash.Write([]byte(part))
	}
	return hex.EncodeToString(hash.Sum(nil))
}

type ModelColumn struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

var modelColumnType = regexp.MustCompile(`^[a-z]+`)
var modelServerUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var modelTypes = map[string]bool{
	"bigint": true, "binary": true, "bit": true, "blob": true, "boolean": true,
	"char": true, "date": true, "datetime": true, "decimal": true, "double": true,
	"enum": true, "float": true, "geometry": true, "geometrycollection": true,
	"int": true, "integer": true, "json": true, "linestring": true, "longblob": true,
	"longtext": true, "mediumblob": true, "mediumint": true, "mediumtext": true,
	"multilinestring": true, "multipoint": true, "multipolygon": true, "numeric": true,
	"point": true, "polygon": true, "set": true, "smallint": true, "text": true,
	"time": true, "timestamp": true, "tinyblob": true, "tinyint": true,
	"tinytext": true, "varbinary": true, "varchar": true, "year": true,
}

// RestrictModelSchema must receive a locally obtained scan and the current
// profile, not a scope supplied by the platform or model. Missing or changed
// tables/columns are omitted; an unverified profile cannot yield a schema.
func RestrictModelSchema(profile Profile, connectorID, workspaceID string, snapshot Snapshot) (ModelSchema, error) {
	var empty ModelSchema
	if profile.Validate() != nil || profile.ConnectorID != connectorID || !ValidID(connectorID) || !ValidID(workspaceID) || !profile.Allows(workspaceID) || snapshot.Database != profile.Database || !queryguard.ValidIdentifier(snapshot.Database) {
		return empty, errors.New("invalid model schema scope")
	}
	scopes := profile.ReadScopes[workspaceID]
	if len(scopes) == 0 {
		return empty, errors.New("no local read scope")
	}
	base := make(map[string]bool, len(snapshot.Tables))
	seenTables := make(map[string]bool, len(snapshot.Tables))
	for _, table := range snapshot.Tables {
		if seenTables[table.Name] {
			return empty, errors.New("ambiguous model schema")
		}
		seenTables[table.Name] = true
		if table.Kind == "BASE TABLE" && queryguard.ValidIdentifier(table.Name) {
			base[table.Name] = true
		}
	}
	tables := make(map[string]map[string]string)
	for _, col := range snapshot.Columns {
		if !base[col.Table] || !queryguard.ValidIdentifier(col.Name) {
			continue
		}
		permitted := false
		for _, candidate := range scopes[col.Table] {
			if candidate == col.Name {
				permitted = true
				break
			}
		}
		if !permitted {
			continue
		}
		typ := modelColumnType.FindString(strings.ToLower(col.Type))
		if !modelTypes[typ] {
			continue
		}
		if tables[col.Table] == nil {
			tables[col.Table] = make(map[string]string)
		}
		if _, duplicate := tables[col.Table][col.Name]; duplicate {
			return empty, errors.New("ambiguous model schema")
		}
		tables[col.Table][col.Name] = typ
	}
	out := ModelSchema{Database: snapshot.Database, Tables: make([]ModelTable, 0, len(tables))}
	for name, cols := range tables {
		table := ModelTable{Name: name, Columns: make([]ModelColumn, 0, len(cols))}
		for column, typ := range cols {
			table.Columns = append(table.Columns, ModelColumn{Name: column, Type: typ})
		}
		sort.Slice(table.Columns, func(i, j int) bool { return table.Columns[i].Name < table.Columns[j].Name })
		out.Tables = append(out.Tables, table)
	}
	sort.Slice(out.Tables, func(i, j int) bool { return out.Tables[i].Name < out.Tables[j].Name })
	if len(out.Tables) == 0 {
		return empty, errors.New("no authorized model schema")
	}
	return out, nil
}

// tableVersion is called only after SHOW COLUMNS has acquired the transaction's
// metadata lock. Hashes never disclose column defaults, comments, or DDL text.
func tableVersion(ctx context.Context, tx *sql.Tx, profile Profile, workspace, table string) (string, error) {
	database := profile.Database
	var serverUUID string
	serverErr := tx.QueryRowContext(ctx, "SELECT @@server_uuid").Scan(&serverUUID)
	serverUUID, err := validatedServerUUID(serverUUID, serverErr)
	if err != nil {
		return "", err
	}
	var kind string
	var engine, created sql.NullString
	if err := tx.QueryRowContext(ctx, "SELECT TABLE_TYPE, ENGINE, CAST(CREATE_TIME AS CHAR) FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA = BINARY ? AND BINARY TABLE_NAME = BINARY ?", database, table).Scan(&kind, &engine, &created); err != nil || kind != "BASE TABLE" || !engine.Valid || !strings.EqualFold(engine.String, "InnoDB") {
		return "", ErrScope
	}
	var name, definition string
	if err := tx.QueryRowContext(ctx, "SHOW CREATE TABLE `"+database+"`.`"+table+"`").Scan(&name, &definition); err != nil || name != table || len(definition) == 0 || len(definition) > 1_048_576 {
		return "", ErrQuery
	}
	return fingerprintModelTable(profile, workspace, table, serverUUID, kind, engine.String, created.String, definition), nil
}

func validatedServerUUID(value string, err error) (string, error) {
	if err != nil || !modelServerUUID.MatchString(value) {
		return "", ErrQueryUnsupported
	}
	return strings.ToLower(value), nil
}

func fingerprintModelTable(profile Profile, workspace, table, serverUUID, kind, engine, created, definition string) string {
	hash := sha256.New()
	for _, part := range []string{"model-table-v1", profile.ID, profile.ConnectorID, profile.Revision, workspace, profile.Host, strconv.Itoa(profile.Port), serverUUID, profile.Database, profile.Username, profile.TLS, table, kind, engine, created, definition} {
		var size [8]byte
		for i := 0; i < 8; i++ {
			size[7-i] = byte(uint64(len(part)) >> (8 * i))
		}
		hash.Write(size[:])
		hash.Write([]byte(part))
	}
	return hex.EncodeToString(hash.Sum(nil))
}

// CaptureModelSchema checks exactly the same server compatibility conditions
// as query execution, then fingerprints every included table while holding its
// metadata lock. The schema is derived only from the current local policy.
func CaptureModelSchema(parent context.Context, p Profile, connectorID, workspaceID string) (ModelSchema, error) {
	snapshot, err := Scan(parent, p, connectorID, workspaceID)
	if err != nil {
		return ModelSchema{}, err
	}
	schema, err := RestrictModelSchema(p, connectorID, workspaceID, snapshot)
	if err != nil {
		return ModelSchema{}, err
	}
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	db, err := open(p)
	if err != nil {
		return ModelSchema{}, ErrConnection
	}
	defer db.Close()
	conn, err := db.Conn(ctx)
	if err != nil {
		return ModelSchema{}, ErrConnection
	}
	defer conn.Close()
	if err := verifyGrants(ctx, conn, p.Database); err != nil {
		return ModelSchema{}, err
	}
	if _, err := verifyQueryServer(ctx, conn); err != nil {
		return ModelSchema{}, err
	}
	// Fingerprint formatting must match execution, including CREATE_TIME's
	// session timezone and the character encoding of SHOW CREATE TABLE.
	if _, err := conn.ExecContext(ctx, "SET SESSION time_zone = '+00:00'"); err != nil {
		return ModelSchema{}, queryError(ctx)
	}
	if _, err := conn.ExecContext(ctx, "SET SESSION character_set_results = 'utf8mb4'"); err != nil {
		return ModelSchema{}, queryError(ctx)
	}
	if _, err := conn.ExecContext(ctx, "SET SESSION lock_wait_timeout = 10, max_execution_time = 10000"); err != nil {
		return ModelSchema{}, queryError(ctx)
	}
	tx, err := conn.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return ModelSchema{}, ErrQuery
	}
	defer tx.Rollback()
	for i := range schema.Tables {
		table := &schema.Tables[i]
		rows, err := tx.QueryContext(ctx, "SHOW COLUMNS FROM `"+p.Database+"`.`"+table.Name+"`")
		if err != nil {
			return ModelSchema{}, queryError(ctx)
		}
		fields, err := rows.Columns()
		if err != nil || len(fields) < 2 || len(fields) > 32 {
			rows.Close()
			return ModelSchema{}, ErrQuery
		}
		found := map[string]string{}
		current := Snapshot{Database: p.Database}
		for rows.Next() {
			values := make([]sql.RawBytes, len(fields))
			dest := make([]any, len(fields))
			for j := range values {
				dest[j] = &values[j]
			}
			if rows.Scan(dest...) != nil || len(found) >= 4096 {
				rows.Close()
				return ModelSchema{}, ErrQuery
			}
			if len(fields) < 3 || (string(values[2]) != "YES" && string(values[2]) != "NO") {
				rows.Close()
				return ModelSchema{}, ErrQuery
			}
			found[string(values[0])] = modelColumnType.FindString(strings.ToLower(string(values[1])))
			current.Columns = append(current.Columns, Column{Table: table.Name, Name: string(values[0]), Type: string(values[1]), Nullable: string(values[2]) == "YES", Position: len(current.Columns) + 1})
		}
		if rows.Err() != nil {
			rows.Close()
			return ModelSchema{}, queryError(ctx)
		}
		rows.Close()
		for _, column := range table.Columns {
			if found[column.Name] != column.Type {
				return ModelSchema{}, ErrScope
			}
		}
		table.Version, err = tableVersion(ctx, tx, p, workspaceID, table.Name)
		if err != nil {
			return ModelSchema{}, err
		}
		table.StructureHash = SemanticStructureHash(current, table.Name)
	}
	return schema, nil
}
