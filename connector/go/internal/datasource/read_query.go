package datasource

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"example.com/ai-database-workspace/connector/internal/queryguard"
)

var ErrQuery = errors.New("read-only query could not be completed")
var ErrQueryCancelled = errors.New("read-only query timed out or was cancelled")
var ErrQueryTimeout = errors.New("read-only query timed out")
var ErrQueryUnsupported = errors.New("read-only query is unavailable in this environment")
var ErrSchemaChanged = errors.New("database table structure changed since the plan was generated")

const maxQueryBytes = 1_048_576
const maxQueryCellBytes = queryguard.MaxCellBytes

// Only this exact combination has been exercised against the isolated server;
// accepting another SQL mode requires parser/server differential tests first.
func supportedQueryServer(version, mode string, lowerCase int) bool {
	if version != "26.7.0" || lowerCase != 1 {
		return false
	}
	expected := map[string]bool{
		"ONLY_FULL_GROUP_BY": true, "STRICT_TRANS_TABLES": true,
		"NO_ZERO_IN_DATE": true, "NO_ZERO_DATE": true, "ERROR_FOR_DIVISION_BY_ZERO": true,
		"NO_ENGINE_SUBSTITUTION": true,
	}
	parts := strings.Split(mode, ",")
	if len(parts) != len(expected) {
		return false
	}
	seen := make(map[string]bool, len(parts))
	for _, part := range parts {
		if !expected[part] || seen[part] {
			return false
		}
		seen[part] = true
	}
	return true
}

func verifyQueryServer(ctx context.Context, conn *sql.Conn) (string, error) {
	var version, mode string
	var lowerCase int
	if err := conn.QueryRowContext(ctx, "SELECT VERSION(), @@sql_mode, @@lower_case_table_names").Scan(&version, &mode, &lowerCase); err != nil {
		return "", ErrQuery
	}
	if !supportedQueryServer(version, mode, lowerCase) {
		return "", ErrQueryUnsupported
	}
	return mode, nil
}

// QueryParameter uses textual representations so integers and decimals are not
// rounded while crossing the platform/Connector boundary.
type QueryParameter struct {
	Kind  string `json:"kind"`
	Value string `json:"value"`
}
type QueryColumn struct {
	Name string `json:"name"`
	Type string `json:"type"`
}
type QueryCell struct {
	Null     bool   `json:"null"`
	Encoding string `json:"encoding,omitempty"`
	Value    string `json:"value,omitempty"`
}
type QueryResult struct {
	Columns   []QueryColumn `json:"columns"`
	Rows      [][]QueryCell `json:"rows"`
	Timezone  string        `json:"timezone"`
	Truncated bool          `json:"truncated"`
	Reason    string        `json:"reason,omitempty"`
}

func queryArguments(params []QueryParameter) ([]any, error) {
	if len(params) > 64 {
		return nil, ErrQuery
	}
	args := make([]any, 0, len(params))
	for _, p := range params {
		if len(p.Value) > 4096 || !utf8.ValidString(p.Value) {
			return nil, ErrQuery
		}
		switch p.Kind {
		case "null":
			if p.Value != "" {
				return nil, ErrQuery
			}
			args = append(args, nil)
		case "string":
			args = append(args, p.Value)
		case "integer":
			v, err := strconv.ParseInt(p.Value, 10, 64)
			if err == nil {
				args = append(args, v)
				break
			}
			if strings.HasPrefix(p.Value, "-") {
				return nil, ErrQuery
			}
			u, err := strconv.ParseUint(p.Value, 10, 64)
			if err != nil {
				return nil, ErrQuery
			}
			args = append(args, u)
		case "decimal":
			// Send the exact decimal as a bound string, avoiding float conversion.
			if len(p.Value) == 0 || len(p.Value) > 80 {
				return nil, ErrQuery
			}
			for i, r := range p.Value {
				if (r < '0' || r > '9') && r != '.' && !(r == '-' && i == 0) {
					return nil, ErrQuery
				}
			}
			if strings.Count(p.Value, ".") > 1 || p.Value == "-" || p.Value == "." || p.Value == "-." {
				return nil, ErrQuery
			}
			args = append(args, p.Value)
		case "boolean":
			if p.Value != "true" && p.Value != "false" {
				return nil, ErrQuery
			}
			args = append(args, p.Value == "true")
		default:
			return nil, ErrQuery
		}
	}
	return args, nil
}

func encodeCell(value any, typ string) (QueryCell, error) {
	if value == nil {
		return QueryCell{Null: true}, nil
	}
	var raw []byte
	switch v := value.(type) {
	case []byte:
		raw = v
	case string:
		raw = []byte(v)
	case int64:
		raw = []byte(strconv.FormatInt(v, 10))
	case uint64:
		raw = []byte(strconv.FormatUint(v, 10))
	case float32:
		if math.IsInf(float64(v), 0) || math.IsNaN(float64(v)) {
			return QueryCell{}, ErrQuery
		}
		raw = []byte(strconv.FormatFloat(float64(v), 'g', -1, 32))
	case float64:
		if math.IsInf(v, 0) || math.IsNaN(v) {
			return QueryCell{}, ErrQuery
		}
		raw = []byte(strconv.FormatFloat(v, 'g', -1, 64))
	default:
		return QueryCell{}, ErrQuery
	}
	if len(raw) > maxQueryCellBytes {
		return QueryCell{}, queryguard.ErrDenied
	}
	binary := strings.Contains(typ, "BLOB") || typ == "BIT" || typ == "GEOMETRY" || strings.Contains(typ, "BINARY") || !utf8.Valid(raw)
	if binary {
		return QueryCell{Encoding: "base64", Value: base64.StdEncoding.EncodeToString(raw)}, nil
	}
	return QueryCell{Encoding: "text", Value: string(raw)}, nil
}

func oversizedCell(flag any) (bool, error) {
	switch v := flag.(type) {
	case nil:
		return false, nil
	case int64:
		if v == 0 || v == 1 {
			return v == 1, nil
		}
	case []byte:
		if string(v) == "0" || string(v) == "1" {
			return string(v) == "1", nil
		}
	}
	return false, ErrQuery
}

// ExecuteRead requires explicit platform enablement. The caller must load p from
// the local credential vault; neither policy nor credentials may come from a task.
// Only the independently tested MySQL build and server settings are accepted.
func ExecuteRead(parent context.Context, p Profile, connectorID, workspaceID, query string, parameters []QueryParameter, maxRows int) (QueryResult, error) {
	return executeRead(parent, p, connectorID, workspaceID, query, parameters, maxRows, "")
}

// ExecuteReadVersioned binds an AI-generated plan to its captured table metadata.
func ExecuteReadVersioned(parent context.Context, p Profile, connectorID, workspaceID, query string, parameters []QueryParameter, maxRows int, schemaVersion string) (QueryResult, error) {
	if len(schemaVersion) != 64 {
		return QueryResult{}, ErrSchemaChanged
	}
	return executeRead(parent, p, connectorID, workspaceID, query, parameters, maxRows, schemaVersion)
}

func executeRead(parent context.Context, p Profile, connectorID, workspaceID, query string, parameters []QueryParameter, maxRows int, schemaVersion string) (QueryResult, error) {
	var empty QueryResult
	if parent.Err() != nil {
		return empty, queryError(parent)
	}
	if !queryguard.Available() {
		return empty, ErrQueryUnsupported
	}
	if p.Validate() != nil || connectorID != p.ConnectorID || !ValidID(connectorID) || !ValidID(workspaceID) || !p.Allows(workspaceID) || len(p.ReadScopes[workspaceID]) == 0 {
		return empty, ErrScope
	}
	args, err := queryArguments(parameters)
	if err != nil {
		return empty, err
	}
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	db, err := open(p)
	if err != nil {
		return empty, ErrConnection
	}
	defer db.Close()
	conn, err := db.Conn(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return empty, queryError(ctx)
		}
		return empty, ErrConnection
	}
	defer conn.Close()
	if err = verifyGrants(ctx, conn, p.Database); err != nil {
		if ctx.Err() != nil {
			return empty, queryError(ctx)
		}
		return empty, err
	}
	mode, err := verifyQueryServer(ctx, conn)
	if err != nil {
		return empty, err
	}
	if _, err = conn.ExecContext(ctx, "SET SESSION time_zone = '+00:00'"); err != nil {
		return empty, queryError(ctx)
	}
	if _, err = conn.ExecContext(ctx, "SET SESSION character_set_results = 'utf8mb4'"); err != nil {
		return empty, queryError(ctx)
	}
	// Client cancellation does not necessarily interrupt a server thread that is
	// waiting on a metadata lock. Bound server-side waits as an additional limit.
	if _, err = conn.ExecContext(ctx, "SET SESSION lock_wait_timeout = 10, max_execution_time = 10000"); err != nil {
		return empty, queryError(ctx)
	}
	plan, err := queryguard.Validate(query, mode, queryguard.Policy{Database: p.Database, Tables: p.ReadScopes[workspaceID]}, maxRows)
	if err != nil {
		return empty, err
	}
	if plan.Parameters != len(args) {
		return empty, ErrQuery
	}
	for i, p := range parameters {
		if p.Kind == "null" && !plan.NullSafeParameters[i] {
			return empty, ErrQuery
		}
	}
	tx, err := conn.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return empty, ErrQuery
	}
	defer tx.Rollback()
	bitColumns, textColumns, err := readQueryMetadata(ctx, tx, p, workspaceID, schemaVersion, plan)
	if err != nil {
		return empty, err
	}
	// Compile again under the metadata lock to preserve BIT bytes and cap text.
	plan, err = queryguard.Validate(query, mode, queryguard.Policy{Database: p.Database, Tables: p.ReadScopes[workspaceID], BinaryColumns: bitColumns, TextColumns: textColumns}, maxRows)
	if err != nil {
		return empty, err
	}
	rows, err := tx.QueryContext(ctx, plan.SQL, args...)
	if err != nil {
		return empty, queryError(ctx)
	}
	defer rows.Close()
	return readQueryRows(ctx, rows, plan.Columns, bitColumns, maxRows)
}

func queryError(ctx context.Context) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return ErrQueryTimeout
	}
	if ctx.Err() != nil {
		return ErrQueryCancelled
	}
	return ErrQuery
}
