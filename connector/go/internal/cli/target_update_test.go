package cli

import (
	"context"
	"io"
	"path/filepath"
	"strings"
	"testing"

	"example.com/ai-database-workspace/connector/internal/agent"
	"example.com/ai-database-workspace/connector/internal/datasource"
	"example.com/ai-database-workspace/connector/internal/protocol"
)

func TestTargetChangeRequiresSameDatabaseConfirmation(t *testing.T) {
	p := datasource.Profile{Host: "127.0.0.1", Port: 3306, Database: "source"}
	for _, tc := range []struct {
		name, host, database string
		port                 int
		confirmed, reject    bool
	}{
		{"password or user only", "", "", 0, false, false},
		{"unchanged target", "127.0.0.1", "source", 3306, false, false},
		{"host without confirmation", "other", "", 0, false, true},
		{"port without confirmation", "", "", 3307, false, true},
		{"confirmed same database migration", "other", "", 3307, true, false},
		{"new database forbidden even confirmed", "", "other", 0, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateTargetChange(p, tc.host, tc.port, tc.database, tc.confirmed)
			if (err != nil) != tc.reject {
				t.Fatalf("unexpected result: %v", err)
			}
		})
	}
}

func TestExistingSourceIDRequiresConfirmationBeforePassword(t *testing.T) {
	path := filepath.Join(t.TempDir(), "connector.json")
	err := agent.WriteConfig(path, agent.Config{ConnectorID: "33333333-3333-4333-8333-333333333333", Server: "http://127.0.0.1:3000", Name: "test", PlatformPublicKey: protocol.Encode(make([]byte, 32))})
	if err != nil {
		t.Fatal(err)
	}
	id := "11111111-1111-4111-8111-111111111111"
	err = sourceCommand(context.Background(), []string{"add", "--id", id}, nil, io.Discard, io.Discard, path)
	if err == nil || !strings.Contains(err.Error(), "--confirm-existing-source") {
		t.Fatalf("missing safety confirmation: %v", err)
	}
	err = sourceCommand(context.Background(), []string{"add", "--id", id, "--confirm-existing-source"}, nil, io.Discard, io.Discard, path)
	if err == nil || !strings.Contains(err.Error(), "interactive terminal") {
		t.Fatalf("confirmation did not proceed to password prompt: %v", err)
	}
}
