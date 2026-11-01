package mutationrunner_test

import (
	"context"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/mutationguard"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
)

func TestG4PermitBoundaryIncludesHandoffReserve(t *testing.T) {
	for _, tc := range []struct {
		name    string
		delay   uint64
		commits int
	}{{"just-inside", 28_999_999, 1}, {"reserve-boundary", 29_000_000, 0}, {"exact-deadline", 30_000_000, 0}, {"late", 31_000_000, 0}} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t, []mutationguard.Row{row("old")}, []mutationguard.Row{row("old")}, []mutationguard.Row{row("new")})
			e := previewExecution(t, f, updatePlan())
			f.platform.delay = tc.delay
			result, err := f.runner.Execute(context.Background(), e)
			if tc.commits == 1 && (err != nil || result.State != "committed") {
				t.Fatal("valid budget rejected")
			}
			if tc.commits == 0 && (err == nil || result.State != "rolled_back") {
				t.Fatal("expired handoff budget committed")
			}
			if f.target.commitCalls != tc.commits {
				t.Fatal("wrong number of commit handoffs")
			}
		})
	}
}

func TestG4ExpiryAfterCommitHandoffCannotBecomeRollback(t *testing.T) {
	f := newFixture(t, []mutationguard.Row{row("old")}, []mutationguard.Row{row("old")}, []mutationguard.Row{row("new")})
	e := previewExecution(t, f, updatePlan())
	f.target.commitEntered = make(chan struct{})
	f.target.commitRelease = make(chan struct{})
	done := make(chan mutationrunner.Result, 1)
	go func() { result, _ := f.runner.Execute(context.Background(), e); done <- result }()
	select {
	case <-f.target.commitEntered:
	case <-time.After(time.Second):
		t.Fatal("no commit handoff")
	}
	f.clock.advance(10 * 10_000_000)
	close(f.target.commitRelease)
	select {
	case result := <-done:
		if result.State != "committed" {
			t.Fatal("expiry erased a known commit")
		}
	case <-time.After(time.Second):
		t.Fatal("commit did not finish")
	}
	stored, err := f.store.Get(context.Background(), e.ExecutionID, e.Scope)
	if err != nil || stored.State != "committed" {
		t.Fatal("expired post-handoff result not retained")
	}
}
