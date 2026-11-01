package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"example.com/ai-database-workspace/connector/internal/agent"
	"example.com/ai-database-workspace/connector/internal/mutationmysql"
)

func TestWritePlanIsOfflineNewArtifactAndFixedSpecification(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CONNECTOR_CONFIG_PATH", filepath.Join(dir, "connector.json"))
	spec := mutationmysql.InstallSpec{Catalog: "isolated_sample", Tables: []string{"orders"}, Writer: mutationmysql.Account{User: "sample_writer", Host: "127.0.0.1"}, Recovery: mutationmysql.Account{User: "sample_recovery", Host: "127.0.0.1"}}
	raw, _ := json.Marshal(spec)
	input := filepath.Join(dir, "spec.json")
	if os.WriteFile(input, raw, 0600) != nil {
		t.Fatal("input")
	}
	output := filepath.Join(dir, "reviewed.sql")
	var out, errOut bytes.Buffer
	if code := RunWithContext(context.Background(), []string{"write", "plan-install", "--spec", input, "--out", output}, nil, &out, &errOut, "test"); code != 0 {
		t.Fatalf("offline plan: %s", errOut.String())
	}
	sql, err := os.ReadFile(output)
	if err != nil || !strings.Contains(string(sql), "ACCOUNT LOCK") || strings.Contains(string(sql), "IDENTIFIED BY") {
		t.Fatal("SQL missing or credential-bearing")
	}
	var resolved mutationmysql.InstallSpec
	if readWriteJSON(output+".spec.json", &resolved) != nil || len(resolved.Generation) != 64 || len(resolved.Incarnation) != 64 {
		t.Fatal("generated epochs were not retained")
	}
	plan, err := mutationmysql.BuildInstallation(resolved)
	if err != nil || plan.SQL() == "" {
		t.Fatal("resolved specification is not reproducible")
	}
	out.Reset()
	errOut.Reset()
	if code := RunWithContext(context.Background(), []string{"write", "plan-install", "--spec", input, "--out", output}, nil, &out, &errOut, "test"); code == 0 {
		t.Fatal("existing reviewed artifact overwritten")
	}
	unchanged, _ := os.ReadFile(output)
	if !bytes.Equal(sql, unchanged) {
		t.Fatal("existing artifact changed on refusal")
	}
	if _, err := os.Stat(filepath.Join(dir, "connector.json.lock")); !os.IsNotExist(err) {
		t.Fatal("local lock left behind")
	}
	if _, err := os.Stat(filepath.Join(dir, "connector.json")); !os.IsNotExist(err) {
		t.Fatal("offline planning manufactured a Connector identity")
	}
}
func TestWriteCaptureRequiresExplicitInteractiveConsentBeforeAnyAccess(t *testing.T) {
	var out, errOut bytes.Buffer
	id := "7f7667de-5937-4f69-9855-74959f0e8825"
	args := []string{"--source", id, "--spec", "does-not-exist.json", "--policy", "does-not-exist.json", "--manifest", "new.json", "--host", "127.0.0.1", "--port", "13308", "--tls", "local", "--admin", "root", "--workspaces", id, "--confirm-reviewed-installation"}
	if err := writeConfigure(context.Background(), args, nil, &out, &errOut, filepath.Join(t.TempDir(), "missing-identity.json")); err == nil || !strings.Contains(err.Error(), "interactive terminal") {
		t.Fatal("noninteractive configuration reached files, keyring or database")
	}
	if out.Len() != 0 {
		t.Fatal("noninteractive refusal prompted for a password")
	}
	if _, err := parseWriteConfigure(args[:len(args)-1], &errOut); err == nil {
		t.Fatal("missing reviewed-installation acknowledgement accepted")
	}
	bad := append(append([]string(nil), args...), "--password", "should-never-be-logged")
	errOut.Reset()
	if _, err := parseWriteConfigure(bad, &errOut); err == nil || strings.Contains(errOut.String(), "should-never-be-logged") {
		t.Fatal("password argument accepted or echoed")
	}
}
func TestWriteCommandsUseConnectorExclusiveLockAndNeverEnableRuntime(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "connector.json")
	t.Setenv("CONNECTOR_CONFIG_PATH", path)
	release, err := agent.LockConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	var out, errOut bytes.Buffer
	if RunWithContext(context.Background(), []string{"write", "plan-install", "--spec", "none", "--out", "none"}, nil, &out, &errOut, "test") == 0 || out.Len() != 0 {
		t.Fatal("write planning bypassed the running Connector lock")
	}
	if err := writeCommand(context.Background(), []string{"enable"}, nil, &out, &errOut, path); err == nil {
		t.Fatal("pre-G4 runtime write switch enabled")
	}
}
