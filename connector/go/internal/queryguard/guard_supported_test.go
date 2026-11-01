//go:build amd64 || arm64

package queryguard

import (
	"errors"
	"strings"
	"testing"
)

func TestAuthorizedQueryIsRebuiltFromAST(t *testing.T) {
	policy := Policy{Database: "fixture", Tables: map[string][]string{"customers": {"id", "name"}}}
	plan, err := Validate("SELECT id, name FROM customers WHERE id = ? AND name <> ? ORDER BY id DESC", "", policy, 25)
	if err != nil {
		t.Fatal(err)
	}
	want := "SELECT IF(OCTET_LENGTH(`id`) > 32768, NULL, `id`) AS `id`, IF(OCTET_LENGTH(`name`) > 32768, NULL, `name`) AS `name`, (OCTET_LENGTH(`id`) > 32768) AS `__cell_0`, (OCTET_LENGTH(`name`) > 32768) AS `__cell_1` FROM `fixture`.`customers` WHERE (`id` = ? AND `name` <> ?) ORDER BY `id` DESC LIMIT 26"
	if plan.SQL != want || plan.Parameters != 2 || plan.MaxRows != 25 {
		t.Fatalf("unexpected compiled query: %#v", plan)
	}
}

func TestUnsafeOrUnprovenQueriesFailClosed(t *testing.T) {
	policy := Policy{Database: "fixture", Tables: map[string][]string{"customers": {"id", "name"}}}
	queries := []string{
		"SELECT id FROM customers; DELETE FROM customers",
		"DELETE FROM customers", "SELECT * FROM customers", "SELECT id FROM other",
		"SELECT secret FROM customers", "SELECT id FROM customers WHERE secret = ?",
		"SELECT id FROM otherdb.customers", "SELECT id FROM customers FOR UPDATE",
		"SELECT id FROM customers INTO OUTFILE '/tmp/out'", "SELECT GET_LOCK(?, ?) FROM customers",
		"SELECT SLEEP(?) FROM customers", "SELECT id FROM customers WHERE id = 1",
		"SELECT id FROM customers WHERE id = ? OR EXISTS(SELECT 1 FROM secret)",
		"SELECT id FROM customers WHERE id = ?; SELECT id FROM customers",
		"SELECT /*!50000 SLEEP(1) */ id FROM customers", "SELECT /*+ MAX_EXECUTION_TIME(1) */ id FROM customers",
		"SELECT id FROM customers -- comment\n", "SELECT id FROM customers # comment\n",
		"SELECT id FROM customers LIMIT 5", "SELECT id FROM customers UNION SELECT id FROM customers",
		"SELECT id FROM customers JOIN other ON customers.id = other.id",
		"SELECT c.id FROM customers c", "SELECT id AS alias FROM customers",
		"SELECT id FROM customers ORDER BY secret", "SELECT id FROM customers WHERE @x := ?",
	}
	for _, query := range queries {
		t.Run(query, func(t *testing.T) {
			plan, err := Validate(query, "", policy, 25)
			if !errors.Is(err, ErrDenied) {
				t.Fatalf("unsafe query accepted: %#v, %v", plan, err)
			}
		})
	}
	for _, mode := range []string{"unknown_mode", "ANSI_QUOTES,unknown_mode"} {
		if _, err := Validate("SELECT id FROM customers", mode, policy, 1); !errors.Is(err, ErrDenied) {
			t.Fatalf("unsupported mode accepted: %s", mode)
		}
	}
	if _, err := Validate(strings.Repeat("a", 16385), "", policy, 1); !errors.Is(err, ErrDenied) {
		t.Fatal("unbounded query accepted")
	}
}

func TestPolicyCannotAuthorizeUnsafeIdentifiers(t *testing.T) {
	policies := []Policy{
		{Database: "fixture`evil", Tables: map[string][]string{"customers": {"id"}}},
		{Database: "fixture", Tables: map[string][]string{"customers": {"id", "secret`"}}},
	}
	for _, policy := range policies {
		if _, err := Validate("SELECT id FROM customers", "", policy, 1); !errors.Is(err, ErrDenied) {
			t.Fatal("unsafe policy accepted")
		}
	}
}

func TestNullPredicatesUseOnlyAuthorizedColumns(t *testing.T) {
	policy := Policy{Database: "fixture", Tables: map[string][]string{"customers": {"id", "name"}}}
	for query, fragment := range map[string]string{
		"SELECT id FROM customers WHERE name IS NULL":     "`name` IS NULL",
		"SELECT id FROM customers WHERE name IS NOT NULL": "`name` IS NOT NULL",
		"SELECT id FROM customers WHERE name <=> ?":       "`name` <=> ?",
	} {
		plan, err := Validate(query, "", policy, 5)
		if err != nil || !strings.Contains(plan.SQL, fragment) {
			t.Fatalf("null predicate rejected: %s: %v", query, err)
		}
	}
	for _, query := range []string{"SELECT id FROM customers WHERE secret IS NULL", "SELECT id FROM customers WHERE SLEEP(?) IS NULL", "SELECT id FROM customers WHERE secret <=> ?"} {
		if _, err := Validate(query, "", policy, 5); !errors.Is(err, ErrDenied) {
			t.Fatalf("unauthorized null predicate accepted: %s", query)
		}
	}
}

func TestGeneratedProjectionPreservesBitAndBoundsConvertedText(t *testing.T) {
	policy := Policy{Database: "fixture", Tables: map[string][]string{"records": {"bits", "text_value"}}, BinaryColumns: map[string]bool{"bits": true}, TextColumns: map[string]bool{"text_value": true}}
	plan, err := Validate("SELECT bits, text_value FROM records WHERE bits = ?", "", policy, 2)
	if err != nil {
		t.Fatal(err)
	}
	for _, fragment := range []string{
		"IF(OCTET_LENGTH(`bits`) > 32768, NULL, CAST(`bits` AS BINARY)) AS `bits`",
		"IF(OCTET_LENGTH(CONVERT(`text_value` USING utf8mb4)) > 32768, NULL, `text_value`) AS `text_value`",
		"(OCTET_LENGTH(CONVERT(`text_value` USING utf8mb4)) > 32768) AS `__cell_1`",
	} {
		if !strings.Contains(plan.SQL, fragment) {
			t.Fatalf("missing bounded projection: %s", fragment)
		}
	}
	if _, err = Validate("SELECT bits FROM records WHERE bits = ? OR GET_LOCK(?, ?) = ?", "", policy, 2); !errors.Is(err, ErrDenied) {
		t.Fatal("function smuggled through a guarded projection")
	}
}
