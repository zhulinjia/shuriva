package datasource

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"example.com/ai-database-workspace/connector/internal/queryguard"
)

// readQueryMetadata retains the caller’s transaction and its metadata lock.
func readQueryMetadata(ctx context.Context, tx *sql.Tx, p Profile, workspaceID, schemaVersion string, plan queryguard.Plan) (map[string]bool, map[string]bool, error) {
	// SHOW COLUMNS acquires a transaction-duration metadata lock in the tested
	// MySQL environment. It runs before the type check, without reading rows.
	// The parser only emits ASCII identifiers, so this generated name is safe.
	metadata, err := tx.QueryContext(ctx, "SHOW COLUMNS FROM `"+p.Database+"`.`"+plan.Table+"`")
	if err != nil {
		return nil, nil, queryError(ctx)
	}
	fields, err := metadata.Columns()
	if err != nil || len(fields) < 2 || len(fields) > 32 {
		metadata.Close()
		return nil, nil, ErrQuery
	}
	found := make(map[string]bool)
	bitColumns := make(map[string]bool)
	for metadata.Next() {
		values := make([]sql.RawBytes, len(fields))
		targets := make([]any, len(fields))
		for i := range values {
			targets[i] = &values[i]
		}
		if metadata.Scan(targets...) != nil || len(found) >= 4096 {
			metadata.Close()
			return nil, nil, ErrQuery
		}
		found[string(values[0])] = true
		columnType := strings.ToLower(string(values[1]))
		if columnType == "bit" || strings.HasPrefix(columnType, "bit(") {
			bitColumns[string(values[0])] = true
		}
	}
	if metadata.Err() != nil {
		metadata.Close()
		return nil, nil, queryError(ctx)
	}
	metadata.Close()
	var kind string
	var engine sql.NullString
	if err = tx.QueryRowContext(ctx, "SELECT TABLE_TYPE, ENGINE FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA = BINARY ? AND BINARY TABLE_NAME = BINARY ?", p.Database, plan.Table).Scan(&kind, &engine); err != nil || kind != "BASE TABLE" || !engine.Valid || !strings.EqualFold(engine.String, "InnoDB") {
		return nil, nil, ErrScope
	}
	if schemaVersion != "" {
		actual, err := tableVersion(ctx, tx, p, workspaceID, plan.Table)
		if err != nil {
			return nil, nil, err
		}
		if actual != schemaVersion {
			return nil, nil, ErrSchemaChanged
		}
	}
	for _, column := range p.ReadScopes[workspaceID][plan.Table] {
		if !found[column] {
			return nil, nil, ErrScope
		}
	}
	// Results are returned as utf8mb4. Measure converted text bytes before any
	// row reaches the driver; source encodings can expand during conversion.
	charsetRows, err := tx.QueryContext(ctx, "SELECT COLUMN_NAME, CHARACTER_SET_NAME FROM information_schema.COLUMNS WHERE BINARY TABLE_SCHEMA = BINARY ? AND BINARY TABLE_NAME = BINARY ? LIMIT 4097", p.Database, plan.Table)
	if err != nil {
		return nil, nil, queryError(ctx)
	}
	textColumns := make(map[string]bool)
	charsetFound := make(map[string]bool)
	for charsetRows.Next() {
		var column string
		var charset sql.NullString
		if charsetRows.Scan(&column, &charset) != nil || len(charsetFound) >= 4096 {
			charsetRows.Close()
			return nil, nil, ErrQuery
		}
		charsetFound[column] = true
		textColumns[column] = charset.Valid
	}
	if charsetRows.Err() != nil {
		charsetRows.Close()
		return nil, nil, queryError(ctx)
	}
	charsetRows.Close()
	for _, column := range plan.Columns {
		if !charsetFound[column] {
			return nil, nil, ErrScope
		}
	}
	return bitColumns, textColumns, nil
}

// readQueryRows consumes only rows from the same verified transaction.
func readQueryRows(ctx context.Context, rows *sql.Rows, columns []string, bitColumns map[string]bool, maxRows int) (QueryResult, error) {
	var empty QueryResult
	types, err := rows.ColumnTypes()
	if err != nil || len(types) != len(columns)*2 {
		return empty, ErrQuery
	}
	result := QueryResult{Columns: make([]QueryColumn, 0, len(columns)), Rows: [][]QueryCell{}, Timezone: "UTC"}
	for i, typ := range types[:len(columns)] {
		if typ.Name() != columns[i] {
			return empty, ErrQuery
		}
		databaseType := typ.DatabaseTypeName()
		if bitColumns[typ.Name()] {
			databaseType = "BIT"
		}
		result.Columns = append(result.Columns, QueryColumn{Name: typ.Name(), Type: databaseType})
	}
	used, _ := json.Marshal(result.Columns)
	size := len(used)
	for rows.Next() {
		if len(result.Rows) >= maxRows {
			result.Truncated = true
			result.Reason = "rows"
			break
		}
		values := make([]any, len(types))
		targets := make([]any, len(types))
		for i := range values {
			targets[i] = &values[i]
		}
		if err = rows.Scan(targets...); err != nil {
			return empty, queryError(ctx)
		}
		line := make([]QueryCell, 0, len(columns))
		for i, flag := range values[len(columns):] {
			oversized, err := oversizedCell(flag)
			if err != nil {
				return empty, ErrQuery
			}
			if oversized {
				result.Truncated = true
				result.Reason = "cell"
				break
			}
			value := values[i]
			cell, err := encodeCell(value, types[i].DatabaseTypeName())
			if errors.Is(err, queryguard.ErrDenied) {
				result.Truncated = true
				result.Reason = "cell"
				break
			}
			if err != nil {
				return empty, ErrQuery
			}
			line = append(line, cell)
		}
		if result.Truncated {
			break
		}
		encoded, err := json.Marshal(line)
		if err != nil {
			return empty, ErrQuery
		}
		if size+len(encoded)+len(result.Rows)+512 > maxQueryBytes {
			result.Truncated = true
			result.Reason = "bytes"
			break
		}
		size += len(encoded)
		result.Rows = append(result.Rows, line)
	}
	if err = rows.Err(); err != nil {
		return empty, queryError(ctx)
	}
	return result, nil
}
