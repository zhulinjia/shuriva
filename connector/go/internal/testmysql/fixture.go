package testmysql

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"os"
	"testing"
	"time"
)

type Fixture struct {
	Admin    *sql.DB
	Manifest Manifest
	Suffix   string
}

func New(t *testing.T) *Fixture {
	t.Helper()
	m, err := Load(os.Getenv("STAGE8_G3_MANIFEST"))
	if err != nil {
		t.Fatal("explicit fresh G3 manifest required: ", err)
	}
	db, err := Open(m)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err = db.PingContext(ctx); err != nil {
		db.Close()
		t.Fatal(err)
	}
	var token [6]byte
	if _, err = rand.Read(token[:]); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return &Fixture{db, m, hex.EncodeToString(token[:])}
}
func (f *Fixture) Exec(t *testing.T, query string, args ...any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	if _, err := f.Admin.ExecContext(ctx, query, args...); err != nil {
		t.Fatal("isolated fixture failed: ", err)
	}
}
func (f *Fixture) Open(t *testing.T, user, password string) *sql.DB {
	t.Helper()
	db, err := OpenAccount(f.Manifest, user, password, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}
