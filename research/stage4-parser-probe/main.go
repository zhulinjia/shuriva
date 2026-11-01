package main

import (
	"fmt"
	"vitess.io/vitess/go/vt/sqlparser"
)

func main() {
	p := sqlparser.NewTestParser()
	for _, sql := range []string{"SELECT id FROM customers WHERE id = ?", "SELECT * FROM customers FOR UPDATE", "SELECT id FROM customers; DELETE FROM customers", "SELECT /*!50000 SLEEP(1) */ id FROM customers"} {
		stmt, err := p.Parse(sql)
		fmt.Printf("%T error=%v\n", stmt, err)
	}
}
