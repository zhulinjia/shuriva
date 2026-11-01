package mutationmysql

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"example.com/ai-database-workspace/connector/internal/mutationguard"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	"example.com/ai-database-workspace/connector/internal/mutationstore"
)

type unavailableJournal struct {
	mutationrunner.Journal
	state string
}

func (j unavailableJournal) Transition(ctx context.Context, r mutationrunner.Record) error {
	if r.State == j.state {
		return syscall.ENOSPC
	}
	return j.Journal.Transition(ctx, r)
}
func TestG4JournalFailureBoundariesPreserveDatabaseFacts(t *testing.T) {
	for _, phase := range []string{"execution_started", "commit_intent", "committed"} {
		t.Run(phase, func(t *testing.T) {
			l := newLab(t)
			key := make([]byte, 32)
			if _, err := rand.Read(key); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "fault-journal.db")
			journal, err := mutationstore.Create(path, key, l.binding.ConnectorID, mutationstore.NewMemoryPackageKeys())
			if err != nil {
				t.Fatal(err)
			}
			defer journal.Close()
			clock, err := mutationstore.NewClock()
			if err != nil {
				t.Fatal(err)
			}
			runner, err := mutationrunner.New(mutationrunner.Config{Binding: l.binding, Policies: map[string]mutationguard.Policy{"orders": g4Policy(l.binding, l.manifest.Spec.Catalog)}, HMACKey: key}, l.controller, unavailableJournal{journal, phase}, clock, &isolatedPermitPort{claims: map[string]mutationrunner.Execution{}})
			if err != nil {
				t.Fatal(err)
			}
			defer runner.Close()
			const secret = "G4-private-value-not-in-journal"
			e := corePreviewExecution(t, runner, mutationguard.Plan{Operation: "update", Table: "orders", Changes: []mutationguard.Assignment{{Column: "label", Value: mutationguard.Value{Kind: "string", Value: secret}}}, Where: integerWhere("1")})
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(raw, []byte(secret)) || bytes.Contains(raw, []byte(l.profile.Writer.Password)) {
				t.Fatal("plaintext secret entered durable journal")
			}
			result, err := runner.Execute(context.Background(), e)
			if phase == "committed" {
				if err != nil || result.State != "committed" || result.Code != "journal_unavailable" {
					t.Fatal("known commit was erased by journal failure")
				}
			} else if err == nil || result.State == "committed" {
				t.Fatal("journal failure before commit did not reject execution")
			}
			var label string
			if err := l.fixture.Admin.QueryRow("SELECT label FROM " + qualified(l.manifest.Spec.Catalog, "orders") + " WHERE id=1").Scan(&label); err != nil {
				t.Fatal(err)
			}
			want := "first"
			if phase == "committed" {
				want = secret
			}
			if label != want {
				t.Fatal("database facts changed by diagnostic classification")
			}
			receipt, err := l.controller.Receipt(context.Background(), e.Scope, e.ExecutionID)
			if err != nil {
				t.Fatal(err)
			}
			if (receipt != nil) != (phase == "committed") {
				t.Fatal("receipt was not atomic with business change")
			}
			if _, err := runner.Preview(context.Background(), mutationguard.Plan{Operation: "delete", Table: "orders", Where: integerWhere("1")}); !errors.Is(err, mutationrunner.ErrFrozen) {
				t.Fatal("journal failure reopened target")
			}
		})
	}
}
