//go:build amd64 || arm64

package mutationguard

import (
	"github.com/pingcap/tidb/pkg/parser"
	"github.com/pingcap/tidb/pkg/parser/ast"
	"github.com/pingcap/tidb/pkg/parser/format"
	"github.com/pingcap/tidb/pkg/parser/mysql"
	"github.com/pingcap/tidb/pkg/parser/opcode"
	_ "github.com/pingcap/tidb/pkg/parser/test_driver"
	"strings"
)

func Available() bool { return true }

// StructuralDefinition excludes only the live auto-increment sequence value.
// All actual schema options, columns and constraints remain in the AST. This
// parses metadata and never authorizes or executes a CREATE statement.
func StructuralDefinition(raw, sqlMode string) (string, error) {
	if len(raw) == 0 || len(raw) > 1<<20 {
		return "", ErrDenied
	}
	mode, err := mysql.GetSQLMode(sqlMode)
	if err != nil {
		return "", ErrDenied
	}
	p := parser.New()
	p.SetSQLMode(mode)
	nodes, warnings, err := p.ParseSQL(raw)
	if err != nil || len(warnings) != 0 || len(nodes) != 1 {
		return "", ErrDenied
	}
	table, ok := nodes[0].(*ast.CreateTableStmt)
	if !ok || table.Select != nil || table.ReferTable != nil {
		return "", ErrDenied
	}
	options := table.Options[:0]
	for _, option := range table.Options {
		if option.Tp != ast.TableOptionAutoIncrement {
			options = append(options, option)
		}
	}
	table.Options = options
	var out strings.Builder
	if table.Restore(format.NewRestoreCtx(format.DefaultRestoreFlags, &out)) != nil {
		return "", ErrDenied
	}
	return out.String(), nil
}

type statementVisitor struct {
	table                    Table
	params, literals, tables int
	denied                   bool
}

func (v *statementVisitor) Enter(node ast.Node) (ast.Node, bool) {
	switch n := node.(type) {
	case ast.ParamMarkerExpr:
		v.params++
	case ast.ValueExpr:
		v.literals++
		switch n.GetValue().(type) {
		case int64, uint64, int:
		default:
			v.denied = true
		}
	case *ast.TableName:
		v.tables++
		if n.Name.O != v.table.Name || n.Schema.O != v.table.Database || len(n.IndexHints) != 0 || len(n.PartitionNames) != 0 || n.AsOf != nil || n.TableSample != nil {
			v.denied = true
		}
	case *ast.TableSource:
		if n.AsName.O != "" {
			v.denied = true
		}
	case *ast.Join:
		if n.Right != nil || n.On != nil || len(n.Using) != 0 || n.NaturalJoin || n.StraightJoin {
			v.denied = true
		}
	case *ast.ColumnName:
		if _, ok := Columns(v.table)[n.Name.O]; !ok || (n.Table.O != "" && n.Table.O != v.table.Name) || (n.Schema.O != "" && n.Schema.O != v.table.Database) {
			v.denied = true
		}
	case *ast.BinaryOperationExpr:
		switch n.Op {
		case opcode.LogicAnd, opcode.LogicOr, opcode.EQ, opcode.NE, opcode.LT, opcode.LE, opcode.GT, opcode.GE:
		default:
			v.denied = true
		}
	case *ast.SelectStmt, *ast.InsertStmt, *ast.UpdateStmt, *ast.DeleteStmt, *ast.TableRefsClause, *ast.FieldList, *ast.SelectField, *ast.ColumnNameExpr, *ast.ParenthesesExpr, *ast.IsNullExpr, *ast.Assignment, *ast.Limit, *ast.OrderByClause, *ast.ByItem:
	default:
		v.denied = true
	}
	return node, v.denied
}
func (v *statementVisitor) Leave(node ast.Node) (ast.Node, bool) { return node, !v.denied }

func validWhere(n ast.ExprNode) bool {
	if n == nil {
		return true
	}
	switch n := n.(type) {
	case *ast.ParenthesesExpr:
		return validWhere(n.Expr)
	case *ast.IsNullExpr:
		_, ok := n.Expr.(*ast.ColumnNameExpr)
		return ok
	case *ast.BinaryOperationExpr:
		if n.Op == opcode.LogicAnd || n.Op == opcode.LogicOr {
			return validWhere(n.L) && validWhere(n.R)
		}
		_, left := n.L.(*ast.ColumnNameExpr)
		_, right := n.R.(ast.ParamMarkerExpr)
		return left && right
	}
	return false
}
func keyOnlyWhere(t Table, node ast.ExprNode) bool {
	seen := map[string]bool{}
	var walk func(ast.ExprNode) bool
	walk = func(node ast.ExprNode) bool {
		if p, ok := node.(*ast.ParenthesesExpr); ok {
			return walk(p.Expr)
		}
		b, ok := node.(*ast.BinaryOperationExpr)
		if !ok {
			return false
		}
		if b.Op == opcode.LogicAnd {
			return walk(b.L) && walk(b.R)
		}
		col, ok := b.L.(*ast.ColumnNameExpr)
		if !ok || col.Name == nil || b.Op != opcode.EQ || seen[col.Name.Name.O] {
			return false
		}
		if _, ok := b.R.(ast.ParamMarkerExpr); !ok {
			return false
		}
		c, ok := Columns(t)[col.Name.Name.O]
		if !ok || c.PrimaryOrdinal == 0 {
			return false
		}
		seen[c.Name] = true
		return true
	}
	return walk(node) && len(seen) == len(Primary(t))
}

// VerifyStatement independently parses compiler output. Callers must still
// enforce the structural plan and local policy; parsing never grants authority.
func VerifyStatement(t Table, s Statement) error {
	if len(s.SQL) == 0 || len(s.SQL) > 65536 || len(s.Args) > 1000 {
		return ErrDenied
	}
	mode, err := mysql.GetSQLMode(t.SQLMode)
	if err != nil {
		return ErrDenied
	}
	p := parser.New()
	p.SetSQLMode(mode)
	nodes, warnings, err := p.ParseSQL(s.SQL)
	if err != nil || len(warnings) != 0 || len(nodes) != 1 {
		return ErrDenied
	}
	selectStatement := false
	switch n := nodes[0].(type) {
	case *ast.SelectStmt:
		selectStatement = true
		if s.Operation != "select" || n.Kind != ast.SelectStmtKindSelect || n.With != nil || n.Distinct || n.GroupBy != nil || n.Having != nil || len(n.WindowSpecs) != 0 || n.SelectIntoOpt != nil || len(n.TableHints) != 0 || n.Fields == nil || n.From == nil || n.Limit == nil || n.Limit.Offset != nil || len(n.Fields.Fields) != len(t.Columns) || s.MaxRows < 1 || s.MaxRows > MaxRows+1 || !validWhere(n.Where) {
			return ErrDenied
		}
		if o := n.SelectStmtOpts; o != nil && (o.Distinct || o.SQLBigResult || o.SQLBufferResult || o.SQLSmallResult || o.CalcFoundRows || o.StraightJoin || o.Priority != 0 || len(o.TableHints) != 0) {
			return ErrDenied
		}
		for i, f := range n.Fields.Fields {
			c, ok := f.Expr.(*ast.ColumnNameExpr)
			if f.WildCard != nil || f.AsName.O != "" || !ok || c.Name.Name.O != t.Columns[i].Name {
				return ErrDenied
			}
		}
		count, ok := n.Limit.Count.(ast.ValueExpr)
		if !ok {
			return ErrDenied
		}
		switch value := count.GetValue().(type) {
		case uint64:
			if value != uint64(s.MaxRows) {
				return ErrDenied
			}
		case int64:
			if value != int64(s.MaxRows) {
				return ErrDenied
			}
		default:
			return ErrDenied
		}
	case *ast.InsertStmt:
		if s.Operation != "insert" || n.IsReplace || n.IgnoreErr || n.Setlist || n.Priority != 0 || len(n.OnDuplicate) != 0 || n.Select != nil || len(n.TableHints) != 0 || len(n.PartitionNames) != 0 || len(n.Lists) != 1 || len(n.Columns) == 0 || len(n.Lists[0]) != len(n.Columns) {
			return ErrDenied
		}
		for _, expression := range n.Lists[0] {
			if _, ok := expression.(ast.ParamMarkerExpr); !ok {
				return ErrDenied
			}
		}
	case *ast.UpdateStmt:
		if s.Operation != "update" || n.Where == nil || len(n.List) == 0 || n.Order != nil || n.Limit != nil || n.Priority != 0 || n.IgnoreErr || n.MultipleTable || len(n.TableHints) != 0 || n.With != nil || !keyOnlyWhere(t, n.Where) {
			return ErrDenied
		}
		for _, assignment := range n.List {
			if _, ok := assignment.Expr.(ast.ParamMarkerExpr); !ok {
				return ErrDenied
			}
			if assignment.Column == nil || Columns(t)[assignment.Column.Name.O].PrimaryOrdinal > 0 {
				return ErrDenied
			}
		}
	case *ast.DeleteStmt:
		if s.Operation != "delete" || n.Where == nil || n.Order != nil || n.Limit != nil || n.Priority != 0 || n.IgnoreErr || n.Quick || n.IsMultiTable || n.BeforeFrom || n.Tables != nil || len(n.TableHints) != 0 || n.With != nil || !keyOnlyWhere(t, n.Where) {
			return ErrDenied
		}
	default:
		return ErrDenied
	}
	v := &statementVisitor{table: t}
	if _, ok := nodes[0].Accept(v); !ok || v.denied || v.tables != 1 || v.params != len(s.Args) {
		return ErrDenied
	}
	expectedLiterals := 0
	if selectStatement {
		expectedLiterals = 1
	}
	if v.literals != expectedLiterals {
		return ErrDenied
	}
	return nil
}
