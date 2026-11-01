package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/protocol"
	"github.com/zalando/go-keyring"
)

type resetFixture struct {
	state       KeyState
	exists      bool
	shards      int
	failCleanup bool
	failDelete  bool
	failSet     bool
}

func (v *resetFixture) Get(string) (KeyState, error) {
	if !v.exists {
		return KeyState{}, keyring.ErrNotFound
	}
	return v.state, nil
}
func (v *resetFixture) Set(_ string, state KeyState) error {
	if v.failSet {
		return errors.New("fixture write failure")
	}
	v.state = state
	v.exists = true
	return nil
}

func TestResetDoesNotDeleteReplayIfInvalidationFails(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	cfg := Config{ConnectorID: "11111111-1111-4111-8111-111111111111", Server: "http://localhost:12345", Name: "fixture", PlatformPublicKey: protocol.Encode(public)}
	path := filepath.Join(t.TempDir(), "config.json")
	if err := WriteConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	vault := &resetFixture{exists: true, state: KeyState{Active: protocol.Encode(private)}, shards: 3, failSet: true}
	if err := Reset(path, vault); err == nil {
		t.Fatal("failed invalidation was accepted")
	}
	if !vault.exists || vault.state.Active == "" || vault.shards != 3 {
		t.Fatal("replay state was deleted before invalidating identity")
	}
}
func (v *resetFixture) Delete(string) error {
	if !v.exists {
		return keyring.ErrNotFound
	}
	v.exists = false
	if v.failDelete {
		v.failDelete = false
		return errors.New("fixture delete failed after deletion")
	}
	return nil
}
func (v *resetFixture) deleteReplay(string) error {
	if v.failCleanup {
		v.failCleanup = false
		v.shards--
		return errors.New("fixture partial cleanup")
	}
	v.shards = 0
	return nil
}

func TestResetInvalidatesIdentityBeforePartialCleanup(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	cfg := Config{ConnectorID: "11111111-1111-4111-8111-111111111111", Server: "http://localhost:12345", Name: "fixture", PlatformPublicKey: protocol.Encode(public)}
	path := filepath.Join(t.TempDir(), "config.json")
	if err := WriteConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	vault := &resetFixture{exists: true, state: KeyState{Active: protocol.Encode(private), ReplayKey: protocol.Encode(make([]byte, 32))}, shards: 3, failCleanup: true}
	if err := Reset(path, vault); err == nil {
		t.Fatal("partial cleanup did not fail")
	}
	if !vault.exists || !vault.state.Resetting || vault.state.Active != "" || vault.shards != 2 {
		t.Fatal("identity remained usable after partial cleanup")
	}
	client, _ := NewClient(cfg.Server, "test")
	if err := Sync(context.Background(), client, cfg, vault); err == nil || !strings.Contains(err.Error(), "reset") {
		t.Fatalf("reset identity could still sync: %v", err)
	}
	if _, err := recordTask(vault, cfg.ConnectorID, CompletedTask{ID: cfg.ConnectorID, Signature: "x", ExpiresAt: time.Now().Unix() + 60}, time.Now().Unix()); err == nil {
		t.Fatal("reset identity accepted new task")
	}
	if err := Reset(path, vault); err != nil {
		t.Fatal(err)
	}
	if vault.exists || vault.shards != 0 {
		t.Fatal("reset retry did not finish")
	}
}

func TestResetRetriesAfterIdentityDeleteResponseLost(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	cfg := Config{ConnectorID: "11111111-1111-4111-8111-111111111111", Server: "http://localhost:12345", Name: "fixture", PlatformPublicKey: protocol.Encode(public)}
	path := filepath.Join(t.TempDir(), "config.json")
	if err := WriteConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	vault := &resetFixture{exists: true, state: KeyState{Active: protocol.Encode(private)}, shards: 2, failDelete: true}
	if err := Reset(path, vault); err == nil {
		t.Fatal("expected uncertain deletion")
	}
	if vault.exists || vault.shards != 0 {
		t.Fatal("fixture deletion did not occur")
	}
	if err := Reset(path, vault); err != nil {
		t.Fatalf("reset retry failed: %v", err)
	}
}
