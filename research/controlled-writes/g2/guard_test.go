package g2

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"

	"example.com/stackoryn/research/controlled-writes-g2/internal/lab"
)

func openVerifiedMySQL(t *testing.T) *sql.DB {
	t.Helper()
	path := os.Getenv("STAGE8_G2_MANIFEST")
	if path == "" {
		t.Fatal("STAGE8_G2_MANIFEST must explicitly identify the fresh isolated instance")
	}
	m, err := lab.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	db, err := lab.Open(m)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	if err = db.PingContext(ctx); err != nil {
		db.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestG2GuardRejectsChangedTargetsBeforeOpening(t *testing.T) {
	m, err := lab.Load(os.Getenv("STAGE8_G2_MANIFEST"))
	if err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*lab.Manifest){
		"original-port":   func(m *lab.Manifest) { m.Port = 3306 },
		"old-demo-port":   func(m *lab.Manifest) { m.Port = 13307 },
		"other-host":      func(m *lab.Manifest) { m.Host = "localhost" },
		"other-directory": func(m *lab.Manifest) { m.DataDir += "-other" },
		"other-uuid":      func(m *lab.Manifest) { m.ServerUUID = "00000000-0000-0000-0000-000000000000" },
		"other-process":   func(m *lab.Manifest) { m.OwnerPID++ },
	} {
		t.Run(name, func(t *testing.T) {
			changed := m
			mutate(&changed)
			if db, err := lab.Open(changed); err == nil || db != nil {
				t.Fatal("changed target was accepted before connection establishment")
			}
		})
	}
	if _, err := lab.Load(".env"); err == nil {
		t.Fatal("a non-fixture path was accepted as an experiment manifest")
	}
}
