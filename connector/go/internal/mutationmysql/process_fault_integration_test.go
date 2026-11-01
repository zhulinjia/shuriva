package mutationmysql

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/mutationconfig"
	"example.com/ai-database-workspace/connector/internal/mutationguard"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	"example.com/ai-database-workspace/connector/internal/mutationstore"
	"example.com/ai-database-workspace/connector/internal/testmysql"
)

type crashInput struct {
	Target      mutationconfig.Target
	Manifest    Manifest
	Binding     mutationrunner.Binding
	Journal     string
	Key         []byte
	AfterCommit bool
}
type crashSignal struct {
	Phase     string
	Execution mutationrunner.Execution
}
type crashTarget struct {
	mutationrunner.Target
	input     crashInput
	execution *mutationrunner.Execution
}
type crashTransaction struct {
	mutationrunner.Transaction
	target crashTarget
}

func (t crashTarget) Begin(ctx context.Context, b mutationrunner.Binding) (mutationrunner.Transaction, error) {
	tx, err := t.Target.Begin(ctx, b)
	if err != nil {
		return nil, err
	}
	return crashTransaction{tx, t}, nil
}
func (t crashTransaction) Commit() error {
	phase := "before-commit"
	if t.target.input.AfterCommit {
		if err := t.Transaction.Commit(); err != nil {
			return err
		}
		phase = "after-commit"
	}
	if err := json.NewEncoder(os.Stdout).Encode(crashSignal{phase, *t.target.execution}); err != nil {
		return err
	}
	// The parent terminates this exact child process. No deferred close or final
	// journal transition can run; this is not an injected return from Commit.
	time.Sleep(45 * time.Second)
	return errors.New("parent did not terminate owned test child")
}
func g4Policy(b mutationrunner.Binding, catalog string) mutationguard.Policy {
	return mutationguard.Policy{Database: catalog, Table: "orders", InsertColumns: []string{"id", "label", "amount", "tenant"}, UpdateColumns: []string{"label", "amount"}, PreviewColumns: []string{"id", "label", "amount", "tenant"}, Delete: true, RowPredicates: []mutationguard.Predicate{{Column: "tenant", Operator: "eq", Value: &mutationguard.Value{Kind: "string", Value: "east"}}}, MaxRows: 20, MaxBytes: 1 << 20, Generation: b.PolicyGeneration}
}

func TestG4CrashHelper(t *testing.T) {
	if os.Getenv("STACKORYN_G4_CRASH_HELPER") != "1" {
		t.Skip("only an owned isolated subprocess may run this helper")
	}
	var input crashInput
	if json.NewDecoder(io.LimitReader(os.Stdin, 1<<20)).Decode(&input) != nil {
		t.Fatal("invalid child input")
	}
	m, err := testmysql.Load(os.Getenv("STAGE8_G3_MANIFEST"))
	if err != nil {
		t.Fatal(err)
	}
	writer, err := testmysql.OpenAccount(m, input.Target.Writer.Username, input.Target.Writer.Password, false)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	recovery, err := testmysql.OpenAccount(m, input.Target.Recovery.Username, input.Target.Recovery.Password, false)
	if err != nil {
		t.Fatal(err)
	}
	defer recovery.Close()
	controller, err := NewWithDatabases(input.Target, input.Manifest, writer, recovery)
	if err != nil {
		t.Fatal(err)
	}
	journal, err := mutationstore.Create(input.Journal, input.Key, input.Binding.ConnectorID, mutationstore.NewMemoryPackageKeys())
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	clock, err := mutationstore.NewClock()
	if err != nil {
		t.Fatal(err)
	}
	var e mutationrunner.Execution
	runner, err := mutationrunner.New(mutationrunner.Config{Binding: input.Binding, Policies: map[string]mutationguard.Policy{"orders": g4Policy(input.Binding, input.Manifest.Spec.Catalog)}, HMACKey: input.Key}, crashTarget{controller, input, &e}, journal, clock, &isolatedPermitPort{claims: map[string]mutationrunner.Execution{}})
	if err != nil {
		t.Fatal(err)
	}
	defer runner.Close()
	p, err := runner.Preview(context.Background(), mutationguard.Plan{Operation: "update", Table: "orders", Changes: []mutationguard.Assignment{{Column: "label", Value: mutationguard.Value{Kind: "string", Value: "G4-crash-once"}}}, Where: integerWhere("1")})
	if err != nil {
		t.Fatal(err)
	}
	e = mutationrunner.Execution{Binding: p.Binding, ExecutionID: testUUID(), PreviewID: p.PreviewID, Commitment: p.Commitment, Revision: p.Revision}
	_, _ = runner.Execute(context.Background(), e)
	t.Fatal("crash barrier was not terminated")
}

func TestG4KilledConnectorRecoversWithoutReexecution(t *testing.T) {
	for _, after := range []bool{false, true} {
		name := "before-commit"
		if after {
			name = "after-commit"
		}
		t.Run(name, func(t *testing.T) {
			l := newLab(t)
			key := make([]byte, 32)
			if _, err := rand.Read(key); err != nil {
				t.Fatal(err)
			}
			input := crashInput{l.profile.Target(), l.manifest, l.binding, filepath.Join(t.TempDir(), "owned-crash.db"), key, after}
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, executable, "-test.run=^TestG4CrashHelper$")
			cmd.Env = append(os.Environ(), "STACKORYN_G4_CRASH_HELPER=1")
			stdin, err := cmd.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			stdout, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			// Child errors may contain transient account details. Never print them.
			cmd.Stderr = io.Discard
			if err := cmd.Start(); err != nil {
				t.Fatal("cannot start owned test process")
			}
			waited := false
			defer func() {
				if !waited {
					_ = cmd.Process.Kill()
					_ = cmd.Wait()
				}
			}()
			if err := json.NewEncoder(stdin).Encode(input); err != nil {
				t.Fatal(err)
			}
			stdin.Close()
			var signal crashSignal
			if err := json.NewDecoder(stdout).Decode(&signal); err != nil {
				t.Fatal("owned test child did not reach crash barrier")
			}
			if signal.Phase != name || signal.Execution.ExecutionID == "" {
				t.Fatal("wrong crash phase")
			}
			if err := cmd.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			if err := cmd.Wait(); err == nil {
				t.Fatal("child exited normally; crash was not tested")
			}
			waited = true
			journal, err := mutationstore.Open(input.Journal, key, l.binding.ConnectorID, mutationstore.NewMemoryPackageKeys())
			if err != nil {
				t.Fatal("crash journal failed authentication", err)
			}
			defer journal.Close()
			stored, err := journal.Get(ctx, signal.Execution.ExecutionID, signal.Execution.Scope)
			if err != nil || stored.State != "commit_intent" {
				t.Fatal("durable crash boundary was not commit_intent")
			}
			binding := l.binding
			binding.APIBoot = strings.Repeat("a", 64)
			binding.ConnectorBoot = strings.Repeat("b", 64)
			clock, err := mutationstore.NewClock()
			if err != nil {
				t.Fatal(err)
			}
			platform := &isolatedPermitPort{claims: map[string]mutationrunner.Execution{}}
			runner, err := mutationrunner.New(mutationrunner.Config{Binding: binding, Policies: map[string]mutationguard.Policy{"orders": g4Policy(binding, l.manifest.Spec.Catalog)}, HMACKey: key}, l.controller, journal, clock, platform)
			if err != nil {
				t.Fatal(err)
			}
			defer runner.Close()
			status, err := runner.Status(ctx, signal.Execution.Scope, signal.Execution.ExecutionID)
			if err != nil {
				t.Fatal(err)
			}
			want := "outcome_unknown"
			labelWant := "first"
			if after {
				want = "committed"
				labelWant = "G4-crash-once"
			}
			if status.State != want {
				t.Fatalf("crash result: got %s want %s", status.State, want)
			}
			if _, err := runner.Execute(ctx, signal.Execution); err == nil {
				t.Fatal("old boot regained execution permission")
			}
			platform.mu.Lock()
			claims := len(platform.claims)
			platform.mu.Unlock()
			if claims != 0 {
				t.Fatal("recovery requested execution claim")
			}
			var label string
			if err := l.fixture.Admin.QueryRowContext(ctx, "SELECT label FROM "+qualified(l.manifest.Spec.Catalog, "orders")+" WHERE id=1").Scan(&label); err != nil || label != labelWant {
				t.Fatal("crash changed original transaction outcome", fmt.Sprint(err))
			}
		})
	}
}
