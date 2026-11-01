package protocol

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func TestReadTaskBindsPayloadAndAuthorizationContext(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	request := ReadRequest{SQL: "SELECT id FROM customers WHERE id = ?", Parameters: []ReadParameter{{Kind: "integer", Value: "7"}}, MaxRows: 10}
	raw, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	task := ReadTask{ID: "11111111-1111-4111-8111-111111111111", ConnectorID: "22222222-2222-4222-8222-222222222222", ActorID: "owner", WorkspaceID: "33333333-3333-4333-8333-333333333333", SourceID: "44444444-4444-4444-8444-444444444444", Operation: "read_query", Payload: Encode(raw), IssuedAt: now.Unix(), ExpiresAt: now.Unix() + 60, Nonce: Encode(make([]byte, 32)), Protocol: 1}
	task.Signature = Encode(ed25519.Sign(private, []byte(strings.Join(ReadTaskFields(task), "\n"))))
	parsed, err := VerifyReadTask(task, task.ConnectorID, Encode(public), now)
	if err != nil || parsed.SQL != request.SQL || len(parsed.Parameters) != 1 || parsed.Parameters[0].Value != "7" {
		t.Fatal("valid signed task failed")
	}
	for _, tamper := range []func(*ReadTask){
		func(x *ReadTask) { x.Payload = Encode([]byte(`{"sql":"SELECT secret","parameters":[],"maxRows":1}`)) },
		func(x *ReadTask) { x.WorkspaceID = "55555555-5555-4555-8555-555555555555" },
		func(x *ReadTask) { x.SourceID = "55555555-5555-4555-8555-555555555555" },
		func(x *ReadTask) { x.ActorID = "other" },
		func(x *ReadTask) { x.ExpiresAt++ },
	} {
		candidate := task
		tamper(&candidate)
		if _, err = VerifyReadTask(candidate, task.ConnectorID, Encode(public), now); err == nil {
			t.Fatal("tampered task accepted")
		}
	}
	if _, err = VerifyReadTask(task, task.ConnectorID, Encode(public), now.Add(61*time.Second)); err == nil {
		t.Fatal("expired task accepted")
	}
	if _, err = VerifyReadTask(task, "55555555-5555-4555-8555-555555555555", Encode(public), now); err == nil {
		t.Fatal("other connector accepted")
	}
}

func TestModelSchemaTaskHasDistinctSignatureAndEmptyPayload(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	task := ReadTask{ID: "11111111-1111-4111-8111-111111111111", ConnectorID: "22222222-2222-4222-8222-222222222222", ActorID: "owner", WorkspaceID: "33333333-3333-4333-8333-333333333333", SourceID: "44444444-4444-4444-8444-444444444444", Operation: "model_schema", Payload: Encode([]byte("{}")), IssuedAt: now.Unix(), ExpiresAt: now.Unix() + 60, Nonce: Encode(make([]byte, 32)), Protocol: 1}
	task.Signature = Encode(ed25519.Sign(private, []byte(strings.Join(ReadTaskFields(task), "\n"))))
	if _, err := VerifyReadTask(task, task.ConnectorID, Encode(public), now); err != nil {
		t.Fatal(err)
	}
	tampered := task
	tampered.Operation = "read_query"
	if _, err := VerifyReadTask(tampered, task.ConnectorID, Encode(public), now); err == nil {
		t.Fatal("changed operation accepted")
	}
	tampered = task
	tampered.Payload = Encode([]byte(`{"sql":"SELECT id FROM customers"}`))
	tampered.Signature = Encode(ed25519.Sign(private, []byte(strings.Join(ReadTaskFields(tampered), "\n"))))
	if _, err := VerifyReadTask(tampered, task.ConnectorID, Encode(public), now); err == nil {
		t.Fatal("schema task accepted extra payload")
	}
}

func TestReadTaskSharedContractVector(t *testing.T) {
	raw, err := os.ReadFile("../../../testdata/read-task.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		PublicKey string     `json:"publicKey"`
		Task      ReadTask   `json:"task"`
		Cancel    ReadCancel `json:"cancel"`
		Result    ReadResult `json:"result"`
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	request, err := VerifyReadTask(fixture.Task, fixture.Task.ConnectorID, fixture.PublicKey, time.Unix(fixture.Task.IssuedAt+1, 0))
	if err != nil || request.MaxRows != 10 || len(request.Parameters) != 1 || request.Parameters[0].Value != "7" {
		t.Fatalf("shared contract failed: %v", err)
	}
	if err = VerifyReadCancel(fixture.Cancel, fixture.Task.ConnectorID, fixture.PublicKey, time.Unix(fixture.Cancel.IssuedAt+1, 0)); err != nil {
		t.Fatalf("shared cancellation contract failed: %v", err)
	}
	key, err := Decode(fixture.PublicKey, ed25519.PublicKeySize)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := Decode(fixture.Result.Signature, ed25519.SignatureSize)
	if err != nil || !ed25519.Verify(ed25519.PublicKey(key), []byte(strings.Join(ReadResultFields(fixture.Result), "\n")), sig) {
		t.Fatal("shared result signature failed")
	}
}
