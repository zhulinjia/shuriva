package mutationstore

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"path/filepath"

	"example.com/ai-database-workspace/connector/internal/mutationconfig"
	"github.com/zalando/go-keyring"
)

const credentialService = "stackoryn-controlled-writes-v1"

var ErrCredentials = mutationconfig.ErrCredentials

// Credential is local only. Do not marshal it into a platform DTO or log it.
type Credential = mutationconfig.Credential
type Profile struct {
	SourceID       string     `json:"sourceId"`
	ConnectorID    string     `json:"connectorId"`
	WorkspaceIDs   []string   `json:"workspaceIds"`
	Writer         Credential `json:"-"`
	Recovery       Credential `json:"-"`
	ManifestPath   string     `json:"manifestPath"`
	ManifestMACKey string     `json:"manifestMACKey"`
	JournalKey     string     `json:"journalKey"`
}
type SecretStore interface {
	Get(string, string) (string, error)
	Set(string, string, string) error
	Delete(string, string) error
}
type systemSecretStore struct{}

func (systemSecretStore) Get(service, id string) (string, error) { return keyring.Get(service, id) }
func (systemSecretStore) Set(service, id, value string) error    { return keyring.Set(service, id, value) }
func (systemSecretStore) Delete(service, id string) error        { return keyring.Delete(service, id) }

type SystemVault struct{ Secrets SecretStore }

type TargetKeys struct {
	JournalKey     string `json:"journalKey"`
	ManifestMACKey string `json:"manifestMACKey"`
}

func (v SystemVault) TargetKeys(target string) (TargetKeys, error) {
	var keys TargetKeys
	if len(target) != 64 {
		return keys, ErrCredentials
	}
	raw, err := v.secrets().Get(credentialService, "target-"+target)
	if err != nil {
		return keys, err
	}
	if json.Unmarshal([]byte(raw), &keys) != nil {
		return keys, ErrCredentials
	}
	if _, err := DecodeKey(keys.JournalKey); err != nil {
		return TargetKeys{}, err
	}
	if _, err := DecodeKey(keys.ManifestMACKey); err != nil {
		return TargetKeys{}, err
	}
	return keys, nil
}
func (v SystemVault) CreateTargetKeys(target string) (TargetKeys, error) {
	if len(target) != 64 {
		return TargetKeys{}, ErrCredentials
	}
	if existing, err := v.TargetKeys(target); err == nil {
		return existing, nil
	} else if !errors.Is(err, keyring.ErrNotFound) {
		return TargetKeys{}, ErrCredentials
	}
	enc, err := NewKey()
	if err != nil {
		return TargetKeys{}, err
	}
	mac, err := NewKey()
	if err != nil {
		return TargetKeys{}, err
	}
	keys := TargetKeys{enc, mac}
	raw, err := json.Marshal(keys)
	if err != nil || v.secrets().Set(credentialService, "target-"+target, string(raw)) != nil {
		return TargetKeys{}, ErrCredentials
	}
	return keys, nil
}

// Exists treats partial configuration as existing forensic evidence. A failed
// setup must not silently overwrite one surviving credential on a retry.
func (v SystemVault) Exists(sourceID string) (bool, error) {
	found := false
	for _, suffix := range []string{"profile", "writer", "recovery"} {
		_, err := v.secrets().Get(credentialService, sourceID+"-"+suffix)
		if err == nil {
			found = true
			continue
		}
		if !errors.Is(err, keyring.ErrNotFound) {
			return true, ErrCredentials
		}
	}
	return found, nil
}

func (v SystemVault) secrets() SecretStore {
	if v.Secrets != nil {
		return v.Secrets
	}
	return systemSecretStore{}
}
func NewKey() (string, error) {
	var key [32]byte
	if _, err := rand.Read(key[:]); err != nil {
		return "", ErrCredentials
	}
	return base64.RawURLEncoding.EncodeToString(key[:]), nil
}
func DecodeKey(raw string) ([]byte, error) {
	key, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(key) != 32 || base64.RawURLEncoding.EncodeToString(key) != raw {
		return nil, ErrCredentials
	}
	return key, nil
}
func (p Profile) Target() mutationconfig.Target {
	return mutationconfig.Target{SourceID: p.SourceID, ConnectorID: p.ConnectorID, WorkspaceIDs: append([]string(nil), p.WorkspaceIDs...), Writer: p.Writer, Recovery: p.Recovery}
}
func (p Profile) Validate() error {
	if p.Target().Validate() != nil || !filepath.IsAbs(p.ManifestPath) {
		return ErrCredentials
	}
	if _, err := DecodeKey(p.ManifestMACKey); err != nil {
		return err
	}
	if _, err := DecodeKey(p.JournalKey); err != nil {
		return err
	}
	return nil
}
func (p Profile) Allows(connector, workspace, source string) bool {
	return p.Target().Allows(connector, workspace, source)
}
func (v SystemVault) Get(sourceID string) (Profile, error) {
	var p Profile
	s := v.secrets()
	raw, err := s.Get(credentialService, sourceID+"-profile")
	if err != nil || len(raw) > 4096 || json.Unmarshal([]byte(raw), &p) != nil || p.SourceID != sourceID {
		return p, ErrCredentials
	}
	for _, part := range []struct {
		name string
		dest *Credential
	}{{"writer", &p.Writer}, {"recovery", &p.Recovery}} {
		raw, err = s.Get(credentialService, sourceID+"-"+part.name)
		if err != nil || len(raw) > 4096 || json.Unmarshal([]byte(raw), part.dest) != nil {
			return Profile{}, ErrCredentials
		}
	}
	if p.Validate() != nil {
		return Profile{}, ErrCredentials
	}
	return p, nil
}

// Put is only called by explicit local configuration while the Connector lock
// is held. Each Windows credential blob is kept below the platform size limit.
func (v SystemVault) Put(p Profile) error {
	if p.Validate() != nil {
		return ErrCredentials
	}
	if exists, err := v.Exists(p.SourceID); err != nil || exists {
		return ErrCredentials
	}
	s := v.secrets()
	for _, part := range []struct {
		name  string
		value any
	}{{"writer", p.Writer}, {"recovery", p.Recovery}, {"profile", p}} {
		raw, err := json.Marshal(part.value)
		if err != nil || len(raw) > 2300 {
			return ErrCredentials
		}
		if s.Set(credentialService, p.SourceID+"-"+part.name, string(raw)) != nil {
			return ErrCredentials
		}
	}
	return nil
}
func (v SystemVault) Delete(sourceID string) error {
	s := v.secrets()
	for _, suffix := range []string{"profile", "writer", "recovery"} {
		if err := s.Delete(credentialService, sourceID+"-"+suffix); err != nil && !errors.Is(err, keyring.ErrNotFound) {
			return ErrCredentials
		}
	}
	return nil
}
