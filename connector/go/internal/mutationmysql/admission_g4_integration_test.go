package mutationmysql

import (
	"context"
	"strings"
	"testing"

	"example.com/ai-database-workspace/connector/internal/mutationguard"
)

func TestG4RealTableImplicitBehaviorRefused(t *testing.T) {
	for _, kind := range []string{"no-primary-key", "nontransactional", "generated", "incoming-foreign-key", "outgoing-foreign-key", "expression-default", "automatic-update", "view"} {
		t.Run(kind, func(t *testing.T) {
			l := newLab(t)
			r := newCoreRunner(t, l, l.controller)
			orders := qualified(l.manifest.Spec.Catalog, "orders")
			plan := mutationguard.Plan{Operation: "delete", Table: "orders", Where: integerWhere("1")}
			// Prove the starting table and same plan work before adding one fault.
			if _, err := r.Preview(context.Background(), plan); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "no-primary-key":
				l.fixture.Exec(t, "ALTER TABLE "+orders+" MODIFY id BIGINT UNSIGNED NOT NULL,DROP PRIMARY KEY")
			case "nontransactional":
				l.fixture.Exec(t, "ALTER TABLE "+orders+" ENGINE=MyISAM")
			case "generated":
				l.fixture.Exec(t, "ALTER TABLE "+orders+" ADD COLUMN derived DECIMAL(12,2) AS (amount+1) VIRTUAL")
			case "incoming-foreign-key":
				l.fixture.Exec(t, "CREATE TABLE "+qualified(l.manifest.Spec.Catalog, "child")+"(id BIGINT PRIMARY KEY,parent_id BIGINT UNSIGNED,FOREIGN KEY(parent_id) REFERENCES "+orders+"(id)) ENGINE=InnoDB")
			case "outgoing-foreign-key":
				l.fixture.Exec(t, "CREATE TABLE "+qualified(l.manifest.Spec.Catalog, "parent")+"(id BIGINT UNSIGNED PRIMARY KEY) ENGINE=InnoDB")
				l.fixture.Exec(t, "INSERT INTO "+qualified(l.manifest.Spec.Catalog, "parent")+" VALUES (1)")
				l.fixture.Exec(t, "ALTER TABLE "+orders+" ADD FOREIGN KEY(id) REFERENCES "+qualified(l.manifest.Spec.Catalog, "parent")+"(id)")
			case "expression-default":
				l.fixture.Exec(t, "ALTER TABLE "+orders+" ADD COLUMN expression_value INT DEFAULT (ABS(-1))")
			case "automatic-update":
				l.fixture.Exec(t, "ALTER TABLE "+orders+" ADD COLUMN touched TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP")
			case "view":
				l.fixture.Exec(t, "RENAME TABLE "+orders+" TO "+qualified(l.manifest.Spec.Catalog, "original_orders"))
				l.fixture.Exec(t, "CREATE VIEW "+orders+" AS SELECT * FROM "+qualified(l.manifest.Spec.Catalog, "original_orders"))
			}
			if _, err := r.Preview(context.Background(), plan); err == nil {
				t.Fatal("unsafe real table acquired an executable preview")
			}
			var count int
			if err := l.fixture.Admin.QueryRow("SELECT COUNT(*) FROM " + orders).Scan(&count); err != nil || count != 1 {
				t.Fatal("admission test changed source rows")
			}
		})
	}
}

func TestG4RealPreviewLimitsDoNotTruncateOrConfirmEmptyChanges(t *testing.T) {
	for _, kind := range []string{"row-limit", "byte-limit", "empty-target", "no-change"} {
		t.Run(kind, func(t *testing.T) {
			l := newLab(t)
			r := newCoreRunner(t, l, l.controller)
			orders := qualified(l.manifest.Spec.Catalog, "orders")
			plan := mutationguard.Plan{Operation: "update", Table: "orders", Changes: []mutationguard.Assignment{{Column: "label", Value: mutationguard.Value{Kind: "string", Value: "planned"}}}, Where: integerWhere("1")}
			if _, err := r.Preview(context.Background(), plan); err != nil {
				t.Fatal(err)
			}
			wantRows := 1
			switch kind {
			case "row-limit", "byte-limit":
				plan.Where = []mutationguard.Predicate{{Column: "tenant", Operator: "eq", Value: &mutationguard.Value{Kind: "string", Value: "east"}}}
				label := "extra"
				wantRows = 21
				if kind == "byte-limit" {
					l.fixture.Exec(t, "ALTER TABLE "+orders+" MODIFY label VARCHAR(8000) NOT NULL,ADD COLUMN padding VARCHAR(8000) NOT NULL DEFAULT ''")
					label = strings.Repeat("\U0001F600", 8000)
					wantRows = 20
				}
				for i := 1; i < wantRows; i++ {
					if kind == "byte-limit" {
						l.fixture.Exec(t, "INSERT INTO "+orders+"(label,padding) VALUES (?,?)", label, label)
					} else {
						l.fixture.Exec(t, "INSERT INTO "+orders+"(label) VALUES (?)", label)
					}
					if kind == "byte-limit" && i == 1 {
						if preview, err := r.Preview(context.Background(), plan); err != nil || preview.RowCount != 2 {
							t.Fatal("wide rows below the byte budget are not supported; this would not test the size boundary")
						}
					}
				}
			case "empty-target":
				plan.Where = integerWhere("999999")
			case "no-change":
				plan.Changes[0].Value.Value = "first"
			}
			if _, err := r.Preview(context.Background(), plan); err == nil {
				t.Fatal("limited or empty preview was confirmed by truncation")
			}
			var count int
			if err := l.fixture.Admin.QueryRow("SELECT COUNT(*) FROM " + orders).Scan(&count); err != nil || count != wantRows {
				t.Fatal("preview limit changed source data")
			}
		})
	}
}
