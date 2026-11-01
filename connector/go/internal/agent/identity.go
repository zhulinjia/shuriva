// Package agent implements Connector identity, secure key storage and network lifecycle.
package agent

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"example.com/ai-database-workspace/connector/internal/protocol"
	"github.com/zalando/go-keyring"
)

const keyService = "ai-database-workspace-connector"

type Config struct {
	ConnectorID       string `json:"connectorId"`
	Server            string `json:"server"`
	Name              string `json:"name"`
	PlatformPublicKey string `json:"platformPublicKey"`
}
type KeyState struct {
	Active    string          `json:"active"`
	Pending   string          `json:"pending,omitempty"`
	ReplayKey string          `json:"replayKey,omitempty"`
	Resetting bool            `json:"resetting,omitempty"`
	Completed []CompletedTask `json:"completed,omitempty"`
}
type CompletedTask struct {
	ID        string `json:"id"`
	Signature string `json:"signature"`
	ExpiresAt int64  `json:"expiresAt"`
}
type Vault interface {
	Get(id string) (KeyState, error)
	Set(id string, state KeyState) error
	Delete(id string) error
}
type SystemVault struct{}

func (SystemVault) Get(id string) (KeyState, error) {
	var state KeyState
	raw, err := keyring.Get(keyService, id)
	if err != nil {
		return state, fmt.Errorf("credential store unavailable: %w", err)
	}
	if err = json.Unmarshal([]byte(raw), &state); err != nil {
		return state, errors.New("invalid identity in credential store")
	}
	return state, nil
}
func (SystemVault) Set(id string, state KeyState) error {
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if err = keyring.Set(keyService, id, string(raw)); err != nil {
		return fmt.Errorf("credential store unavailable: %w", err)
	}
	return nil
}
func (SystemVault) Delete(id string) error { return keyring.Delete(keyService, id) }
func ReadConfig(path string) (Config, error) {
	var cfg Config
	raw, err := os.ReadFile(path)
	if err != nil {
		return cfg, err
	}
	if err = json.Unmarshal(raw, &cfg); err != nil {
		return cfg, errors.New("invalid connector configuration")
	}
	if cfg.ConnectorID == "" || cfg.Name == "" {
		return cfg, errors.New("invalid connector configuration")
	}
	if _, err = protocol.Decode(cfg.PlatformPublicKey, ed25519.PublicKeySize); err != nil {
		return cfg, errors.New("missing or invalid trusted platform key; re-pair required")
	}
	if _, err = validateServer(cfg.Server); err != nil {
		return cfg, err
	}
	return cfg, nil
}
func WriteConfig(path string, cfg Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	raw, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return fmt.Errorf("connector already configured or cannot create config: %w", err)
	}
	if _, err = f.Write(raw); err != nil {
		f.Close()
		os.Remove(path)
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		os.Remove(path)
		return err
	}
	return f.Close()
}
func DefaultConfigPath() (string, error) {
	if custom := os.Getenv("CONNECTOR_CONFIG_PATH"); custom != "" {
		return custom, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "ai-database-workspace", "connector.json"), nil
}
func newID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
func newKey() (ed25519.PrivateKey, string, error) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, "", err
	}
	return private, protocol.Encode(public), nil
}
func privateKey(encoded string) (ed25519.PrivateKey, error) {
	b, err := protocol.Decode(encoded, ed25519.PrivateKeySize)
	if err != nil {
		return nil, errors.New("invalid connector identity")
	}
	expected := ed25519.NewKeyFromSeed(b[:ed25519.SeedSize])
	if subtle.ConstantTimeCompare(b, expected) != 1 {
		return nil, errors.New("connector identity is corrupted")
	}
	return ed25519.PrivateKey(b), nil
}
func publicKey(private ed25519.PrivateKey) string {
	return protocol.Encode(private.Public().(ed25519.PublicKey))
}
func validName(name string) bool {
	if !utf8.ValidString(name) || len(utf16.Encode([]rune(name))) < 1 || len(utf16.Encode([]rune(name))) > 120 {
		return false
	}
	return !strings.ContainsFunc(name, func(r rune) bool { return r < 32 || r == 127 })
}
