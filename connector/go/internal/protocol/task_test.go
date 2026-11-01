package protocol

import (
	"crypto/ed25519"
	"crypto/rand"
	"strings"
	"testing"
	"time"
)

func TestDiagnosticTaskVerification(t *testing.T) {
	pub, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	task := Task{ID: "11111111-1111-4111-8111-111111111111", ConnectorID: "22222222-2222-4222-8222-222222222222", ActorID: "owner", Operation: "diagnostic", IssuedAt: now.Unix(), ExpiresAt: now.Unix() + 60, Nonce: Encode(make([]byte, 32)), Protocol: 1}
	task.Signature = Encode(ed25519.Sign(private, []byte(strings.Join(TaskFields(task), "\n"))))
	key := Encode(pub)
	if err := VerifyTask(task, task.ConnectorID, key, now); err != nil {
		t.Fatal(err)
	}
	if err := VerifyTask(task, "33333333-3333-4333-8333-333333333333", key, now); err == nil {
		t.Fatal("accepted wrong connector")
	}
	if err := VerifyTask(task, task.ConnectorID, key, now.Add(61*time.Second)); err == nil {
		t.Fatal("accepted expired task")
	}
	changed := task
	changed.ActorID = "attacker"
	if err := VerifyTask(changed, changed.ConnectorID, key, now); err == nil {
		t.Fatal("accepted tampered task")
	}
	changed = task
	changed.Operation = "sql"
	if err := VerifyTask(changed, changed.ConnectorID, key, now); err == nil {
		t.Fatal("accepted unsupported operation")
	}
}

func TestScanTaskBindsWorkspaceAndSource(t *testing.T) {
	pub, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	task := Task{ID: "11111111-1111-4111-8111-111111111111", ConnectorID: "22222222-2222-4222-8222-222222222222", ActorID: "owner", WorkspaceID: "33333333-3333-4333-8333-333333333333", SourceID: "44444444-4444-4444-8444-444444444444", Operation: "schema_scan", IssuedAt: now.Unix(), ExpiresAt: now.Unix() + 60, Nonce: Encode(make([]byte, 32)), Protocol: 2}
	task.Signature = Encode(ed25519.Sign(private, []byte(strings.Join(TaskFields(task), "\n"))))
	if err := VerifyTask(task, task.ConnectorID, Encode(pub), now); err != nil {
		t.Fatal(err)
	}
	changed := task
	changed.WorkspaceID = "55555555-5555-4555-8555-555555555555"
	if VerifyTask(changed, changed.ConnectorID, Encode(pub), now) == nil {
		t.Fatal("accepted altered workspace")
	}
	changed = task
	changed.SourceID = "55555555-5555-4555-8555-555555555555"
	if VerifyTask(changed, changed.ConnectorID, Encode(pub), now) == nil {
		t.Fatal("accepted altered source")
	}
	if VerifyTask(task, task.ConnectorID, Encode(pub), now.Add(61*time.Second)) == nil {
		t.Fatal("accepted expired task")
	}
}
