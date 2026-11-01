package agent

import (
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	"testing"
)

func TestMutationErrorPacketsPreserveOnlyIdentifiedExecutionFacts(t *testing.T) {
	failed := mutationResultPacket(mutationrunner.Preview{}, mutationrunner.ErrFrozen)
	if failed.OK || failed.Result != nil || failed.Code != "frozen" {
		t.Fatal("frozen preview was reported as success")
	}
	denied := mutationResultPacket(nil, mutationrunner.ErrDenied)
	if denied.OK || denied.Code != "denied" {
		t.Fatal("authorization refusal lost its stable error")
	}
	empty := mutationResultPacket(mutationrunner.Result{}, mutationrunner.ErrUnknown)
	if empty.OK {
		t.Fatal("unidentified execution error was accepted")
	}
	fact := mutationrunner.Result{Execution: mutationrunner.Execution{ExecutionID: "original-execution"}, State: "outcome_unknown", Code: "commit_unknown"}
	preserved := mutationResultPacket(fact, mutationrunner.ErrUnknown)
	if !preserved.OK || preserved.Result != fact {
		t.Fatal("original unknown execution fact was discarded")
	}
}

func TestMutationDiagnosticOutcomeNeverClaimsUnknownOrPendingAsSuccess(t *testing.T) {
	for _, tc := range []struct{ state, want string }{{"outcome_unknown", "unknown"}, {"registered", "pending"}, {"running", "pending"}, {"commit_intent", "pending"}, {"rejected", "failed"}, {"rolled_back", "failed"}, {"committed", "success"}} {
		outcome, id := mutationDiagnosticOutcome(mutationrunner.Result{Execution: mutationrunner.Execution{ExecutionID: "original"}, State: tc.state}, nil)
		if outcome != tc.want || id != "original" {
			t.Fatalf("state %s logged as %s", tc.state, outcome)
		}
	}
}
