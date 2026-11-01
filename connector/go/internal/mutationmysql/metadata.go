package mutationmysql

import (
	"context"
	"database/sql"
	"encoding/base64"
	"example.com/ai-database-workspace/connector/internal/mutationguard"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	"strconv"
	"strings"
	"unicode/utf8"
)

type resultRow []*string
type tableProof struct {
	kind, engine, definition, sqlMode    string
	columns                              []resultRow
	triggers, incoming, outgoing, checks int
}

func validateControl(name string, p tableProof) error {
	if p.kind != "BASE TABLE" || p.engine != "InnoDB" || p.triggers != 0 || p.incoming != 0 || p.outgoing != 0 || p.checks != 0 {
		return ErrInstallation
	}
	columns := [][2]string{{"catalog", "varbinary(256)"}, {"incarnation", "binary(64)"}, {"epoch", "binary(64)"}}
	primary := "catalog"
	if name == "receipts" {
		columns = [][2]string{{"execution_id", "binary(36)"}, {"commitment", "binary(32)"}, {"scope", "varbinary(1024)"}, {"target_epoch", "binary(64)"}, {"row_count", "smallint unsigned"}}
		primary = "execution_id"
	} else if name != "gate" {
		return ErrInstallation
	}
	if len(p.columns) != len(columns) || !strings.Contains(p.definition, "PRIMARY KEY (`"+primary+"`)") {
		return ErrInstallation
	}
	for i, want := range columns {
		row := p.columns[i]
		if text(row, 0) != want[0] || text(row, 2) != want[1] || text(row, 3) != "NO" || row[4] != nil || text(row, 5) != "" || text(row, 6) != "" || number(row, 7) != i+1 {
			return ErrInstallation
		}
	}
	return nil
}

func columns(rows *sql.Rows, want []string) error {
	got, err := rows.Columns()
	if err != nil || len(got) != len(want) {
		return ErrInstallation
	}
	for i, name := range want {
		if name == "GRANTS" {
			if !strings.HasPrefix(got[i], "Grants for ") {
				return ErrInstallation
			}
		} else if got[i] != name {
			return ErrInstallation
		}
	}
	return nil
}
func readSet(rows *sql.Rows, shape []string, budget *int) ([]resultRow, error) {
	if columns(rows, shape) != nil {
		return nil, ErrInstallation
	}
	var out []resultRow
	for rows.Next() {
		if len(out) >= 4096 {
			return nil, ErrInstallation
		}
		raw := make([][]byte, len(shape))
		dest := make([]any, len(raw))
		for i := range raw {
			dest[i] = &raw[i]
		}
		if rows.Scan(dest...) != nil {
			return nil, ErrInstallation
		}
		row := make(resultRow, len(raw))
		for i, value := range raw {
			if value != nil {
				if !utf8.Valid(value) {
					return nil, ErrInstallation
				}
				*budget += len(value)
				if *budget > 1<<20 {
					return nil, ErrInstallation
				}
				text := string(value)
				row[i] = &text
			}
		}
		out = append(out, row)
	}
	if rows.Err() != nil {
		return nil, ErrInstallation
	}
	return out, nil
}
func text(row resultRow, index int) string {
	if index >= len(row) || row[index] == nil {
		return ""
	}
	return *row[index]
}
func number(row resultRow, index int) int {
	v, err := strconv.Atoi(text(row, index))
	if err != nil {
		return 0
	}
	return v
}
func nextSet(rows *sql.Rows, shape []string, budget *int) ([]resultRow, error) {
	if !rows.NextResultSet() {
		return nil, ErrInstallation
	}
	return readSet(rows, shape, budget)
}
func flatGrant(rows []resultRow) []string {
	grants := make([]string, len(rows))
	for i, row := range rows {
		grants[i] = text(row, 0)
	}
	return grants
}
func (c *Controller) inspect(ctx context.Context, q sqlQueryer, schema, table string) (tableProof, error) {
	var p tableProof
	rows, err := q.QueryContext(ctx, "CALL "+qualified(c.manifest.ControlCatalog, proofName(schema, table))+"()")
	if err != nil {
		return p, ErrInstallation
	}
	defer rows.Close()
	budget := 0
	grants, err := readSet(rows, []string{"GRANTS"}, &budget)
	if err != nil || !sameStrings(flatGrant(grants), c.manifest.DefinerGrants) {
		return p, ErrInstallation
	}
	id, err := nextSet(rows, []string{"proof_definer", "server_uuid", "server_version", "target_schema", "target_table", "mandatory_roles", "activate_all_roles_on_login", "active_roles"}, &budget)
	if err != nil || len(id) != 1 || text(id[0], 0) != c.manifest.Definer.User+"@"+c.manifest.Definer.Host || text(id[0], 1) != c.manifest.ServerUUID || text(id[0], 2) != c.manifest.ServerVersion || text(id[0], 3) != schema || text(id[0], 4) != table || text(id[0], 5) != "" || text(id[0], 6) != "0" || text(id[0], 7) != "NONE" {
		return p, ErrInstallation
	}
	tableRows, err := nextSet(rows, []string{"TABLE_TYPE", "ENGINE"}, &budget)
	if err != nil || len(tableRows) != 1 {
		return p, ErrInstallation
	}
	p.kind, p.engine = text(tableRows[0], 0), text(tableRows[0], 1)
	definition, err := nextSet(rows, []string{"Table", "Create Table"}, &budget)
	if err != nil || len(definition) != 1 || text(definition[0], 0) != table {
		return p, ErrInstallation
	}
	p.definition = text(definition[0], 1)
	p.columns, err = nextSet(rows, []string{"COLUMN_NAME", "DATA_TYPE", "COLUMN_TYPE", "IS_NULLABLE", "COLUMN_DEFAULT", "EXTRA", "GENERATION_EXPRESSION", "ORDINAL_POSITION", "CHARACTER_MAXIMUM_LENGTH", "NUMERIC_PRECISION", "NUMERIC_SCALE", "DATETIME_PRECISION"}, &budget)
	if err != nil || len(p.columns) == 0 || len(p.columns) > 256 {
		return p, ErrInstallation
	}
	triggers, err := nextSet(rows, []string{"TRIGGER_NAME"}, &budget)
	if err != nil {
		return p, err
	}
	p.triggers = len(triggers)
	for _, count := range []*int{&p.incoming, &p.outgoing} {
		dependencies, err := nextSet(rows, []string{"CONSTRAINT_NAME", "COLUMN_NAME", "REFERENCED_TABLE_SCHEMA", "REFERENCED_TABLE_NAME"}, &budget)
		if err != nil {
			return p, err
		}
		*count = len(dependencies)
	}
	checks, err := nextSet(rows, []string{"CONSTRAINT_NAME"}, &budget)
	if err != nil {
		return p, err
	}
	p.checks = len(checks)
	plan, err := BuildInstallation(c.manifest.Spec)
	if err != nil {
		return p, err
	}
	for _, routine := range plan.Routines {
		found, err := nextSet(rows, []string{"Procedure", "sql_mode", "Create Procedure", "character_set_client", "collation_connection", "Database Collation"}, &budget)
		if err != nil || len(found) != 1 {
			return p, ErrInstallation
		}
		d := Definition{text(found[0], 0), text(found[0], 1), text(found[0], 2), text(found[0], 3), text(found[0], 4), text(found[0], 5)}
		if d != c.manifest.Definitions[routine.Name] {
			return p, ErrInstallation
		}
		if p.sqlMode == "" {
			p.sqlMode = d.SQLMode
		}
		if !supportedMode(d.SQLMode) {
			return p, ErrInstallation
		}
	}
	closing, err := nextSet(rows, []string{"GRANTS"}, &budget)
	if err != nil || !sameStrings(flatGrant(closing), c.manifest.DefinerGrants) {
		return p, ErrInstallation
	}
	roles, err := nextSet(rows, []string{"mandatory_roles", "activate_all_roles_on_login", "active_roles"}, &budget)
	if err != nil || len(roles) != 1 || text(roles[0], 0) != "" || text(roles[0], 1) != "0" || text(roles[0], 2) != "NONE" || rows.NextResultSet() || rows.Err() != nil {
		return p, ErrInstallation
	}
	return p, nil
}

func (t *transaction) Describe(ctx context.Context, table string) (mutationguard.Table, error) {
	return t.describe(ctx, table, true)
}
func (t *transaction) describe(ctx context.Context, table string, lock bool) (mutationguard.Table, error) {
	var meta mutationguard.Table
	allowed := false
	for _, name := range t.controller.manifest.Spec.Tables {
		if name == table {
			allowed = true
		}
	}
	if !allowed {
		return meta, mutationrunner.ErrDenied
	}
	// Even an empty table is touched inside the transaction to retain its MDL.
	if lock {
		lockRows, err := t.tx.QueryContext(ctx, "SELECT 1 FROM "+qualified(t.controller.manifest.Spec.Catalog, table)+" LIMIT 1 FOR UPDATE")
		if err != nil {
			return meta, ErrTarget
		}
		if lockRows.Close() != nil {
			return meta, ErrTarget
		}
	}
	p, err := t.controller.inspect(ctx, t.tx, t.controller.manifest.Spec.Catalog, table)
	if err != nil {
		return meta, err
	}
	meta = mutationguard.Table{Database: t.controller.manifest.Spec.Catalog, Name: table, Engine: p.engine, BaseTable: p.kind == "BASE TABLE", Complete: true, SQLMode: p.sqlMode, Definition: p.definition, Triggers: p.triggers, IncomingForeignKeys: p.incoming, OutgoingForeignKeys: p.outgoing, Checks: p.checks}
	for index, row := range p.columns {
		if number(row, 7) != index+1 {
			return meta, ErrInstallation
		}
		column := mutationguard.Column{Name: text(row, 0), Nullable: text(row, 3) == "YES", MaxLength: number(row, 8), Precision: number(row, 9), Scale: number(row, 10), Generated: text(row, 6) != "" || strings.Contains(strings.ToUpper(text(row, 5)), "GENERATED"), OnUpdate: strings.Contains(strings.ToLower(text(row, 5)), "on update"), AutoIncrement: strings.Contains(strings.ToLower(text(row, 5)), "auto_increment"), Unsigned: strings.Contains(text(row, 2), "unsigned")}
		dtype := text(row, 1)
		switch dtype {
		case "tinyint", "smallint", "mediumint", "int", "bigint":
			column.Kind = "integer"
			column.Bits = map[string]int{"tinyint": 8, "smallint": 16, "mediumint": 24, "int": 32, "bigint": 64}[dtype]
			if dtype == "tinyint" && text(row, 2) == "tinyint(1)" {
				column.Kind = "boolean"
			}
		case "decimal":
			column.Kind = "decimal"
		case "char", "varchar":
			column.Kind = "string"
		case "binary", "varbinary":
			column.Kind = "binary"
		case "date":
			column.Kind = "date"
		case "datetime":
			column.Kind = "datetime"
			column.Scale = number(row, 11)
		default:
			return meta, mutationguard.ErrDenied
		}
		if strings.Contains(strings.ToUpper(text(row, 5)), "DEFAULT_GENERATED") {
			column.ExpressionDefault = true
		}
		if row[4] != nil {
			value := mutationguard.Value{Kind: column.Kind, Value: text(row, 4)}
			if column.Kind == "boolean" {
				if value.Value == "0" {
					value.Value = "false"
				} else if value.Value == "1" {
					value.Value = "true"
				} else {
					return meta, ErrTarget
				}
			}
			if column.Kind == "binary" {
				value.Value = base64.StdEncoding.EncodeToString([]byte(value.Value))
			}
			normalized, err := mutationguard.Normalize(column, value)
			if err != nil {
				return meta, err
			}
			column.Default = &normalized
		} else if column.Nullable {
			column.Default = &mutationguard.Value{Kind: "null"}
		}
		meta.Columns = append(meta.Columns, column)
	}
	primary, err := t.tx.QueryContext(ctx, "SELECT COLUMN_NAME,SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX", meta.Database, table)
	if err != nil {
		return meta, ErrTarget
	}
	defer primary.Close()
	ordinal := 0
	for primary.Next() {
		var name string
		var position int
		if primary.Scan(&name, &position) != nil || position != ordinal+1 {
			return meta, ErrTarget
		}
		ordinal++
		found := false
		for i := range meta.Columns {
			if meta.Columns[i].Name == name {
				meta.Columns[i].PrimaryOrdinal = position
				found = true
			}
		}
		if !found {
			return meta, ErrTarget
		}
	}
	if primary.Err() != nil {
		return meta, ErrTarget
	}
	if mutationguard.ValidateTable(meta) != nil {
		return meta, mutationguard.ErrDenied
	}
	t.metadata = &meta
	return meta, nil
}
func (t *transaction) Rows(ctx context.Context, s mutationguard.Statement) ([]mutationguard.Row, error) {
	if t.metadata == nil || s.Operation != "select" || s.MaxRows < 1 || s.MaxRows > 101 || mutationguard.VerifyStatement(*t.metadata, s) != nil {
		return nil, mutationrunner.ErrDenied
	}
	rows, err := t.tx.QueryContext(ctx, s.SQL, s.Args...)
	if err != nil {
		return nil, ErrTarget
	}
	defer rows.Close()
	names, err := rows.Columns()
	if err != nil || len(names) != len(s.Columns) {
		return nil, ErrTarget
	}
	for i, name := range names {
		if name != s.Columns[i].Name {
			return nil, ErrTarget
		}
	}
	var result []mutationguard.Row
	total := 0
	for rows.Next() {
		if len(result) >= s.MaxRows {
			return nil, mutationguard.ErrDenied
		}
		raw := make([][]byte, len(names))
		dest := make([]any, len(raw))
		for i := range raw {
			dest[i] = &raw[i]
		}
		if rows.Scan(dest...) != nil {
			return nil, ErrTarget
		}
		row := mutationguard.Row{}
		for i, value := range raw {
			if len(value) > mutationguard.MaxCellBytes {
				return nil, mutationguard.ErrDenied
			}
			total += len(value)
			if total > mutationguard.MaxBytes {
				return nil, mutationguard.ErrDenied
			}
			v := mutationguard.Value{Kind: s.Columns[i].Kind, Value: string(value)}
			if value == nil {
				v = mutationguard.Value{Kind: "null"}
			} else if v.Kind == "binary" {
				v.Value = base64.StdEncoding.EncodeToString(value)
			} else if v.Kind == "boolean" {
				if v.Value == "0" {
					v.Value = "false"
				} else if v.Value == "1" {
					v.Value = "true"
				} else {
					return nil, ErrTarget
				}
			}
			normal, err := mutationguard.Normalize(s.Columns[i], v)
			if err != nil {
				return nil, err
			}
			row[names[i]] = normal
		}
		result = append(result, row)
	}
	if rows.Err() != nil {
		return nil, ErrTarget
	}
	return result, nil
}
