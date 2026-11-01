//go:build amd64 || arm64

package queryguard

import (
	"fmt"
	"strings"

	"github.com/pingcap/tidb/pkg/parser"
	"github.com/pingcap/tidb/pkg/parser/ast"
	"github.com/pingcap/tidb/pkg/parser/mysql"
	"github.com/pingcap/tidb/pkg/parser/opcode"
	_ "github.com/pingcap/tidb/pkg/parser/test_driver"
)

func Available() bool { return true }

// Validate parses exactly one statement and emits SQL exclusively from an
// allowlisted AST. Neither comments nor arbitrary source text reach the driver.
func Validate(query, sqlMode string, policy Policy, maxRows int) (Plan, error) {
	if len(query) == 0 || len(query) > 16384 || strings.Contains(query, "/*") || strings.Contains(query, "--") || strings.Contains(query, "#") || !identifier.MatchString(policy.Database) || maxRows < 1 || maxRows > 1000 {
		return Plan{}, ErrDenied
	}
	mode, err := mysql.GetSQLMode(sqlMode)
	if err != nil {
		return Plan{}, ErrDenied
	}
	p := parser.New()
	p.SetSQLMode(mode)
	statements, warnings, err := p.ParseSQL(query)
	if err != nil || len(warnings) != 0 || len(statements) != 1 {
		return Plan{}, ErrDenied
	}
	s, ok := statements[0].(*ast.SelectStmt)
	if !ok || s.Kind != ast.SelectStmtKindSelect || s.With != nil || s.GroupBy != nil || s.Having != nil || len(s.WindowSpecs) != 0 || s.Limit != nil || s.LockInfo != nil || s.SelectIntoOpt != nil || s.Distinct || len(s.TableHints) != 0 || s.From == nil || s.From.TableRefs == nil || s.Fields == nil {
		return Plan{}, ErrDenied
	}
	if opts := s.SelectStmtOpts; opts != nil && (opts.Distinct || opts.SQLBigResult || opts.SQLBufferResult || opts.SQLSmallResult || opts.CalcFoundRows || opts.StraightJoin || opts.Priority != 0 || len(opts.TableHints) != 0) {
		return Plan{}, ErrDenied
	}
	join := s.From.TableRefs
	if join.Right != nil || join.On != nil || len(join.Using) != 0 || join.NaturalJoin || join.StraightJoin {
		return Plan{}, ErrDenied
	}
	source, ok := join.Left.(*ast.TableSource)
	if !ok || source.AsName.O != "" {
		return Plan{}, ErrDenied
	}
	table, ok := source.Source.(*ast.TableName)
	if !ok || !identifier.MatchString(table.Name.O) || (table.Schema.O != "" && table.Schema.O != policy.Database) || len(table.IndexHints) != 0 || len(table.PartitionNames) != 0 || table.TableSample != nil || table.AsOf != nil {
		return Plan{}, ErrDenied
	}
	allowed, ok := policy.Tables[table.Name.O]
	if !ok || len(allowed) == 0 {
		return Plan{}, ErrDenied
	}
	columns := make(map[string]bool, len(allowed))
	for _, col := range allowed {
		if !identifier.MatchString(col) || columns[col] {
			return Plan{}, ErrDenied
		}
		columns[col] = true
	}
	column := func(expr ast.ExprNode) (string, bool) {
		c, ok := expr.(*ast.ColumnNameExpr)
		if !ok || c.Name == nil || !columns[c.Name.Name.O] || (c.Name.Table.O != "" && c.Name.Table.O != table.Name.O) || (c.Name.Schema.O != "" && c.Name.Schema.O != policy.Database) {
			return "", false
		}
		return "`" + c.Name.Name.O + "`", true
	}
	if len(s.Fields.Fields) == 0 || len(s.Fields.Fields) > 256 {
		return Plan{}, ErrDenied
	}
	projections := make([]string, 0, len(s.Fields.Fields))
	plan := Plan{Table: table.Name.O, MaxRows: maxRows}
	for _, field := range s.Fields.Fields {
		if field == nil || field.WildCard != nil || field.AsName.O != "" {
			return Plan{}, ErrDenied
		}
		name, ok := column(field.Expr)
		if !ok {
			return Plan{}, ErrDenied
		}
		projections = append(projections, name)
		plan.Columns = append(plan.Columns, field.Expr.(*ast.ColumnNameExpr).Name.Name.O)
	}
	var predicate func(ast.ExprNode, int) (string, error)
	predicate = func(expr ast.ExprNode, depth int) (string, error) {
		if depth > 32 {
			return "", ErrDenied
		}
		if paren, ok := expr.(*ast.ParenthesesExpr); ok {
			return predicate(paren.Expr, depth+1)
		}
		if isNull, ok := expr.(*ast.IsNullExpr); ok {
			col, allowed := column(isNull.Expr)
			if !allowed {
				return "", ErrDenied
			}
			if isNull.Not {
				return col + " IS NOT NULL", nil
			}
			return col + " IS NULL", nil
		}
		binary, ok := expr.(*ast.BinaryOperationExpr)
		if !ok {
			return "", ErrDenied
		}
		if binary.Op == opcode.LogicAnd || binary.Op == opcode.LogicOr {
			left, e1 := predicate(binary.L, depth+1)
			right, e2 := predicate(binary.R, depth+1)
			if e1 != nil || e2 != nil {
				return "", ErrDenied
			}
			op := " AND "
			if binary.Op == opcode.LogicOr {
				op = " OR "
			}
			return "(" + left + op + right + ")", nil
		}
		ops := map[opcode.Op]string{opcode.EQ: "=", opcode.NullEQ: "<=>", opcode.NE: "<>", opcode.LT: "<", opcode.LE: "<=", opcode.GT: ">", opcode.GE: ">="}
		op, ok := ops[binary.Op]
		if !ok {
			return "", ErrDenied
		}
		col, ok := column(binary.L)
		if !ok {
			return "", ErrDenied
		}
		if _, ok := binary.R.(ast.ParamMarkerExpr); !ok {
			return "", ErrDenied
		}
		plan.Parameters++
		plan.NullSafeParameters = append(plan.NullSafeParameters, binary.Op == opcode.NullEQ)
		if plan.Parameters > 64 {
			return "", ErrDenied
		}
		return col + " " + op + " ?", nil
	}
	statement := "SELECT " + strings.Join(projections, ", ") + " FROM `" + policy.Database + "`.`" + table.Name.O + "`"
	if s.Where != nil {
		where, err := predicate(s.Where, 0)
		if err != nil {
			return Plan{}, err
		}
		statement += " WHERE " + where
	}
	if s.OrderBy != nil {
		if len(s.OrderBy.Items) == 0 || len(s.OrderBy.Items) > 32 {
			return Plan{}, ErrDenied
		}
		order := make([]string, 0, len(s.OrderBy.Items))
		for _, item := range s.OrderBy.Items {
			if item == nil {
				return Plan{}, ErrDenied
			}
			name, ok := column(item.Expr)
			if !ok {
				return Plan{}, ErrDenied
			}
			if item.Desc {
				name += " DESC"
			} else {
				name += " ASC"
			}
			order = append(order, name)
		}
		statement += " ORDER BY " + strings.Join(order, ", ")
	}
	statement += fmt.Sprintf(" LIMIT %d", maxRows+1)
	// The MySQL driver buffers complete rows before the executor can inspect
	// them. Bound each value on the server and send separate truncation flags;
	// otherwise a single untrusted BLOB could allocate an arbitrarily large row.
	bounded := make([]string, 0, len(projections)*2)
	flags := make([]string, 0, len(projections))
	for i, name := range projections {
		value := name
		lengthValue := name
		if policy.TextColumns[plan.Columns[i]] {
			lengthValue = "CONVERT(" + name + " USING utf8mb4)"
		}
		if policy.BinaryColumns[plan.Columns[i]] {
			value = "CAST(" + name + " AS BINARY)"
		}
		bounded = append(bounded, fmt.Sprintf("IF(OCTET_LENGTH(%s) > %d, NULL, %s) AS %s", lengthValue, MaxCellBytes, value, name))
		flags = append(flags, fmt.Sprintf("(OCTET_LENGTH(%s) > %d) AS `__cell_%d`", lengthValue, MaxCellBytes, i))
	}
	prefix := "SELECT " + strings.Join(projections, ", ")
	plan.SQL = "SELECT " + strings.Join(append(bounded, flags...), ", ") + strings.TrimPrefix(statement, prefix)
	return plan, nil
}
