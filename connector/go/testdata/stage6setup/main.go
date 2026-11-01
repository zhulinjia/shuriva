// stage6setup initializes only the isolated, synthetic stage-six demonstration.
// Credentials arrive on stdin and are written solely to the operating-system vault.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"example.com/ai-database-workspace/connector/internal/agent"
	"example.com/ai-database-workspace/connector/internal/datasource"
)

type input struct {
	Server     string `json:"server"`
	Code       string `json:"code"`
	ConfigPath string `json:"configPath"`
	Workspace  string `json:"workspace"`
	Source     string `json:"source"`
	Database   string `json:"database"`
	Username   string `json:"username"`
	Password   string `json:"password"`
}

func main() {
	if err := run(); err != nil {
		// Do not include supplied values or provider errors in ordinary logs.
		fmt.Fprintln(os.Stderr, "isolated demonstration setup failed:", err)
		os.Exit(1)
	}
}

func run() error {
	var in input
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 16*1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&in) != nil {
		return errors.New("invalid setup input")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return errors.New("unexpected setup input")
	}
	if !regexp.MustCompile(`^stage6s_[a-f0-9]{12}$`).MatchString(in.Database) || !datasource.ValidID(in.Workspace) || !datasource.ValidID(in.Source) {
		return errors.New("invalid isolated demonstration scope")
	}
	server, err := url.Parse(in.Server)
	if err != nil || server.Scheme != "http" || (server.Hostname() != "127.0.0.1" && server.Hostname() != "localhost") || server.User != nil || server.RawQuery != "" || server.Fragment != "" || (server.Path != "" && server.Path != "/") {
		return errors.New("setup requires a loopback platform")
	}
	path, err := filepath.Abs(in.ConfigPath)
	if err != nil {
		return errors.New("invalid demonstration config path")
	}
	const root = `I:\wwwroot\stackoryn-com\.cache\stage6-live-demo`
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == "." || filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.Ext(path) != ".json" {
		return errors.New("config must stay within the dedicated demonstration directory")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		return errors.New("demonstration config already exists or cannot be inspected")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	identity := agent.SystemVault{}
	if err := agent.PairNew(ctx, path, in.Server, "第六阶段演示连接器", in.Code, "stage6-demo", identity); err != nil {
		return errors.New("connector pairing did not complete")
	}
	cfg, err := agent.ReadConfig(path)
	if err != nil {
		return errors.New("cannot read newly paired connector")
	}
	profile := datasource.Profile{
		ID: in.Source, ConnectorID: cfg.ConnectorID,
		WorkspaceIDs: []string{in.Workspace}, Host: "127.0.0.1", Port: 13307,
		Database: in.Database, Username: in.Username, Password: in.Password, TLS: "local",
	}
	snapshot, err := datasource.Scan(ctx, profile, cfg.ConnectorID, in.Workspace)
	if err != nil {
		return errors.New("isolated source scan failed")
	}
	if err := profile.GrantReadScope(in.Workspace, "customers", []string{"id", "name", "city", "balance"}, snapshot); err != nil {
		return errors.New("isolated source authorization failed")
	}
	if err := (datasource.SystemVault{}).Set(profile); err != nil {
		return errors.New("isolated source credential storage failed")
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]string{"connectorId": cfg.ConnectorID, "sourceId": in.Source})
}
