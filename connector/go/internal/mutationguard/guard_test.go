package mutationguard

import (
	"encoding/base64"
	"strings"
	"testing"
)

func testTable() Table {
	zero := Value{"decimal", "0.00"}
	empty := Value{"string", ""}
	return Table{Database: "lab", Name: "orders", Engine: "InnoDB", BaseTable: true, Complete: true, Definition: "trusted-definition", SQLMode: "STRICT_TRANS_TABLES", Columns: []Column{{Name: "id", Kind: "integer", Bits: 64, PrimaryOrdinal: 1}, {Name: "tenant", Kind: "string", MaxLength: 20}, {Name: "label", Kind: "string", MaxLength: 64, Default: &empty}, {Name: "amount", Kind: "decimal", Precision: 12, Scale: 2, Default: &zero}}}
}
func testPolicy() Policy {
	return Policy{Database: "lab", Table: "orders", InsertColumns: []string{"id", "tenant", "label", "amount"}, UpdateColumns: []string{"label", "amount"}, PreviewColumns: []string{"id", "tenant", "label", "amount"}, Delete: true, RowPredicates: []Predicate{{Column: "tenant", Operator: "eq", Value: &Value{"string", "east"}}}, MaxRows: 20, MaxBytes: MaxBytes, Generation: "policy"}
}
func idPredicate() Predicate {
	return Predicate{Column: "id", Operator: "eq", Value: &Value{"integer", "1"}}
}

func TestDecodePlanRejectsAmbiguousAndUnknownInput(t *testing.T) {
	valid := `{"operation":"update","table":"orders","changes":[{"column":"label","value":{"kind":"string","value":"safe"}}],"where":[{"column":"id","operator":"eq","value":{"kind":"integer","value":"1"}}]}`
	if _, err := DecodePlan([]byte(valid)); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{
		strings.Replace(valid, `"operation":"update"`, `"operation":"delete","operation":"update"`, 1),
		strings.Replace(valid, `"kind":"string"`, `"kind":"string","kind":"integer"`, 1),
		strings.Replace(valid, `"operation":"update"`, `"sql":"DROP TABLE orders","operation":"update"`, 1),
		strings.Replace(valid, `"where":[{"column":"id","operator":"eq","value":{"kind":"integer","value":"1"}}]`, `"where":[]`, 1),
		strings.Replace(valid, `"kind":"string","value":"safe"`, `"kind":"null"`, 1),
		valid + ` {}`,
		`{"operation":"replace","table":"orders"}`,
		`{"operation":"insert","table":"orders","rows":[]}`,
	} {
		if _, err := DecodePlan([]byte(raw)); err == nil {
			t.Fatalf("accepted ambiguous/unsupported input: %s", raw)
		}
	}
}
func TestPreciseValueBoundariesAndCanonicalForms(t *testing.T) {
	for _, tc := range []struct {
		name   string
		column Column
		value  Value
		want   string
		ok     bool
	}{
		{"uint64", Column{Kind: "integer", Bits: 64, Unsigned: true}, Value{"integer", "18446744073709551615"}, "18446744073709551615", true},
		{"uint64-overflow", Column{Kind: "integer", Bits: 64, Unsigned: true}, Value{"integer", "18446744073709551616"}, "", false},
		{"int64-min", Column{Kind: "integer", Bits: 64}, Value{"integer", "-9223372036854775808"}, "-9223372036854775808", true},
		{"int64-overflow", Column{Kind: "integer", Bits: 64}, Value{"integer", "9223372036854775808"}, "", false},
		{"unknown-bit-width", Column{Kind: "integer", Bits: -1}, Value{"integer", "1"}, "", false},
		{"precise-decimal", Column{Kind: "decimal", Precision: 65, Scale: 30}, Value{"decimal", strings.Repeat("9", 35) + "." + strings.Repeat("1", 30)}, strings.Repeat("9", 35) + "." + strings.Repeat("1", 30), true},
		{"decimal-pad", Column{Kind: "decimal", Precision: 8, Scale: 3}, Value{"decimal", "1.2"}, "1.200", true},
		{"decimal-negative-zero", Column{Kind: "decimal", Precision: 8, Scale: 3}, Value{"decimal", "-0.000"}, "0.000", true},
		{"scale-loss", Column{Kind: "decimal", Precision: 8, Scale: 2}, Value{"decimal", "1.001"}, "", false},
		{"precision-loss", Column{Kind: "decimal", Precision: 4, Scale: 2}, Value{"decimal", "100.00"}, "", false},
		{"no-exponent", Column{Kind: "decimal", Precision: 8, Scale: 2}, Value{"decimal", "1e2"}, "", false},
		{"leap-date", Column{Kind: "date"}, Value{"date", "2024-02-29"}, "2024-02-29", true},
		{"invalid-date", Column{Kind: "date"}, Value{"date", "2025-02-29"}, "", false},
		{"datetime-pad", Column{Kind: "datetime", Scale: 3}, Value{"datetime", "2026-11-01 01:02:03.1"}, "2026-11-01 01:02:03.100", true},
		{"datetime-loss", Column{Kind: "datetime", Scale: 3}, Value{"datetime", "2026-11-01 01:02:03.1234"}, "", false},
		{"nullable", Column{Kind: "string", MaxLength: 8, Nullable: true}, Value{"null", ""}, "", true},
		{"not-null", Column{Kind: "string", MaxLength: 8}, Value{"null", ""}, "", false},
		{"binary", Column{Kind: "binary", MaxLength: 4}, Value{"binary", base64.StdEncoding.EncodeToString([]byte{0, 255, 128})}, base64.StdEncoding.EncodeToString([]byte{0, 255, 128}), true},
		{"boolean", Column{Kind: "boolean"}, Value{"boolean", "true"}, "true", true},
		{"boolean-not-integer", Column{Kind: "boolean"}, Value{"integer", "1"}, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Normalize(tc.column, tc.value)
			if (err == nil) != tc.ok || (tc.ok && got.Value != tc.want) {
				t.Fatalf("got %v %v", got, err)
			}
		})
	}
}
func TestTableAdmissionFailsClosedForImplicitBehavior(t *testing.T) {
	if err := ValidateTable(testTable()); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*Table){
		func(t *Table) { t.Complete = false }, func(t *Table) { t.BaseTable = false }, func(t *Table) { t.Engine = "MyISAM" }, func(t *Table) { t.Triggers = 1 }, func(t *Table) { t.IncomingForeignKeys = 1 }, func(t *Table) { t.OutgoingForeignKeys = 1 }, func(t *Table) { t.Checks = 1 }, func(t *Table) { t.Columns[0].PrimaryOrdinal = 0 }, func(t *Table) { t.Columns[2].Generated = true }, func(t *Table) { t.Columns[2].ExpressionDefault = true }, func(t *Table) { t.Columns[2].OnUpdate = true }, func(t *Table) { t.Columns[2].Kind = "json" },
	} {
		table := testTable()
		change(&table)
		if ValidateTable(table) == nil {
			t.Fatal("unsafe table admitted")
		}
	}
}
func TestRowPolicyProtectsOldAndNewValuesAndDefaults(t *testing.T) {
	table, policy := testTable(), testPolicy()
	plan := Plan{Operation: "update", Table: "orders", Changes: []Assignment{{"amount", Value{"decimal", "1.2"}}}, Where: []Predicate{idPredicate()}}
	if _, err := Validate(table, policy, plan); err != nil {
		t.Fatal(err)
	}
	policy.UpdateColumns = append(policy.UpdateColumns, "tenant")
	if _, err := Validate(table, policy, plan); err == nil {
		t.Fatal("policy permitted changing a protected row field")
	}
	row := Row{"id": Value{"integer", "1"}, "tenant": Value{"string", "west"}, "label": Value{"string", "a"}, "amount": Value{"decimal", "1.00"}}
	if ok, err := Matches(table, row, testPolicy().RowPredicates); err != nil || ok {
		t.Fatal("old row outside scope was authorized")
	}
	west := Value{"string", "west"}
	table.Columns[1].Default = &west
	newRow, err := InsertRow(table, []Assignment{{"id", Value{"integer", "1"}}})
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := Matches(table, newRow, testPolicy().RowPredicates); err != nil || ok {
		t.Fatal("database literal default outside scope was authorized")
	}
	row["tenant"] = Value{"string", "east"}
	if ok, err := Matches(table, row, testPolicy().RowPredicates); err != nil || !ok {
		t.Fatal("valid scope rejected")
	}
	missing := cloneTestRow(row)
	delete(missing, "label")
	if _, err := NormalizeRow(table, missing); err == nil {
		t.Fatal("incomplete full row accepted")
	}
	privatePolicy := testPolicy()
	privatePolicy.InsertColumns = []string{"id", "tenant", "label"}
	privatePolicy.UpdateColumns = []string{"label"}
	privatePolicy.PreviewColumns = []string{"id", "tenant", "label"}
	guess := Plan{Operation: "delete", Table: "orders", Where: []Predicate{{Column: "amount", Operator: "eq", Value: &Value{"decimal", "100.00"}}}}
	if _, err := Validate(testTable(), privatePolicy, guess); err == nil {
		t.Fatal("filtering on an internal-only column leaked a value through target membership")
	}
}
func cloneTestRow(row Row) Row {
	out := Row{}
	for k, v := range row {
		out[k] = v
	}
	return out
}

func TestCompilerParsesAllThreeOperationsAndFrozenKeys(t *testing.T) {
	if !Available() {
		t.Skip("AST parser unavailable on this architecture")
	}
	table := testTable()
	key := Row{"id": Value{"integer", "1"}}
	statements := []func() (Statement, error){func() (Statement, error) { return Select(table, []Predicate{idPredicate()}, 21, false) }, func() (Statement, error) { return SelectKeys(table, []Row{key}, true) }, func() (Statement, error) {
		return Insert(table, []Assignment{{"id", Value{"integer", "1"}}, {"tenant", Value{"string", "east"}}})
	}, func() (Statement, error) {
		return Update(table, []Assignment{{"label", Value{"string", "not SQL '; DROP"}}}, key)
	}, func() (Statement, error) { return Delete(table, key) }}
	for _, compile := range statements {
		statement, err := compile()
		if err != nil {
			t.Fatal(err)
		}
		if VerifyStatement(table, statement) != nil {
			t.Fatal("generated AST rejected")
		}
		if strings.Contains(statement.SQL, "DROP") {
			t.Fatal("a bound string entered SQL text")
		}
	}
	for _, statement := range []Statement{
		{SQL: "UPDATE `lab`.`orders` SET `label`=? WHERE `tenant`=?", Args: []any{"x", "east"}, Operation: "update"},
		{SQL: "UPDATE `lab`.`orders` SET `label`=`tenant` WHERE `id`=?", Args: []any{1}, Operation: "update"},
		{SQL: "DELETE FROM `lab`.`orders`", Operation: "delete"},
		{SQL: "DELETE FROM `lab`.`orders` WHERE `id`=? OR `id`=?", Args: []any{1, 2}, Operation: "delete"},
		{SQL: "INSERT INTO `lab`.`orders` (`id`) VALUES (1)", Operation: "insert"},
		{SQL: "REPLACE INTO `lab`.`orders` (`id`) VALUES (?)", Args: []any{1}, Operation: "insert"},
		{SQL: "INSERT IGNORE INTO `lab`.`orders` (`id`) VALUES (?)", Args: []any{1}, Operation: "insert"},
		{SQL: "INSERT INTO `lab`.`orders` (`id`) VALUES (?) ON DUPLICATE KEY UPDATE `label`=?", Args: []any{1, "x"}, Operation: "insert"},
		{SQL: "DELETE FROM `other`.`orders` WHERE `id`=?", Args: []any{1}, Operation: "delete"},
	} {
		if VerifyStatement(table, statement) == nil {
			t.Fatalf("unsafe AST admitted: %s", statement.SQL)
		}
	}
}

func TestMetadataStructureIgnoresOnlyAutoIncrementCounter(t *testing.T) {
	if !Available() {
		t.Skip("AST parser unavailable on this architecture")
	}
	first, err := StructuralDefinition("CREATE TABLE orders(id BIGINT PRIMARY KEY AUTO_INCREMENT,label VARCHAR(20) DEFAULT 'AUTO_INCREMENT=10') ENGINE=InnoDB AUTO_INCREMENT=2", "STRICT_TRANS_TABLES")
	if err != nil {
		t.Fatal(err)
	}
	second, err := StructuralDefinition("CREATE TABLE orders(id BIGINT PRIMARY KEY AUTO_INCREMENT,label VARCHAR(20) DEFAULT 'AUTO_INCREMENT=10') ENGINE=InnoDB AUTO_INCREMENT=3", "STRICT_TRANS_TABLES")
	if err != nil || first != second {
		t.Fatal("ordinary inserted row changed the structural definition")
	}
	changed, err := StructuralDefinition("CREATE TABLE orders(id BIGINT PRIMARY KEY AUTO_INCREMENT,label VARCHAR(20) DEFAULT 'AUTO_INCREMENT=11') ENGINE=InnoDB AUTO_INCREMENT=3", "STRICT_TRANS_TABLES")
	if err != nil || first == changed {
		t.Fatal("real default change was erased with the sequence counter")
	}
	if _, err := StructuralDefinition("CREATE TABLE orders(id INT); DROP TABLE orders", "STRICT_TRANS_TABLES"); err == nil {
		t.Fatal("multiple metadata statements accepted")
	}
	policy := testPolicy()
	plan := Plan{Operation: "delete", Table: "orders", Where: []Predicate{{Column: "label", Operator: "ne", Value: &Value{"string", "x"}}}}
	if _, err := Validate(testTable(), policy, plan); err == nil {
		t.Fatal("unverified native text collation could omit part of an inequality target set")
	}
}
