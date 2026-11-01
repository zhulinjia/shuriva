package protocol

import (
	"crypto/ed25519"
	"crypto/rand"
	"strings"
	"testing"
	"time"
)

func TestReadResultSignatureAndSafeFailureCodes(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	task := ReadTask{ID: "11111111-1111-4111-8111-111111111111", ConnectorID: "22222222-2222-4222-8222-222222222222", ActorID: "owner", WorkspaceID: "33333333-3333-4333-8333-333333333333", SourceID: "44444444-4444-4444-8444-444444444444", Nonce: Encode(make([]byte, 32))}
	result, err := NewReadResult(task, "failed", "denied", private, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	sig, err := Decode(result.Signature, ed25519.SignatureSize)
	if err != nil || !ed25519.Verify(public, []byte(strings.Join(ReadResultFields(result), "\n")), sig) {
		t.Fatal("invalid result signature")
	}
	result.Payload = "error"
	if ed25519.Verify(public, []byte(strings.Join(ReadResultFields(result), "\n")), sig) {
		t.Fatal("tampered result accepted")
	}
	if _, err = NewReadResult(task, "failed", "raw password or database error", private, time.Now()); err == nil {
		t.Fatal("arbitrary error accepted")
	}
	if _, err = NewReadResult(task, "failed", "outcome_unknown", private, time.Now()); err != nil {
		t.Fatal("unknown outcome rejected")
	}
	if _, err = NewReadResult(task, "ok", "not-a-json-payload", private, time.Now()); err == nil {
		t.Fatal("invalid result payload accepted")
	}
	if _, err = NewReadResult(task, "ok", Encode([]byte(`{"rows":[]}`)), private, time.Now()); err != nil {
		t.Fatal("valid result payload rejected")
	}
}
