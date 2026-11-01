//go:build amd64 || arm64

package queryguard

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"
)

// This integration test uses only the dedicated stage-3 test instance and
// dynamically named synthetic databases/accounts created by this test.
func TestCompiledQueryOnIsolatedMySQL(t *testing.T) {
	if os.Getenv("STAGE3_MYSQL_TEST") != "1" {
		t.Skip("requires dedicated isolated MySQL on 127.0.0.1:13307")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	root, err := sql.Open("mysql", "root:stage3-isolated-fixture-only@tcp(127.0.0.1:13307)/?timeout=3s")
	if err != nil {
		t.Fatal("test database unavailable")
	}
	defer root.Close()
	var port int
	var dir string
	if err = root.QueryRowContext(ctx, "SELECT @@port, @@datadir").Scan(&port, &dir); err != nil || port != 13307 || !strings.HasPrefix(strings.ToLower(strings.ReplaceAll(dir, "\\", "/")), "i:/wwwroot/stackoryn-com/.cache/stage3-mysql-data/") {
		t.Fatal("unexpected test database instance")
	}
	var random [6]byte
	if _, err = rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	suffix := hex.EncodeToString(random[:])
	database, username := "stage4_guard_"+suffix, "stage4_"+suffix
	if _, err = root.ExecContext(ctx, "CREATE DATABASE `"+database+"`"); err != nil {
		t.Fatal("cannot create isolated fixture")
	}
	defer func() { _, _ = root.ExecContext(context.Background(), "DROP DATABASE `"+database+"`") }()
	if _, err = root.ExecContext(ctx, "CREATE TABLE `"+database+"`.`customers` (`id` INT NOT NULL PRIMARY KEY, `name` VARCHAR(64) NOT NULL)"); err != nil {
		t.Fatal("cannot create isolated fixture")
	}
	if _, err = root.ExecContext(ctx, "INSERT INTO `"+database+"`.`customers` VALUES (1,'one'),(2,'two'),(3,'three')"); err != nil {
		t.Fatal("cannot create isolated fixture")
	}
	if _, err = root.ExecContext(ctx, "CREATE USER '"+username+"'@'localhost' IDENTIFIED BY 'stage4-fixture-only'"); err != nil {
		t.Fatal("cannot create isolated account")
	}
	defer func() { _, _ = root.ExecContext(context.Background(), "DROP USER '"+username+"'@'localhost'") }()
	grant := strings.ReplaceAll(database, "_", `\_`)
	if _, err = root.ExecContext(ctx, "GRANT SELECT ON `"+grant+"`.* TO '"+username+"'@'localhost'"); err != nil {
		t.Fatal("cannot grant isolated account")
	}
	cfg := mysql.NewConfig()
	cfg.User, cfg.Passwd, cfg.Net, cfg.Addr, cfg.DBName = username, "stage4-fixture-only", "tcp", "127.0.0.1:13307", database
	cfg.Timeout = 3 * time.Second
	db, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		t.Fatal("cannot open isolated fixture")
	}
	defer db.Close()
	var mode string
	if err = db.QueryRowContext(ctx, "SELECT @@sql_mode").Scan(&mode); err != nil {
		t.Fatal("cannot inspect test SQL mode")
	}
	policy := Policy{Database: database, Tables: map[string][]string{"customers": {"id", "name"}}}
	plan, err := Validate("SELECT id, name FROM customers WHERE id >= ? ORDER BY id", mode, policy, 1)
	if err != nil {
		t.Fatalf("query was rejected: %v", err)
	}
	rows, err := db.QueryContext(ctx, plan.SQL, 2)
	if err != nil {
		t.Fatal("generated query failed against isolated MySQL")
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var id int
		var name string
		var idTooLong, nameTooLong int
		if err := rows.Scan(&id, &name, &idTooLong, &nameTooLong); err != nil || idTooLong != 0 || nameTooLong != 0 {
			t.Fatal("invalid fixture result")
		}
		got = append(got, fmt.Sprintf("%d:%s", id, name))
	}
	if err := rows.Err(); err != nil || strings.Join(got, ",") != "2:two,3:three" {
		t.Fatalf("unexpected generated query result: %v %v", got, err)
	}
}

// The sleep and named lock here are synthetic driver fixtures, not permitted
// user SQL. A closed connection must release the lock after cancellation.
func TestMySQLCancellationClosesIsolatedConnection(t *testing.T) {
	if os.Getenv("STAGE3_MYSQL_TEST") != "1" {
		t.Skip("requires dedicated isolated MySQL")
	}
	root, err := sql.Open("mysql", "root:stage3-isolated-fixture-only@tcp(127.0.0.1:13307)/?timeout=3s")
	if err != nil {
		t.Fatal("test database unavailable")
	}
	defer root.Close()
	var port int
	var dir string
	if err = root.QueryRow("SELECT @@port, @@datadir").Scan(&port, &dir); err != nil || port != 13307 || !strings.HasPrefix(strings.ToLower(strings.ReplaceAll(dir, "\\", "/")), "i:/wwwroot/stackoryn-com/.cache/stage3-mysql-data/") {
		t.Fatal("unexpected test database instance")
	}
	var random [6]byte
	if _, err = rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	lock := "stage4_cancel_" + hex.EncodeToString(random[:])
	cfg := mysql.NewConfig()
	cfg.User, cfg.Passwd, cfg.Net, cfg.Addr, cfg.DBName = "stage3_reader_fix", "stage3-reader-fixture-only", "tcp", "127.0.0.1:13307", "stage3_source"
	cfg.Timeout = 3 * time.Second
	db, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		t.Fatal("test account unavailable")
	}
	defer db.Close()
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal("test connection unavailable")
	}
	defer conn.Close()
	var acquired int
	if err = conn.QueryRowContext(context.Background(), "SELECT GET_LOCK(?, 0)", lock).Scan(&acquired); err != nil || acquired != 1 {
		t.Fatal("cannot acquire synthetic lock")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	var ignored int
	err = conn.QueryRowContext(ctx, "SELECT SLEEP(20)").Scan(&ignored)
	if err == nil {
		t.Fatal("long-running query was not cancelled")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		var free int
		if err = root.QueryRow("SELECT IS_FREE_LOCK(?)", lock).Scan(&free); err != nil {
			t.Fatal("cannot inspect synthetic lock")
		}
		if free == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("cancelled connection retained its synthetic lock")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
