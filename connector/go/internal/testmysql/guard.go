// Package testmysql is an isolated-test helper; production packages never import it.
package testmysql

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

const Port = 13308

type Manifest struct {
	Format        string `json:"format"`
	RunID         string `json:"runId"`
	Host          string `json:"host"`
	Port          int    `json:"port"`
	DataDir       string `json:"dataDir"`
	ServerUUID    string `json:"serverUuid"`
	PIDFile       string `json:"pidFile"`
	OwnerPID      int    `json:"ownerPid"`
	AdminUser     string `json:"adminUser"`
	AdminPassword string `json:"adminPassword"`
	manifestPath  string
}

func workspaceRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for i := 0; i < 8; i++ {
		if _, err := os.Stat(filepath.Join(dir, "pnpm-workspace.yaml")); err == nil {
			return filepath.Abs(dir)
		}
		next := filepath.Dir(dir)
		if next == dir {
			break
		}
		dir = next
	}
	return "", errors.New("run experiment inside the project workspace")
}

func samePath(a, b string) bool {
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

func Load(path string) (Manifest, error) {
	var m Manifest
	root, err := workspaceRoot()
	if err != nil {
		return m, err
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return m, errors.New("invalid experiment manifest path")
	}
	runDir := filepath.Dir(absolute)
	if !samePath(filepath.Dir(runDir), filepath.Join(root, ".cache")) ||
		!regexp.MustCompile(`^stage8-g2-[0-9a-f]{32}$`).MatchString(filepath.Base(runDir)) ||
		filepath.Base(absolute) != "manifest.json" {
		return m, errors.New("manifest is outside a newly named stage8 experiment directory")
	}
	file, err := os.Open(absolute)
	if err != nil {
		return m, errors.New("experiment manifest unavailable")
	}
	defer file.Close()
	if info, err := file.Stat(); err != nil || info.Size() > 8192 {
		return m, errors.New("experiment manifest size is invalid")
	}
	decoder := json.NewDecoder(io.LimitReader(file, 8192))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&m) != nil {
		return m, errors.New("invalid experiment manifest")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return m, errors.New("invalid trailing manifest content")
	}
	if m.Format != "stackoryn-stage8-g2-v1" || m.RunID != strings.TrimPrefix(filepath.Base(runDir), "stage8-g2-") ||
		m.Host != "127.0.0.1" || m.Port != Port || m.AdminUser != "root" ||
		!regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(m.AdminPassword) || m.OwnerPID <= 0 ||
		!regexp.MustCompile(`^[0-9a-f-]{36}$`).MatchString(m.ServerUUID) ||
		!samePath(m.DataDir, filepath.Join(runDir, "mysql-data")) ||
		!samePath(m.PIDFile, filepath.Join(runDir, "mysql.pid")) {
		return m, errors.New("experiment manifest does not identify the allowed isolated target")
	}
	for _, path := range []string{runDir, m.DataDir} {
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil || !samePath(path, resolved) {
			return m, errors.New("experiment directory must not be a link or junction")
		}
	}
	identity, err := os.ReadFile(filepath.Join(m.DataDir, "auto.cnf"))
	if err != nil || !strings.Contains(strings.ToLower(string(identity)), "server-uuid="+m.ServerUUID) {
		return m, errors.New("data directory identity does not match the manifest")
	}
	m.manifestPath = absolute
	return m, nil
}

type pinnedConnector struct {
	inner driver.Connector
	m     Manifest
}

func (p *pinnedConnector) Driver() driver.Driver { return p.inner.Driver() }

// Every new pooled connection is checked before it can receive fixture SQL.
func (p *pinnedConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := p.inner.Connect(ctx)
	if err != nil {
		var serverError *mysql.MySQLError
		if errors.As(err, &serverError) {
			return nil, fmt.Errorf("isolated connection rejected: %w", serverError)
		}
		return nil, fmt.Errorf("isolated experiment connection unavailable (%T)", err)
	}
	query, ok := conn.(driver.QueryerContext)
	if !ok {
		conn.Close()
		return nil, errors.New("driver cannot verify instance identity")
	}
	rows, err := query.QueryContext(ctx, "SELECT @@port, @@datadir, @@server_uuid, @@pid_file", nil)
	if err != nil {
		conn.Close()
		return nil, errors.New("cannot read isolated experiment identity")
	}
	values := make([]driver.Value, 4)
	readErr := rows.Next(values)
	rows.Close()
	value := func(v driver.Value) string {
		if raw, ok := v.([]byte); ok {
			return string(raw)
		}
		return fmt.Sprint(v)
	}
	pid, pidErr := os.ReadFile(p.m.PIDFile)
	if readErr != nil || len(rows.Columns()) != 4 || value(values[0]) != strconv.Itoa(Port) ||
		!samePath(value(values[1]), p.m.DataDir) || value(values[2]) != p.m.ServerUUID ||
		!samePath(value(values[3]), p.m.PIDFile) || pidErr != nil ||
		strings.TrimSpace(string(pid)) != strconv.Itoa(p.m.OwnerPID) {
		conn.Close()
		return nil, errors.New("isolated experiment identity mismatch; no fixture SQL permitted")
	}
	return conn, nil
}

func Open(m Manifest) (*sql.DB, error) {
	return OpenAccount(m, m.AdminUser, m.AdminPassword, false)
}

// OpenAccount keeps fixture accounts on the same pinned instance on every
// connection, including reconnects, instead of introducing a second DSN path.
func OpenAccount(m Manifest, user, password string, foundRows bool) (*sql.DB, error) {
	return openAccount(m, user, password, foundRows, nil)
}

// OpenAccountWithDial is test-only network fault injection. Instance identity
// is still verified after every handshake, before any fixture or product SQL.
func OpenAccountWithDial(m Manifest, user, password string, dial func(context.Context, string, string) (net.Conn, error)) (*sql.DB, error) {
	if dial == nil {
		return nil, errors.New("explicit test dialer required")
	}
	return openAccount(m, user, password, false, dial)
}

func openAccount(m Manifest, user, password string, foundRows bool, dial func(context.Context, string, string) (net.Conn, error)) (*sql.DB, error) {
	trusted, err := Load(m.manifestPath)
	if err != nil || trusted != m {
		return nil, errors.New("experiment target was not loaded from the current validated manifest")
	}
	cfg := mysql.NewConfig()
	cfg.User, cfg.Passwd, cfg.Net, cfg.Addr = user, password, "tcp", "127.0.0.1:"+strconv.Itoa(Port)
	cfg.Timeout, cfg.ReadTimeout, cfg.WriteTimeout = 3*time.Second, 12*time.Second, 12*time.Second
	cfg.MultiStatements, cfg.InterpolateParams = false, false
	cfg.ClientFoundRows = foundRows
	cfg.DialFunc = dial
	inner, err := mysql.NewConnector(cfg)
	if err != nil {
		return nil, errors.New("invalid experiment connection configuration")
	}
	db := sql.OpenDB(&pinnedConnector{inner: inner, m: m})
	db.SetMaxOpenConns(12)
	db.SetMaxIdleConns(4)
	return db, nil
}
