package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/datasource"
	"example.com/ai-database-workspace/connector/internal/protocol"
)

type missingReadSource struct{}

func (missingReadSource) Get(string) (datasource.Profile, error) {
	return datasource.Profile{}, errors.New("missing")
}
func (missingReadSource) Set(datasource.Profile) error { return errors.New("unsupported") }
func (missingReadSource) Delete(string) error          { return errors.New("unsupported") }

func TestReadRunnerAuthenticatesBeforeRecordingAndRejectsReplay(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	connector := "22222222-2222-4222-8222-222222222222"
	vault := &memoryVault{data: map[string]KeyState{connector: {Active: "fixture"}}}
	runner := NewReadRunner(Config{ConnectorID: connector, PlatformPublicKey: protocol.Encode(public)}, vault, missingReadSource{})
	payload, _ := json.Marshal(protocol.ReadRequest{SQL: "SELECT id FROM customers", Parameters: []protocol.ReadParameter{}, MaxRows: 10})
	now := time.Now().Unix()
	task := protocol.ReadTask{ID: "11111111-1111-4111-8111-111111111111", ConnectorID: connector, ActorID: "owner", WorkspaceID: "33333333-3333-4333-8333-333333333333", SourceID: "44444444-4444-4444-8444-444444444444", Operation: "read_query", Payload: protocol.Encode(payload), IssuedAt: now, ExpiresAt: now + 60, Nonce: protocol.Encode(make([]byte, 32)), Protocol: 1}
	task.Signature = protocol.Encode(ed25519.Sign(private, []byte(strings.Join(protocol.ReadTaskFields(task), "\n"))))
	forged := task
	forged.WorkspaceID = "55555555-5555-4555-8555-555555555555"
	if _, err = runner.Execute(context.Background(), forged); err == nil {
		t.Fatal("forged task accepted")
	}
	state, _ := vault.Get(connector)
	if len(state.Completed) != 0 {
		t.Fatal("forged task recorded")
	}
	if _, err = runner.Execute(context.Background(), task); err == nil {
		t.Fatal("missing source accepted")
	}
	state, _ = vault.Get(connector)
	if len(state.Completed) != 1 {
		t.Fatal("task was not recorded before execution")
	}
	if _, err = runner.Execute(context.Background(), task); !errors.Is(err, ErrReadReplay) {
		t.Fatalf("replay accepted: %v", err)
	}
}
