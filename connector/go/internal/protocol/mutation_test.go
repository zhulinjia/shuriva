package protocol

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

func TestMutationWireSharedVectorAndEveryAuthorizationField(t *testing.T) {
	raw, err := os.ReadFile("../../testdata/mutation-vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector struct {
		Now       int64           `json:"now"`
		PublicKey string          `json:"publicKey"`
		Fields    []string        `json:"fields"`
		Message   MutationMessage `json:"message"`
	}
	if json.Unmarshal(raw, &vector) != nil {
		t.Fatal("invalid public fixture")
	}
	if !reflect.DeepEqual(MutationFields(vector.Message), vector.Fields) {
		t.Fatal("Go/TypeScript signed bytes diverged")
	}
	now := time.Unix(vector.Now, 0)
	if VerifyMutationMessage(vector.Message, vector.Message.ConnectorID, vector.PublicKey, now) != nil {
		t.Fatal("shared TypeScript signature failed")
	}
	for name, mutate := range map[string]func(*MutationMessage){
		"operation": func(m *MutationMessage) { m.Operation = "execute" }, "actor": func(m *MutationMessage) { m.OwnerID = "other" }, "workspace": func(m *MutationMessage) { m.WorkspaceID = m.SourceID }, "source": func(m *MutationMessage) { m.SourceID = m.WorkspaceID }, "kind": func(m *MutationMessage) { m.Kind = "permit" }, "body": func(m *MutationMessage) { m.Payload = Encode([]byte("{}")) }, "nonce": func(m *MutationMessage) { m.Nonce = Encode(make([]byte, 32)) }, "expiry": func(m *MutationMessage) { m.ExpiresAt-- }, "reply-binding": func(m *MutationMessage) { m.ReplyTo = m.Nonce }, "protocol": func(m *MutationMessage) { m.Protocol = 2 },
	} {
		t.Run(name, func(t *testing.T) {
			m := vector.Message
			mutate(&m)
			if VerifyMutationMessage(m, m.ConnectorID, vector.PublicKey, now) == nil {
				t.Fatal("tampering accepted")
			}
		})
	}
	if VerifyMutationMessage(vector.Message, vector.Message.ConnectorID, vector.PublicKey, time.Unix(vector.Message.ExpiresAt, 0)) == nil {
		t.Fatal("expired task accepted")
	}
	if VerifyMutationMessage(vector.Message, "66666666-6666-4666-8666-666666666666", vector.PublicKey, now) == nil {
		t.Fatal("cross-connector message accepted")
	}
}
func TestMutationWirePollScopeAndMalformedPayloadRejected(t *testing.T) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	m, err := NewMutationMessage("22222222-2222-4222-8222-222222222222", "poll", private, now)
	if err != nil {
		t.Fatal(err)
	}
	if ValidateMutationMessage(m, now) != nil {
		t.Fatal("valid unscoped poll rejected")
	}
	for _, change := range []func(*MutationMessage){func(m *MutationMessage) { m.OwnerID = "owner" }, func(m *MutationMessage) { m.Payload = Encode([]byte{0xff}) }, func(m *MutationMessage) { m.Payload = Encode([]byte("{} {}")) }, func(m *MutationMessage) { m.Kind = "poll_reply" }, func(m *MutationMessage) { m.ExpiresAt = m.IssuedAt + 31 }} {
		candidate := m
		change(&candidate)
		if ValidateMutationMessage(candidate, now) == nil {
			t.Fatal("malformed routing/payload accepted")
		}
	}
}
