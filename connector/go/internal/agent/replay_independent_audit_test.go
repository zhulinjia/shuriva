package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/protocol"
	"github.com/zalando/go-keyring"
)

// This fixture creates credentials only under a fresh random Connector ID.
func TestIndependentReplaySearchesEveryCandidateBeforeSelectingSpace(t *testing.T) {
	if os.Getenv("STAGE3_KEYRING_TEST") != "1" {
		t.Skip("requires operating system credential store")
	}
	id, err := newID()
	if err != nil {
		t.Fatal(err)
	}
	vault := SystemVault{}
	secret := []byte(strings.Repeat("q", 32))
	if err := vault.Set(id, KeyState{Active: "synthetic-fixture", ReplayKey: protocol.Encode(secret)}); err != nil {
		t.Fatal(err)
	}
	target := CompletedTask{ID: "aaaaaaaa-1111-4111-8111-111111111111", Signature: protocol.Encode(make([]byte, 64)), ExpiresAt: time.Now().Unix() + 60}
	names := replayKeys(id, target.ID, secret)
	defer func() {
		for _, name := range names {
			_ = keyring.Delete(keyService, name)
		}
		_ = vault.Delete(id)
	}()
	if len(names) != 4 {
		t.Fatal("expected four candidates")
	}
	seen := map[string]bool{}
	for _, name := range names {
		if seen[name] {
			t.Fatal("duplicate candidate")
		}
		seen[name] = true
	}
	for bucket, name := range names {
		entries := make([]CompletedTask, 0, 8)
		count := 8
		if bucket == 0 {
			count = 7
		}
		for i := 0; i < count; i++ {
			entries = append(entries, CompletedTask{ID: fmt.Sprintf("%08x-1111-4111-8111-111111111111", bucket*16+i), Signature: target.Signature, ExpiresAt: target.ExpiresAt})
		}
		if bucket == 3 {
			entries[0] = target
		}
		raw, _ := json.Marshal(entries)
		if err := keyring.Set(keyService, name, string(raw)); err != nil {
			t.Fatal("fixture credential write failed")
		}
	}
	if same, err := vault.recordTask(id, target, time.Now().Unix()); !same || !errors.Is(err, ErrReadReplay) {
		t.Fatal("replay in fourth candidate was not rejected")
	}
	before := make(map[string]string)
	for bucket, name := range names {
		entries := make([]CompletedTask, 0, 8)
		for i := 0; i < 8; i++ {
			entries = append(entries, CompletedTask{ID: fmt.Sprintf("%08x-1111-4111-8111-111111111111", bucket*16+i), Signature: target.Signature, ExpiresAt: target.ExpiresAt})
		}
		raw, _ := json.Marshal(entries)
		before[name] = string(raw)
		if err := keyring.Set(keyService, name, string(raw)); err != nil {
			t.Fatal("fixture credential write failed")
		}
	}
	if _, err := vault.recordTask(id, target, time.Now().Unix()); err == nil || !strings.Contains(err.Error(), "capacity") {
		t.Fatal("full candidates did not fail closed")
	}
	for _, name := range names {
		raw, err := keyring.Get(keyService, name)
		if err != nil || raw != before[name] {
			t.Fatal("unexpired record changed when all candidates were full")
		}
	}
}
