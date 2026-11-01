package agent

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/protocol"
	"github.com/zalando/go-keyring"
)

func TestReplayRecordSupportsConcurrentVolumeAndRejectsConflict(t *testing.T) {
	id := "22222222-2222-4222-8222-222222222222"
	vault := &memoryVault{data: map[string]KeyState{id: {Active: "fixture"}}}
	now := time.Now().Unix()
	var first CompletedTask
	for i := 0; i < 100; i++ {
		task := CompletedTask{ID: fmt.Sprintf("%08x-1111-4111-8111-111111111111", i), Signature: "same", ExpiresAt: now + 60}
		if i == 0 {
			first = task
		}
		if _, err := recordTask(vault, id, task, now); err != nil {
			t.Fatalf("task %d: %v", i, err)
		}
	}
	if same, err := recordTask(vault, id, first, now); !same || !errors.Is(err, ErrReadReplay) {
		t.Fatal("replay not rejected")
	}
	first.Signature = "different"
	if same, err := recordTask(vault, id, first, now); same || !errors.Is(err, ErrReadReplay) {
		t.Fatal("conflicting replay not rejected")
	}
}

func TestSystemReplayShardsFitCredentialStore(t *testing.T) {
	if os.Getenv("STAGE3_KEYRING_TEST") != "1" {
		t.Skip("requires operating system credential store")
	}
	id, err := newID()
	if err != nil {
		t.Fatal(err)
	}
	vault := SystemVault{}
	secret := []byte(strings.Repeat("a", 32))
	if err = vault.Set(id, KeyState{Active: "synthetic-fixture", ReplayKey: protocol.Encode(secret)}); err != nil {
		t.Fatal(err)
	}
	used := map[string]bool{}
	defer func() {
		for name := range used {
			_ = keyring.Delete(keyService, name)
		}
		_ = vault.Delete(id)
	}()
	now := time.Now().Unix()
	for i := 0; i < 32; i++ {
		task := CompletedTask{ID: fmt.Sprintf("aa%06x-1111-4111-8111-111111111111", i), Signature: protocol.Encode(make([]byte, 64)), ExpiresAt: now + 60}
		for _, name := range replayKeys(id, task.ID, secret) {
			used[name] = true
		}
		if _, err = vault.recordTask(id, task, now); err != nil {
			t.Fatalf("task %d: %v", i, err)
		}
	}
	var colliding []CompletedTask
	var primary string
	for i := 0; i < 200000 && len(colliding) < 12; i++ {
		task := CompletedTask{ID: fmt.Sprintf("bb%06x-1111-4111-8111-111111111111", i), Signature: protocol.Encode(make([]byte, 64)), ExpiresAt: now + 60}
		keys := replayKeys(id, task.ID, secret)
		if primary == "" {
			primary = keys[0]
		}
		if keys[0] != primary {
			continue
		}
		for _, name := range keys {
			used[name] = true
		}
		if _, err = vault.recordTask(id, task, now); err != nil {
			t.Fatalf("same primary bucket task %d: %v", len(colliding), err)
		}
		colliding = append(colliding, task)
	}
	if len(colliding) != 12 {
		t.Fatal("failed to create collision fixture")
	}
	for _, task := range colliding {
		if same, err := vault.recordTask(id, task, now); !same || !errors.Is(err, ErrReadReplay) {
			t.Fatal("candidate shard replay accepted")
		}
	}
	probe := CompletedTask{ID: "cc000000-1111-4111-8111-111111111111", Signature: protocol.Encode(make([]byte, 64)), ExpiresAt: now + 60}
	keys := replayKeys(id, probe.ID, secret)
	for _, name := range keys {
		used[name] = true
	}
	corruptions := []string{"null", `[{}]`, `[{"id":"cc000000-1111-4111-8111-111111111111","signature":"bad","expiresAt":0}]`}
	for _, raw := range corruptions {
		if err := keyring.Set(keyService, keys[0], raw); err != nil {
			t.Fatal(err)
		}
		if _, err := vault.recordTask(id, probe, now); err == nil {
			t.Fatal("corrupted replay shard was accepted")
		}
	}
	if err := vault.deleteReplay(id); err != nil {
		t.Fatalf("reset replay state: %v", err)
	}
}
