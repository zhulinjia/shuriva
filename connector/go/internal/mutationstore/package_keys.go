package mutationstore

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	"fmt"
	"github.com/zalando/go-keyring"
	"regexp"
	"strings"
	"sync"
	"time"
)

var ErrPackageExpired = fmt.Errorf("%w: reconciliation package key unavailable or expired", mutationrunner.ErrNotFound)
var packageID = regexp.MustCompile(`^[0-9a-f]{64}$`)

// PackageKeyStore is independent from bbolt. Restoring old database pages
// cannot restore an expired/deleted package key. No implementation is chosen
// implicitly: test composition must pass a fake and production passes the
// current Connector/target's OS-credential namespace explicitly.
type PackageKeyStore interface {
	Create(id string, key []byte, hardExpiresAt int64) error
	Get(id string) ([]byte, int64, error)
	Delete(id string) error
	CleanupExpired(nowUnix int64, protectedIDs []string) error
}
type packageSecret struct {
	Format        string `json:"format"`
	ID            string `json:"id"`
	Key           string `json:"key"`
	HardExpiresAt int64  `json:"hardExpiresAt"`
}
type SystemPackageKeys struct {
	namespace string
	secrets   SecretStore
	names     func(string) ([]string, error)
}

func NewSystemPackageKeys(connector, target string) (PackageKeyStore, error) {
	if connector == "" || len(connector) > 64 || !packageID.MatchString(target) {
		return nil, ErrCredentials
	}
	hash := sha256.Sum256([]byte(connector + "\x00" + target))
	return &SystemPackageKeys{namespace: "stackoryn-packet-v1-" + hex.EncodeToString(hash[:]), secrets: systemSecretStore{}, names: systemPackageKeyNames}, nil
}
func (s *SystemPackageKeys) Create(id string, key []byte, expires int64) error {
	if !packageID.MatchString(id) || len(key) != 32 || expires <= time.Now().Unix() {
		return ErrCredentials
	}
	if _, err := s.secrets.Get(s.namespace, id); !errors.Is(err, keyring.ErrNotFound) {
		return ErrCredentials
	}
	raw, err := json.Marshal(packageSecret{"stackoryn-packet-key-v1", id, base64.RawURLEncoding.EncodeToString(key), expires})
	if err != nil || s.secrets.Set(s.namespace, id, string(raw)) != nil {
		return ErrCredentials
	}
	return nil
}
func (s *SystemPackageKeys) read(id string) (packageSecret, error) {
	var entry packageSecret
	if !packageID.MatchString(id) {
		return entry, ErrCredentials
	}
	raw, err := s.secrets.Get(s.namespace, id)
	if errors.Is(err, keyring.ErrNotFound) {
		return entry, ErrPackageExpired
	}
	if err != nil || len(raw) > 512 || json.Unmarshal([]byte(raw), &entry) != nil || entry.Format != "stackoryn-packet-key-v1" || entry.ID != id || entry.HardExpiresAt <= 0 {
		return entry, ErrCredentials
	}
	key, err := base64.RawURLEncoding.DecodeString(entry.Key)
	if err != nil || len(key) != 32 || base64.RawURLEncoding.EncodeToString(key) != entry.Key {
		return entry, ErrCredentials
	}
	for i := range key {
		key[i] = 0
	}
	return entry, nil
}
func (s *SystemPackageKeys) Get(id string) ([]byte, int64, error) {
	entry, err := s.read(id)
	if err != nil {
		return nil, 0, err
	}
	if entry.HardExpiresAt <= time.Now().Unix() {
		if err = s.Delete(id); err != nil {
			return nil, 0, err
		}
		return nil, entry.HardExpiresAt, ErrPackageExpired
	}
	key, err := base64.RawURLEncoding.DecodeString(entry.Key)
	if err != nil {
		return nil, 0, ErrCredentials
	}
	return key, entry.HardExpiresAt, nil
}
func (s *SystemPackageKeys) Delete(id string) error {
	if !packageID.MatchString(id) {
		return ErrCredentials
	}
	err := s.secrets.Delete(s.namespace, id)
	if err != nil && !errors.Is(err, keyring.ErrNotFound) {
		return ErrCredentials
	}
	return nil
}
func (s *SystemPackageKeys) CleanupExpired(now int64, protected []string) error {
	if now <= 0 || len(protected) > 512 {
		return ErrCredentials
	}
	active := map[string]bool{}
	for _, id := range protected {
		if !packageID.MatchString(id) || active[id] {
			return ErrCredentials
		}
		active[id] = true
	}
	prefix := s.namespace + ":"
	names, err := s.names(prefix)
	if err != nil || len(names) > 4096 {
		return ErrCredentials
	}
	for _, name := range names {
		id, ok := strings.CutPrefix(name, prefix)
		if !ok || !packageID.MatchString(id) {
			return ErrCredentials
		}
		entry, err := s.read(id)
		if errors.Is(err, ErrPackageExpired) {
			continue
		}
		if err != nil {
			return err
		}
		if entry.HardExpiresAt <= now {
			if err = s.Delete(id); err != nil {
				return err
			}
		}
	}
	return nil
}

// MemoryPackageKeys is a deterministic dependency for tests and isolated
// composition. Production never defaults to it, and it starts empty on restart.
type MemoryPackageKeys struct {
	mu      sync.Mutex
	entries map[string]memoryPackage
}
type memoryPackage struct {
	key     []byte
	expires int64
}

func NewMemoryPackageKeys() *MemoryPackageKeys {
	return &MemoryPackageKeys{entries: map[string]memoryPackage{}}
}
func (s *MemoryPackageKeys) Create(id string, key []byte, expires int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !packageID.MatchString(id) || len(key) != 32 || expires <= time.Now().Unix() {
		return ErrCredentials
	}
	if _, found := s.entries[id]; found {
		return ErrCredentials
	}
	s.entries[id] = memoryPackage{append([]byte(nil), key...), expires}
	return nil
}
func (s *MemoryPackageKeys) Get(id string) ([]byte, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, found := s.entries[id]
	if !found {
		return nil, 0, ErrPackageExpired
	}
	if entry.expires <= time.Now().Unix() {
		delete(s.entries, id)
		return nil, entry.expires, ErrPackageExpired
	}
	return append([]byte(nil), entry.key...), entry.expires, nil
}
func (s *MemoryPackageKeys) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if entry, found := s.entries[id]; found {
		for i := range entry.key {
			entry.key[i] = 0
		}
		delete(s.entries, id)
	}
	return nil
}
func (s *MemoryPackageKeys) CleanupExpired(now int64, _ []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, entry := range s.entries {
		if entry.expires <= now {
			for i := range entry.key {
				entry.key[i] = 0
			}
			delete(s.entries, id)
		}
	}
	return nil
}
func newPackageKey() (string, []byte, error) {
	var key, id [32]byte
	if _, err := rand.Read(key[:]); err != nil {
		return "", nil, ErrJournal
	}
	if _, err := rand.Read(id[:]); err != nil {
		return "", nil, ErrJournal
	}
	return hex.EncodeToString(id[:]), key[:], nil
}
