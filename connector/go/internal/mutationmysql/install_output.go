package mutationmysql

import (
	"fmt"
	"strings"
)

func (p InstallPlan) SQL() string {
	var b strings.Builder
	b.WriteString("-- Offline trusted DBA installation; review before execution. No passwords are included.\n-- Stop controlled writes and drain existing transactions before maintenance.\n")
	for _, statement := range p.Statements {
		if strings.HasPrefix(statement, "CREATE DEFINER=") {
			b.WriteString("DELIMITER $$\n")
			b.WriteString(statement)
			b.WriteString("$$\nDELIMITER ;\n")
		} else {
			b.WriteString(statement)
			b.WriteString(";\n")
		}
	}
	return b.String()
}
func (p InstallPlan) String() string {
	return fmt.Sprintf("controlled-write installation for %s (%d tables); credentials omitted", p.Spec.Catalog, len(p.Spec.Tables))
}
