// This subprocess is only a cross-language isolated test fixture. It requires
// the explicit fresh manifest and never reads a user database URL or keyring.
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"example.com/ai-database-workspace/connector/internal/agent"
	"example.com/ai-database-workspace/connector/internal/mutationguard"
	"example.com/ai-database-workspace/connector/internal/mutationmysql"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	"example.com/ai-database-workspace/connector/internal/mutationstore"
	"example.com/ai-database-workspace/connector/internal/protocol"
	"example.com/ai-database-workspace/connector/internal/testmysql"
)

type identityVault map[string]agent.KeyState

func (v identityVault) Get(id string) (agent.KeyState, error) {
	value, ok := v[id]
	if !ok {
		return value, errors.New("missing fixture identity")
	}
	return value, nil
}
func (v identityVault) Set(id string, value agent.KeyState) error { v[id] = value; return nil }
func (v identityVault) Delete(id string) error                    { delete(v, id); return nil }

type profiles map[string]mutationstore.Profile

func (p profiles) Get(id string) (mutationstore.Profile, error) {
	value, ok := p[id]
	if !ok {
		return value, errors.New("missing fixture source")
	}
	return value, nil
}
func token(size int) string {
	raw := make([]byte, size)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return hex.EncodeToString(raw)
}
func ident(name string) string               { return "`" + strings.ReplaceAll(name, "`", "``") + "`" }
func account(a mutationmysql.Account) string { return "'" + a.User + "'@'" + a.Host + "'" }
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "isolated mutation probe failed:", err)
		os.Exit(1)
	}
}
func run() error {
	if os.Getenv("STAGE8_G3_TEST") != "1" {
		return errors.New("explicit isolated test required")
	}
	manifest, err := testmysql.Load(os.Getenv("STAGE8_G3_MANIFEST"))
	if err != nil {
		return err
	}
	admin, err := testmysql.Open(manifest)
	if err != nil {
		return err
	}
	defer admin.Close()
	lifetime := 75 * time.Second
	if os.Getenv("STAGE8_G3_REVIEW") == "1" {
		lifetime = 16 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), lifetime)
	defer cancel()
	if admin.PingContext(ctx) != nil {
		return errors.New("isolated target unavailable")
	}
	decoder := json.NewDecoder(os.Stdin)
	var input struct {
		Server      string `json:"server"`
		Code        string `json:"code"`
		OwnerID     string `json:"ownerId"`
		WorkspaceID string `json:"workspaceId"`
		SourceID    string `json:"sourceId"`
	}
	if decoder.Decode(&input) != nil {
		return errors.New("invalid isolated probe input")
	}
	runRoot := filepath.Dir(os.Getenv("STAGE8_G3_MANIFEST"))
	directory, err := os.MkdirTemp(runRoot, "g3-wire-")
	if err != nil {
		return err
	}
	resolved, err := filepath.Abs(directory)
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(runRoot, resolved)
	if err != nil || relative == "." || strings.HasPrefix(relative, "..") {
		return errors.New("invalid owned probe directory")
	}
	defer os.RemoveAll(resolved)
	identity := identityVault{}
	configFile := filepath.Join(directory, "identity.json")
	if err = agent.PairNew(ctx, configFile, input.Server, "隔离写入协议测试", input.Code, "g3-wire", identity); err != nil {
		return err
	}
	config, err := agent.ReadConfig(configFile)
	if err != nil {
		return err
	}
	privateRaw, err := protocol.Decode(identity[config.ConnectorID].Active, ed25519.PrivateKeySize)
	if err != nil {
		return err
	}
	private := ed25519.PrivateKey(privateRaw)
	suffix := token(6)
	catalog := "stage8_g2_" + suffix
	writer := mutationmysql.Account{User: "s8g2_" + suffix + "_writer", Host: "127.0.0.1"}
	recovery := mutationmysql.Account{User: "s8g2_" + suffix + "_recover", Host: "127.0.0.1"}
	incarnation, _ := mutationmysql.NewEpoch()
	generation, _ := mutationmysql.NewEpoch()
	plan, err := mutationmysql.BuildInstallation(mutationmysql.InstallSpec{Catalog: catalog, Tables: []string{"orders"}, Writer: writer, Recovery: recovery, Incarnation: incarnation, Generation: generation})
	if err != nil {
		return err
	}
	// The guarded connector verifies the new UUID/datadir/PID on every pooled
	// reconnect, including cleanup. These names are exclusively generated here.
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 8*time.Second)
		defer stop()
		for _, name := range []string{plan.ControlCatalog, catalog} {
			_, _ = admin.ExecContext(cleanup, "DROP DATABASE IF EXISTS "+ident(name))
		}
		for _, user := range []mutationmysql.Account{writer, recovery, plan.Definer} {
			_, _ = admin.ExecContext(cleanup, "DROP USER IF EXISTS "+account(user))
		}
	}()
	exec := func(query string, args ...any) error { _, err := admin.ExecContext(ctx, query, args...); return err }
	if exec("CREATE DATABASE "+ident(catalog)+" CHARACTER SET utf8mb4 COLLATE utf8mb4_bin") != nil {
		return errors.New("fixture database unavailable")
	}
	if exec("CREATE TABLE "+ident(catalog)+".orders(id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,label VARCHAR(64) NOT NULL,amount DECIMAL(12,2) NOT NULL DEFAULT 0,tenant VARCHAR(20) NOT NULL DEFAULT 'east') ENGINE=InnoDB") != nil {
		return errors.New("fixture table unavailable")
	}
	if exec("INSERT INTO "+ident(catalog)+".orders(label,amount) VALUES ('first',12.30)") != nil {
		return errors.New("fixture rows unavailable")
	}
	secret := token(32)
	for _, user := range []mutationmysql.Account{writer, recovery} {
		if exec("CREATE USER "+account(user)+" IDENTIFIED BY '"+secret+"'") != nil {
			return errors.New("fixture account unavailable")
		}
	}
	for _, statement := range plan.Statements {
		if exec(statement) != nil {
			return errors.New("reviewed fixture installation failed")
		}
	}
	installation, err := mutationmysql.CaptureInstallation(ctx, admin, plan)
	if err != nil {
		return err
	}
	macKey, _ := mutationstore.NewKey()
	journalKey, _ := mutationstore.NewKey()
	profile := mutationstore.Profile{SourceID: input.SourceID, ConnectorID: config.ConnectorID, WorkspaceIDs: []string{input.WorkspaceID}, Writer: mutationstore.Credential{Host: "127.0.0.1", Port: 13308, Database: catalog, Username: writer.User, Password: secret, TLS: "local"}, Recovery: mutationstore.Credential{Host: "127.0.0.1", Port: 13308, Database: catalog, Username: recovery.User, Password: secret, TLS: "local"}, ManifestPath: filepath.Join(directory, "bundle.json"), ManifestMACKey: macKey, JournalKey: journalKey}
	policy := mutationguard.Policy{Database: catalog, Table: "orders", InsertColumns: []string{"id", "label", "amount", "tenant"}, UpdateColumns: []string{"label", "amount"}, PreviewColumns: []string{"id", "label", "amount", "tenant"}, Delete: true, RowPredicates: []mutationguard.Predicate{{Column: "tenant", Operator: "eq", Value: &mutationguard.Value{Kind: "string", Value: "east"}}}, MaxRows: 20, MaxBytes: 1 << 20, Generation: generation}
	mac, _ := mutationstore.DecodeKey(macKey)
	bundle, err := mutationmysql.SealBundle(mutationmysql.Bundle{Manifest: installation, Policies: []mutationguard.Policy{policy}}, mac)
	if err != nil {
		return err
	}
	if mutationstore.WriteProtectedArtifact(profile.ManifestPath, bundle) != nil {
		return errors.New("fixture bundle unavailable")
	}
	key, _ := mutationstore.DecodeKey(journalKey)
	packageKeys := mutationstore.NewMemoryPackageKeys()
	journal, err := mutationstore.Create(agent.MutationJournalPath(directory, config.ConnectorID, installation.TargetIdentity()), key, config.ConnectorID, packageKeys)
	if err != nil {
		return err
	}
	if journal.Close() != nil {
		return errors.New("fixture journal unavailable")
	}
	client, err := agent.NewClient(config.Server, "g3-wire")
	if err != nil {
		return err
	}
	client.PlatformKey = config.PlatformPublicKey
	platform := &agent.MutationPlatform{Client: client, ConnectorID: config.ConnectorID, Private: private}
	manager, err := agent.NewLocalMutationSessions(ctx, agent.MutationSessionOptions{ConnectorID: config.ConnectorID, Directory: directory, Profiles: profiles{input.SourceID: profile}, Platform: platform, NamespaceRegistry: mutationstore.NewMemoryPackageNamespaces(), PackageKeys: func(string, string) (mutationstore.PackageKeyStore, error) { return packageKeys, nil }, Controller: func(p mutationstore.Profile, m mutationmysql.Manifest) (*mutationmysql.Controller, error) {
		w, err := testmysql.OpenAccount(manifest, p.Writer.Username, p.Writer.Password, false)
		if err != nil {
			return nil, err
		}
		r, err := testmysql.OpenAccount(manifest, p.Recovery.Username, p.Recovery.Password, false)
		if err != nil {
			w.Close()
			return nil, err
		}
		return mutationmysql.NewWithDatabases(p.Target(), m, w, r)
	}})
	if err != nil {
		return err
	}
	client.Mutations = &agent.RunnerMutationHandler{Sessions: manager}
	defer client.CloseMutationTransport()
	if json.NewEncoder(os.Stdout).Encode(struct {
		Ready       bool   `json:"ready"`
		ConnectorID string `json:"connectorId"`
	}{true, config.ConnectorID}) != nil {
		return errors.New("fixture readiness unavailable")
	}
	var start struct {
		Run  bool `json:"run"`
		Stop bool `json:"stop"`
	}
	if decoder.Decode(&start) != nil || !start.Run {
		return nil
	}
	go func() {
		var stop struct {
			Stop bool `json:"stop"`
		}
		_ = decoder.Decode(&stop)
		cancel()
	}()
	for ctx.Err() == nil {
		if err = agent.Sync(ctx, client, config, identity); err != nil && ctx.Err() == nil {
			return fmt.Errorf("signed fixture sync failed: %w", err)
		}
		select {
		case <-ctx.Done():
		case <-time.After(100 * time.Millisecond):
		}
	}
	client.CloseMutationTransport()
	var count int
	if admin.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM "+ident(catalog)+".orders").Scan(&count) != nil {
		return errors.New("fixture final observation unavailable")
	}
	return json.NewEncoder(os.Stdout).Encode(struct {
		Done bool `json:"done"`
		Rows int  `json:"rows"`
	}{true, count})
}

var _ mutationrunner.Platform = (*agent.MutationPlatform)(nil)
