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

func TestReadTaskRequiresExplicitDelegatedScope(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	task := ReadTask{ID: "11111111-1111-4111-8111-111111111111", ConnectorID: "22222222-2222-4222-8222-222222222222", ActorID: "owner", WorkspaceID: "33333333-3333-4333-8333-333333333333", SourceID: "44444444-4444-4444-8444-444444444444", Operation: "read_query", IssuedAt: now.Unix(), ExpiresAt: now.Unix() + 60, Nonce: Encode(make([]byte, 32)), Protocol: 1}
	for _, raw := range []string{
		`{"sql":"SELECT id FROM customers","parameters":[],"maxRows":1,"schemaVersion":null}`,
		`{"sql":"SELECT id FROM customers","parameters":[],"maxRows":1,"schemaVersion":null,"delegatedScope":"all"}`,
		`{"sql":"SELECT id FROM customers","parameters":[],"maxRows":1,"schemaVersion":null,"delegatedScope":{"customers":["id"]},"delegatedScope":null}`,
		`{"sql":"SELECT id FROM customers","parameters":[],"maxRows":1,"schemaVersion":null,"DelegatedScope":null}`,
		`{"sql":"SELECT id FROM customers","parameters":[],"maxRows":1,"schemaVersion":null,"delegatedScope":{"customers":["id"],"customers":["secret"]}}`,
	} {
		task.Payload = Encode([]byte(raw))
		task.Signature = Encode(ed25519.Sign(private, []byte(strings.Join(ReadTaskFields(task), "\n"))))
		if _, err = VerifyReadTask(task, task.ConnectorID, Encode(public), now); err == nil {
			t.Fatal("signed task with missing or malformed delegation accepted")
		}
	}
}

func TestDelegatedSchemaTaskBindsAndValidatesScope(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	task := ReadTask{ID: "11111111-1111-4111-8111-111111111111", ConnectorID: "22222222-2222-4222-8222-222222222222", ActorID: "owner", WorkspaceID: "33333333-3333-4333-8333-333333333333", SourceID: "44444444-4444-4444-8444-444444444444", Operation: "model_schema", IssuedAt: now.Unix(), ExpiresAt: now.Unix() + 60, Nonce: Encode(make([]byte, 32)), Protocol: 1}
	sign := func(raw string) {
		task.Payload = Encode([]byte(raw))
		task.Signature = Encode(ed25519.Sign(private, []byte(strings.Join(ReadTaskFields(task), "\n"))))
	}
	sign(`{"delegatedScope":{"customers":["id"]}}`)
	parsed, err := VerifyReadTask(task, task.ConnectorID, Encode(public), now)
	if err != nil || len(parsed.DelegatedScope["customers"]) != 1 || parsed.DelegatedScope["customers"][0] != "id" {
		t.Fatal("delegated schema scope rejected")
	}
	tampered := task
	tampered.Payload = Encode([]byte(`{"delegatedScope":{"customers":["id","secret"]}}`))
	if _, err := VerifyReadTask(tampered, task.ConnectorID, Encode(public), now); err == nil {
		t.Fatal("unsigned schema scope change accepted")
	}
	for _, raw := range []string{`{"delegatedScope":null}`, `{"delegatedScope":{}}`, `{"delegatedScope":{"customers":["id"],"customers":["secret"]}}`, `{"delegatedScope":{"customers":["id"]},"other":1}`, `{"DelegatedScope":{"customers":["id"]}}`} {
		sign(raw)
		if _, err := VerifyReadTask(task, task.ConnectorID, Encode(public), now); err == nil {
			t.Fatal("malformed delegated schema accepted")
		}
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
	if columns := request.DelegatedScope["customers"]; len(columns) != 1 || columns[0] != "id" {
		t.Fatal("shared task does not bind the delegated scope")
	}
	widened := fixture.Task
	request.DelegatedScope["customers"] = append(request.DelegatedScope["customers"], "secret")
	changed, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	widened.Payload = Encode(changed)
	if _, err = VerifyReadTask(widened, widened.ConnectorID, fixture.PublicKey, time.Unix(widened.IssuedAt+1, 0)); err == nil {
		t.Fatal("delegated scope changed without invalidating the signature")
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

func TestDelegatedSchemaSharedContractVector(t *testing.T) {
	raw, err := os.ReadFile("../../../testdata/delegated-schema-task.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		PublicKey string   `json:"publicKey"`
		Task      ReadTask `json:"task"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	request, err := VerifyReadTask(fixture.Task, fixture.Task.ConnectorID, fixture.PublicKey, time.Unix(fixture.Task.IssuedAt+1, 0))
	if err != nil || fixture.Task.Operation != "model_schema" || len(request.DelegatedScope["customers"]) != 1 || request.DelegatedScope["customers"][0] != "id" {
		t.Fatal("shared schema scope signature failed", err)
	}
}
