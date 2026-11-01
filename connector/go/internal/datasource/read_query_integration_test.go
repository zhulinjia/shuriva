//go:build amd64 || arm64

package datasource

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/queryguard"
	"github.com/go-sql-driver/mysql"
)

func TestExecuteReadWithLocalPolicyOnIsolatedMySQL(t *testing.T) {
	if os.Getenv("STAGE3_MYSQL_TEST") != "1" {
		t.Skip("requires isolated test MySQL")
	}
	root, err := sql.Open("mysql", "root:stage3-isolated-fixture-only@tcp(127.0.0.1:13307)/?timeout=3s")
	if err != nil {
		t.Fatal("test database unavailable")
	}
	defer root.Close()
	var port int
	var dir string
	if err = root.QueryRow("SELECT @@port, @@datadir").Scan(&port, &dir); err != nil || port != 13307 || !strings.HasPrefix(strings.ToLower(strings.ReplaceAll(dir, "\\", "/")), "i:/wwwroot/stackoryn-com/.cache/stage3-mysql-data/") {
		t.Fatal("unexpected test database")
	}
	var token [6]byte
	if _, err = rand.Read(token[:]); err != nil {
		t.Fatal(err)
	}
	suffix := hex.EncodeToString(token[:])
	database := "stage4_exec_" + suffix
	username := "s4_" + suffix
	lock := "stage4_view_" + suffix
	if _, err = root.Exec("CREATE DATABASE `" + database + "`"); err != nil {
		t.Fatal("cannot create test database")
	}
	defer func() { _, _ = root.Exec("DROP DATABASE `" + database + "`") }()
	if _, err = root.Exec("CREATE TABLE `" + database + "`.customers (id INT NOT NULL PRIMARY KEY, name VARCHAR(32), secret VARCHAR(32), amount DECIMAL(30,10), payload VARBINARY(8), created_at TIMESTAMP NULL)"); err != nil {
		t.Fatal("cannot create test table")
	}
	if _, err = root.Exec("INSERT INTO `" + database + "`.customers (id,name,secret) VALUES (1,'one','hidden'),(2,'two','hidden'),(3,'three','hidden')"); err != nil {
		t.Fatal("cannot create test data")
	}
	if _, err = root.Exec("UPDATE `" + database + "`.customers SET amount=12345678901234567890.1234567890,payload=X'FF00' WHERE id=2"); err != nil {
		t.Fatal("cannot create typed fixture")
	}
	if _, err = root.Exec("UPDATE `" + database + "`.customers SET amount=12345678901234567890.1234567891 WHERE id=3"); err != nil {
		t.Fatal("cannot create decimal comparison fixture")
	}
	if _, err = root.Exec("CREATE TABLE `" + database + "`.large_rows (id INT NOT NULL PRIMARY KEY, payload MEDIUMTEXT)"); err != nil {
		t.Fatal("cannot create size fixture")
	}
	if _, err = root.Exec("CREATE TABLE `" + database + "`.typed_values (id INT PRIMARY KEY, empty_text VARCHAR(8), empty_bytes VARBINARY(8), null_text VARCHAR(8), big_unsigned BIGINT UNSIGNED, big_signed BIGINT, exact DECIMAL(30,10), flags BIT(8), dt DATETIME(6), ts TIMESTAMP(6), document JSON, truth TINYINT(1), approximate DOUBLE)"); err != nil {
		t.Fatal("cannot create typed values fixture")
	}
	if _, err = root.Exec("CREATE TABLE `" + database + "`.unverified_engine (id INT) ENGINE=MyISAM"); err != nil {
		t.Fatal("cannot create unverified engine fixture")
	}
	if _, err = root.Exec("CREATE TABLE `" + database + "`.special_values (id INT PRIMARY KEY, approx FLOAT, geom POINT, big BIGINT UNSIGNED, optional VARCHAR(16))"); err != nil {
		t.Fatal("cannot create additional type fixture")
	}
	if _, err = root.Exec("INSERT INTO `" + database + "`.special_values VALUES (1, 0.1, ST_GeomFromText('POINT(0 0)'), 18446744073709551615, NULL), (2, 0.2, ST_GeomFromText('POINT(1 1)'), 18446744073709551614, 'present')"); err != nil {
		t.Fatal("cannot create additional type values")
	}
	if _, err = root.Exec("CREATE TABLE `" + database + "`.charset_rows (id INT PRIMARY KEY, payload MEDIUMTEXT CHARACTER SET latin1)"); err != nil {
		t.Fatal("cannot create character set fixture")
	}
	if _, err = root.Exec("INSERT INTO `" + database + "`.charset_rows VALUES (1, REPEAT(CONVERT(0x80 USING latin1), 32768)), (2, REPEAT(CONVERT(0x80 USING latin1), 10000))"); err != nil {
		t.Fatal("cannot create character set values")
	}
	if _, err = root.Exec("CREATE TABLE `" + database + "`.utf8_rows (id INT PRIMARY KEY, payload MEDIUMTEXT CHARACTER SET utf8mb4)"); err != nil {
		t.Fatal("cannot create utf8 fixture")
	}
	if _, err = root.Exec("INSERT INTO `" + database + "`.utf8_rows VALUES (1, REPEAT(CONVERT(0xF09F9880 USING utf8mb4), 8192)), (2, REPEAT(CONVERT(0xF09F9880 USING utf8mb4), 8193))"); err != nil {
		t.Fatal("cannot create utf8 values")
	}
	fixtureConn, err := root.Conn(context.Background())
	if err != nil {
		t.Fatal("cannot open typed fixture session")
	}
	if _, err = fixtureConn.ExecContext(context.Background(), "SET SESSION time_zone='+00:00'"); err != nil {
		fixtureConn.Close()
		t.Fatal("cannot set typed fixture time zone")
	}
	if _, err = fixtureConn.ExecContext(context.Background(), "INSERT INTO `"+database+"`.typed_values VALUES (1, '', X'', NULL, 18446744073709551615, -9223372036854775808, 12345678901234567890.1234567890, b'10101010', '2025-01-02 03:04:05.123456', '2025-01-02 03:04:05.123456', JSON_OBJECT('x',1), 1, 1.25)"); err != nil {
		fixtureConn.Close()
		t.Fatal("cannot create typed values")
	}
	fixtureConn.Close()
	for i := 1; i <= 40; i++ {
		if _, err = root.Exec("INSERT INTO `"+database+"`.large_rows VALUES (?, ?)", i, strings.Repeat("x", 32000)); err != nil {
			t.Fatal("cannot create size data")
		}
	}
	if _, err = root.Exec("INSERT INTO `"+database+"`.large_rows VALUES (41, ?)", strings.Repeat("z", maxQueryCellBytes+1)); err != nil {
		t.Fatal("cannot create cell limit fixture")
	}
	if _, err = root.Exec("INSERT INTO `" + database + "`.large_rows VALUES (42, REPEAT('z', 8388608))"); err != nil {
		t.Fatal("cannot create large-cell wire fixture")
	}
	if _, err = root.Exec("CREATE ALGORITHM=TEMPTABLE VIEW `" + database + "`.v_bad AS SELECT d.id FROM (SELECT GET_LOCK('" + lock + "',0) AS id) AS d"); err != nil {
		t.Fatal("cannot create test view")
	}
	if _, err = root.Exec("CREATE USER '" + username + "'@'localhost' IDENTIFIED BY 'stage4-fixture-only'"); err != nil {
		t.Fatal("cannot create test account")
	}
	defer func() { _, _ = root.Exec("DROP USER '" + username + "'@'localhost'") }()
	grant := strings.ReplaceAll(database, "_", `\_`)
	if _, err = root.Exec("GRANT SELECT, SHOW VIEW ON `" + grant + "`.* TO '" + username + "'@'localhost'"); err != nil {
		t.Fatal("cannot grant test account")
	}
	p := fixtureProfile()
	p.Database = database
	p.Username = username
	p.Password = "stage4-fixture-only"
	workspace := p.WorkspaceIDs[0]
	p.ReadScopes = map[string]map[string][]string{workspace: {"customers": {"id", "name", "amount", "payload", "created_at"}, "large_rows": {"id", "payload"}, "charset_rows": {"id", "payload"}, "utf8_rows": {"id", "payload"}, "v_bad": {"id"}, "unverified_engine": {"id"}, "typed_values": {"id", "empty_text", "empty_bytes", "null_text", "big_unsigned", "big_signed", "exact", "flags", "dt", "ts", "document", "truth", "approximate"}}}
	p.ReadScopes[workspace]["special_values"] = []string{"id", "approx", "geom", "big", "optional"}
	inspect, err := open(p)
	if err != nil {
		t.Fatal(err)
	}
	var serverVersion, serverMode string
	var lower int
	if err = inspect.QueryRow("SELECT VERSION(), @@sql_mode, @@lower_case_table_names").Scan(&serverVersion, &serverMode, &lower); err != nil {
		inspect.Close()
		t.Fatal(err)
	}
	inspect.Close()
	if !supportedQueryServer(serverVersion, serverMode, lower) {
		t.Fatalf("unverified isolated server configuration: version=%s mode=%s casing=%d", serverVersion, serverMode, lower)
	}
	// The model is shown a filtered schema; the execution binding covers the
	// complete table definition, including changes to unselected columns.
	modelProfile := p
	modelProfile.ReadScopes = map[string]map[string][]string{workspace: {"customers": {"id", "name"}}}
	modelSchema, err := CaptureModelSchema(context.Background(), modelProfile, p.ConnectorID, workspace)
	if err != nil || len(modelSchema.Tables) != 1 || len(modelSchema.Tables[0].Version) != 64 {
		t.Fatalf("cannot capture authorized schema: %v", err)
	}
	version := modelSchema.Tables[0].Version
	if _, err = ExecuteReadVersioned(context.Background(), modelProfile, p.ConnectorID, workspace, "SELECT id, name FROM customers", nil, 10, version); err != nil {
		t.Fatalf("unchanged schema rejected: %v", err)
	}
	reconfigured := modelProfile
	reconfigured.Revision, err = NewID()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = ExecuteReadVersioned(context.Background(), reconfigured, p.ConnectorID, workspace, "SELECT id, name FROM customers", nil, 10, version); !errors.Is(err, ErrSchemaChanged) {
		t.Fatalf("changed source configuration accepted an old plan: %v", err)
	}
	if _, err = root.Exec("ALTER TABLE `" + database + "`.customers MODIFY name TEXT"); err != nil {
		t.Fatal("cannot change synthetic table")
	}
	if _, err = ExecuteReadVersioned(context.Background(), modelProfile, p.ConnectorID, workspace, "SELECT id, name FROM customers", nil, 10, version); !errors.Is(err, ErrSchemaChanged) {
		t.Fatalf("changed table definition accepted: %v", err)
	}
	if _, err = root.Exec("ALTER TABLE `" + database + "`.customers MODIFY name VARCHAR(32)"); err != nil {
		t.Fatal("cannot restore synthetic table")
	}
	result, err := ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "SELECT id, name FROM customers WHERE id >= ? ORDER BY id", []QueryParameter{{Kind: "integer", Value: "2"}}, 1)
	if err != nil {
		t.Fatalf("authorized query failed: %v", err)
	}
	if !result.Truncated || result.Reason != "rows" || result.Timezone != "UTC" || len(result.Rows) != 1 || result.Rows[0][0].Value != "2" || result.Rows[0][1].Value != "two" {
		t.Fatalf("unexpected query result: %+v", result)
	}
	typed, err := ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "SELECT amount, payload, created_at FROM customers WHERE id = ?", []QueryParameter{{Kind: "integer", Value: "2"}}, 10)
	if err != nil || len(typed.Rows) != 1 || typed.Rows[0][0].Value != "12345678901234567890.1234567890" || typed.Rows[0][1].Encoding != "base64" || typed.Rows[0][1].Value != "/wA=" || !typed.Rows[0][2].Null {
		t.Fatal("typed result lost precision or encoding")
	}
	values, err := ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "SELECT empty_text, empty_bytes, null_text, big_unsigned, big_signed, exact, flags, dt, ts, document, truth, approximate FROM typed_values", nil, 10)
	if err != nil || len(values.Rows) != 1 {
		t.Fatalf("typed values query failed: %v", err)
	}
	metadataDB, err := open(p)
	if err != nil {
		t.Fatal("cannot inspect source types")
	}
	metadataRows, err := metadataDB.Query("SELECT empty_text, empty_bytes, null_text, big_unsigned, big_signed, exact, flags, dt, ts, document, truth, approximate FROM `" + database + "`.typed_values LIMIT 0")
	if err != nil {
		metadataDB.Close()
		t.Fatal("cannot inspect source types")
	}
	originalTypes, err := metadataRows.ColumnTypes()
	if err != nil {
		metadataRows.Close()
		metadataDB.Close()
		t.Fatal("cannot inspect source types")
	}
	for i, column := range values.Columns {
		if column.Type != originalTypes[i].DatabaseTypeName() {
			metadataRows.Close()
			metadataDB.Close()
			t.Fatalf("database type changed for %s: %s versus %s", column.Name, column.Type, originalTypes[i].DatabaseTypeName())
		}
	}
	metadataRows.Close()
	metadataDB.Close()
	row := values.Rows[0]
	if row[0].Null || row[0].Encoding != "text" || row[0].Value != "" || row[1].Null || row[1].Encoding != "base64" || row[1].Value != "" || !row[2].Null || row[3].Value != "18446744073709551615" || row[4].Value != "-9223372036854775808" || row[5].Value != "12345678901234567890.1234567890" || row[6].Encoding != "base64" || row[6].Value != "qg==" || row[7].Value != "2025-01-02 03:04:05.123456" || row[8].Value != "2025-01-02 03:04:05.123456" || row[9].Value != "{\"x\": 1}" || row[10].Value != "1" || row[11].Value != "1.25" {
		t.Fatalf("typed values changed through bound projection: %#v", row)
	}
	decimal, err := ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "SELECT id FROM customers WHERE amount = ?", []QueryParameter{{Kind: "decimal", Value: "12345678901234567890.1234567890"}}, 10)
	if err != nil || len(decimal.Rows) != 1 || decimal.Rows[0][0].Value != "2" {
		t.Fatalf("decimal parameter comparison is inaccurate: %v, rows=%d", err, len(decimal.Rows))
	}
	special, err := ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "SELECT approx, geom FROM special_values WHERE big = ?", []QueryParameter{{Kind: "integer", Value: "18446744073709551615"}}, 10)
	if err != nil || len(special.Rows) != 1 || special.Rows[0][0].Value != "0.1" || special.Columns[1].Type != "GEOMETRY" || special.Rows[0][1].Encoding != "base64" || special.Rows[0][1].Value != "AAAAAAEBAAAAAAAAAAAAAAAAAAAAAAAAAA==" {
		t.Fatalf("float, geometry or unsigned value failed: %+v %v", special, err)
	}
	for _, query := range []string{"SELECT id FROM special_values WHERE optional IS NULL", "SELECT id FROM special_values WHERE optional <=> ?"} {
		var params []QueryParameter
		if strings.Contains(query, "?") {
			params = []QueryParameter{{Kind: "null", Value: ""}}
		}
		got, e := ExecuteRead(context.Background(), p, p.ConnectorID, workspace, query, params, 10)
		if e != nil || len(got.Rows) != 1 || got.Rows[0][0].Value != "1" {
			t.Fatalf("null query failed %s: %+v %v", query, got, e)
		}
	}
	nonNull, err := ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "SELECT id FROM special_values WHERE optional IS NOT NULL", nil, 10)
	if err != nil || len(nonNull.Rows) != 1 || nonNull.Rows[0][0].Value != "2" {
		t.Fatalf("non-null query failed: %+v %v", nonNull, err)
	}
	combined, err := ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "SELECT id FROM special_values WHERE optional IS NULL AND big <=> ?", []QueryParameter{{Kind: "integer", Value: "18446744073709551615"}}, 10)
	if err != nil || len(combined.Rows) != 1 || combined.Rows[0][0].Value != "1" {
		t.Fatal("combined null and unsigned comparison failed")
	}
	for _, item := range []struct {
		query  string
		params []QueryParameter
	}{
		{"SELECT id FROM special_values WHERE optional <=> ? AND big = ?", []QueryParameter{{Kind: "null", Value: ""}, {Kind: "integer", Value: "18446744073709551615"}}},
		{"SELECT id FROM special_values WHERE big = ? AND optional <=> ?", []QueryParameter{{Kind: "integer", Value: "18446744073709551615"}, {Kind: "null", Value: ""}}},
	} {
		got, e := ExecuteRead(context.Background(), p, p.ConnectorID, workspace, item.query, item.params, 10)
		if e != nil || len(got.Rows) != 1 || got.Rows[0][0].Value != "1" {
			t.Fatal("mixed parameter order or null-safe binding failed")
		}
	}
	if _, err = ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "SELECT id FROM special_values WHERE optional = ?", []QueryParameter{{Kind: "null", Value: ""}}, 10); !errors.Is(err, ErrQuery) {
		t.Fatal("unsafe null parameter comparison did not fail")
	}
	if _, err := ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "SELECT id FROM special_values WHERE absent IS NULL", nil, 10); !errors.Is(err, queryguard.ErrDenied) {
		t.Fatal("unauthorized null predicate accepted")
	}
	large, err := ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "SELECT payload FROM large_rows WHERE id <= ? ORDER BY id", []QueryParameter{{Kind: "integer", Value: "40"}}, 100)
	encoded, _ := json.Marshal(large)
	if err != nil || !large.Truncated || large.Reason != "bytes" || len(encoded) > maxQueryBytes {
		t.Fatal("result byte limit not enforced")
	}
	cell, err := ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "SELECT payload FROM large_rows WHERE id = ?", []QueryParameter{{Kind: "integer", Value: "41"}}, 10)
	if err != nil || !cell.Truncated || cell.Reason != "cell" || len(cell.Rows) != 0 {
		t.Fatal("cell limit not enforced")
	}
	// A proxy counts server-to-client bytes. Checking the final JSON alone is
	// insufficient because the SQL driver buffers entire incoming rows first.
	measure := func(query string, id string) QueryResult {
		listener, e := net.Listen("tcp", "127.0.0.1:0")
		if e != nil {
			t.Fatal("cannot start isolated counting proxy")
		}
		defer listener.Close()
		wire := make(chan int64, 1)
		go func() {
			local, e := listener.Accept()
			if e != nil {
				wire <- -1
				return
			}
			defer local.Close()
			remote, e := net.DialTimeout("tcp", "127.0.0.1:13307", 3*time.Second)
			if e != nil {
				wire <- -1
				return
			}
			defer remote.Close()
			go func() { _, _ = io.Copy(remote, local); _ = remote.Close() }()
			n, _ := io.Copy(local, remote)
			wire <- n
		}()
		proxyProfile := p
		proxyProfile.Port = listener.Addr().(*net.TCPAddr).Port
		result, e := ExecuteRead(context.Background(), proxyProfile, p.ConnectorID, workspace, query, []QueryParameter{{Kind: "integer", Value: id}}, 10)
		if e != nil {
			t.Fatalf("counted query failed: %v", e)
		}
		select {
		case n := <-wire:
			if n < 0 || n > 16*1024 {
				t.Fatalf("oversized field crossed the wire: %d bytes", n)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("counting proxy did not close")
		}
		return result
	}
	boundedCell := measure("SELECT payload FROM large_rows WHERE id = ?", "42")
	if !boundedCell.Truncated || boundedCell.Reason != "cell" || len(boundedCell.Rows) != 0 {
		t.Fatal("oversized field was not truncated")
	}
	convertedCell := measure("SELECT payload FROM charset_rows WHERE id = ?", "1")
	if !convertedCell.Truncated || convertedCell.Reason != "cell" || len(convertedCell.Rows) != 0 {
		t.Fatal("expanded character set field was not truncated")
	}
	convertedWithinLimit, err := ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "SELECT payload FROM charset_rows WHERE id = ?", []QueryParameter{{Kind: "integer", Value: "2"}}, 10)
	if err != nil || convertedWithinLimit.Truncated || len(convertedWithinLimit.Rows) != 1 || len(convertedWithinLimit.Rows[0][0].Value) != 30000 || convertedWithinLimit.Rows[0][0].Encoding != "text" {
		t.Fatal("valid character set conversion was not preserved")
	}
	utf8Boundary, err := ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "SELECT id, payload FROM utf8_rows WHERE id = ?", []QueryParameter{{Kind: "integer", Value: "1"}}, 10)
	if err != nil || utf8Boundary.Truncated || len(utf8Boundary.Rows) != 1 || len(utf8Boundary.Rows[0][1].Value) != maxQueryCellBytes {
		t.Fatal("exact utf8 byte limit was not preserved")
	}
	utf8Exceeded, err := ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "SELECT id, payload FROM utf8_rows WHERE id = ?", []QueryParameter{{Kind: "integer", Value: "2"}}, 10)
	if err != nil || !utf8Exceeded.Truncated || utf8Exceeded.Reason != "cell" || len(utf8Exceeded.Rows) != 0 {
		t.Fatal("oversized utf8 field or partial row was published")
	}
	if _, err = ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "SELECT secret FROM customers", nil, 10); !errors.Is(err, queryguard.ErrDenied) {
		t.Fatalf("unauthorized field accepted: %v", err)
	}
	if _, err = ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "SELECT id FROM unverified_engine", nil, 10); !errors.Is(err, ErrScope) {
		t.Fatalf("unverified storage engine accepted: %v", err)
	}
	if _, err = ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "SELECT id FROM v_bad", nil, 10); !errors.Is(err, ErrScope) {
		t.Fatalf("view was not denied: %v", err)
	}
	var free int
	if err = root.QueryRow("SELECT IS_FREE_LOCK(?)", lock).Scan(&free); err != nil || free != 1 {
		t.Fatal("metadata lookup evaluated view expression")
	}
	if _, err = ExecuteRead(context.Background(), p, p.ConnectorID, "44444444-4444-4444-8444-444444444444", "SELECT id FROM customers", nil, 10); !errors.Is(err, ErrScope) {
		t.Fatal("different workspace accepted")
	}
	if _, err = ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "SELECT id FROM customers WHERE id = ?", nil, 10); !errors.Is(err, ErrQuery) {
		t.Fatal("parameter mismatch accepted")
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = ExecuteRead(cancelled, p, p.ConnectorID, workspace, "SELECT id FROM customers", nil, 10); !errors.Is(err, ErrQueryCancelled) {
		t.Fatalf("cancellation not reported: %v", err)
	}
	reader, err := open(p)
	if err != nil {
		t.Fatal("cannot open test reader")
	}
	defer reader.Close()
	writer, err := root.Conn(context.Background())
	if err != nil {
		t.Fatal("cannot open test writer")
	}
	defer writer.Close()
	if _, err = writer.ExecContext(context.Background(), "SET SESSION lock_wait_timeout=1"); err != nil {
		t.Fatal("cannot set isolated lock timeout")
	}
	if _, err = writer.ExecContext(context.Background(), "LOCK TABLES `"+database+"`.customers WRITE"); err != nil {
		t.Fatal("cannot create isolated lock fixture")
	}
	queryCtx, stop := context.WithTimeout(context.Background(), 250*time.Millisecond)
	_, queryErr := ExecuteRead(queryCtx, p, p.ConnectorID, workspace, "SELECT id FROM customers", nil, 10)
	stop()
	if _, err = writer.ExecContext(context.Background(), "UNLOCK TABLES"); err != nil {
		t.Fatal("cannot release isolated lock fixture")
	}
	if !errors.Is(queryErr, ErrQueryTimeout) {
		t.Fatalf("blocked query cancellation not reported: %v", queryErr)
	}
	if _, err = ExecuteRead(context.Background(), p, p.ConnectorID, workspace, "SELECT id FROM customers", nil, 10); err != nil {
		t.Fatalf("query did not recover after cancellation: %v", err)
	}
	for _, item := range []struct{ table, ddl string }{
		{"customers", "ALTER TABLE `" + database + "`.customers ADD COLUMN fixture_extra INT"},
		{"v_bad", "DROP VIEW `" + database + "`.v_bad"},
	} {
		tx, err := reader.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
		if err != nil {
			t.Fatal("cannot begin isolated transaction")
		}
		rows, err := tx.Query("SHOW COLUMNS FROM `" + database + "`.`" + item.table + "`")
		if err != nil {
			tx.Rollback()
			t.Fatal("cannot read isolated metadata")
		}
		rows.Close()
		_, err = writer.ExecContext(context.Background(), item.ddl)
		var mysqlErr *mysql.MySQLError
		if !errors.As(err, &mysqlErr) || mysqlErr.Number != 1205 {
			tx.Rollback()
			t.Fatalf("metadata lock did not block DDL: %v", err)
		}
		if err = tx.Rollback(); err != nil {
			t.Fatal("cannot release isolated metadata lock")
		}
		if _, err = writer.ExecContext(context.Background(), item.ddl); err != nil {
			t.Fatal("DDL did not resume after rollback")
		}
	}
}

func TestQueryParameterPrecisionAndCellLimits(t *testing.T) {
	args, err := queryArguments([]QueryParameter{{Kind: "integer", Value: "9223372036854775807"}, {Kind: "decimal", Value: "123456789.123456789"}, {Kind: "null"}})
	if err != nil || args[0] != int64(9223372036854775807) || args[1] != "123456789.123456789" || args[2] != nil {
		t.Fatal("parameter precision lost")
	}
	unsigned, err := queryArguments([]QueryParameter{{Kind: "integer", Value: "18446744073709551615"}})
	if err != nil || unsigned[0] != uint64(18446744073709551615) {
		t.Fatal("maximum unsigned integer rejected")
	}
	for _, p := range []QueryParameter{{Kind: "integer", Value: "18446744073709551616"}, {Kind: "integer", Value: "-9223372036854775809"}, {Kind: "decimal", Value: "1.2.3"}, {Kind: "null", Value: "unexpected"}, {Kind: "other", Value: "x"}} {
		if _, err := queryArguments([]QueryParameter{p}); err == nil {
			t.Fatalf("invalid parameter accepted: %+v", p)
		}
	}
	if _, err := encodeCell([]byte(strings.Repeat("x", maxQueryCellBytes+1)), "VARCHAR"); !errors.Is(err, queryguard.ErrDenied) {
		t.Fatal("oversized cell accepted")
	}
}

func TestOnlyVerifiedServerModeIsAccepted(t *testing.T) {
	mode := "ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION"
	if !supportedQueryServer("26.7.0", mode, 1) {
		t.Fatal("verified server rejected")
	}
	if supportedQueryServer("8.0.0", mode, 1) || supportedQueryServer("26.7.0", mode+",IGNORE_SPACE", 1) || supportedQueryServer("26.7.0", mode+",ANSI_QUOTES", 1) || supportedQueryServer("26.7.0", mode, 0) {
		t.Fatal("unverified environment accepted")
	}
}
