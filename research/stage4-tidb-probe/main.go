package main

import (
	"fmt"
	"github.com/pingcap/tidb/pkg/parser"
	"github.com/pingcap/tidb/pkg/parser/ast"
	_ "github.com/pingcap/tidb/pkg/parser/test_driver"
)

func main() {
	p := parser.New()
	for _, sql := range []string{"SELECT id FROM customers WHERE id = ?", "SELECT * FROM customers FOR UPDATE", "SELECT id FROM customers; DELETE FROM customers", "SELECT /*!50000 SLEEP(1) */ id FROM customers"} {
		stmts, warnings, err := p.ParseSQL(sql)
		fmt.Printf("count=%d warnings=%d error=%v\n", len(stmts), len(warnings), err)
		if err == nil && len(stmts) == 1 { if s, ok := stmts[0].(*ast.SelectStmt); ok { fmt.Printf("opts=%+v lock=%+v join=%+v\n", s.SelectStmtOpts, s.LockInfo, s.From) } }
	}
}
