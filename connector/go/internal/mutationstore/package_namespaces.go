package mutationstore

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"sort"
	"sync"

	"github.com/zalando/go-keyring"
)

// PackageNamespaceRegistry contains only Connector IDs and trusted target
// identities. It lets startup/tickers expire package keys even when a journal
// cannot open. Register must precede key creation and may only receive an
// identity derived from a locally verified installation bundle.
type PackageNamespaceRegistry interface {
	List(connectorID string) ([]string, error)
	Register(connectorID, targetIdentity string) error
}

const namespaceRegistryFormat = "stackoryn-package-namespaces-v1"
const maxPackageTargets = 32
const maxNamespaceBlob = 2300 // below Windows' 2560-byte credential limit

var namespaceConnectorID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type namespaceIndex struct {
	Format      string   `json:"format"`
	ConnectorID string   `json:"connectorId"`
	Targets     []string `json:"targets"`
}

// PackageNamespaces serializes read/modify/write in one runtime instance.
// Across processes, the owner must hold the existing Connector configuration
// lock, just like credential/policy updates; the OS credential API has no CAS.
type PackageNamespaces struct {
	mu      sync.Mutex
	secrets SecretStore
}

func NewSystemPackageNamespaces() PackageNamespaceRegistry {
	return &PackageNamespaces{secrets: systemSecretStore{}}
}

// NewPackageNamespacesWithSecrets supports explicit failure-isolated tests.
// There is deliberately no nil-to-system fallback.
func NewPackageNamespacesWithSecrets(secrets SecretStore) (*PackageNamespaces, error) {
	if secrets == nil {
		return nil, ErrCredentials
	}
	return &PackageNamespaces{secrets: secrets}, nil
}

func NewMemoryPackageNamespaces() PackageNamespaceRegistry {
	return &PackageNamespaces{secrets: namespaceMemorySecrets{values: map[string]string{}}}
}

func registryAccount(connectorID string) string { return "package-namespaces-" + connectorID }

func (r *PackageNamespaces) read(connectorID string) (namespaceIndex, error) {
	index := namespaceIndex{Format: namespaceRegistryFormat, ConnectorID: connectorID, Targets: []string{}}
	if r == nil || r.secrets == nil || !namespaceConnectorID.MatchString(connectorID) {
		return index, ErrCredentials
	}
	raw, err := r.secrets.Get(credentialService, registryAccount(connectorID))
	if errors.Is(err, keyring.ErrNotFound) {
		return index, nil
	}
	index = namespaceIndex{}
	decoder := json.NewDecoder(bytes.NewBufferString(raw))
	decoder.DisallowUnknownFields()
	decodeErr := decoder.Decode(&index)
	var trailing any
	if err != nil || len(raw) > maxNamespaceBlob || decodeErr != nil || decoder.Decode(&trailing) != io.EOF ||
		index.Format != namespaceRegistryFormat || index.ConnectorID != connectorID || index.Targets == nil || len(index.Targets) > maxPackageTargets {
		return namespaceIndex{}, ErrCredentials
	}
	seen := map[string]bool{}
	for _, target := range index.Targets {
		if !packageID.MatchString(target) || seen[target] {
			return namespaceIndex{}, ErrCredentials
		}
		seen[target] = true
	}
	return index, nil
}

func (r *PackageNamespaces) List(connectorID string) ([]string, error) {
	if r == nil {
		return nil, ErrCredentials
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	index, err := r.read(connectorID)
	if err != nil {
		return nil, err
	}
	result := append([]string{}, index.Targets...)
	sort.Strings(result)
	return result, nil
}

func (r *PackageNamespaces) Register(connectorID, target string) error {
	if r == nil || !packageID.MatchString(target) {
		return ErrCredentials
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	index, err := r.read(connectorID)
	if err != nil {
		return err
	}
	for _, prior := range index.Targets {
		if prior == target {
			return nil
		}
	}
	if len(index.Targets) >= maxPackageTargets {
		return ErrCredentials
	}
	index.Targets = append(index.Targets, target)
	sort.Strings(index.Targets)
	raw, err := json.Marshal(index)
	if err != nil || len(raw) > maxNamespaceBlob || r.secrets.Set(credentialService, registryAccount(connectorID), string(raw)) != nil {
		return ErrCredentials
	}
	// Read back before allowing the caller to create a key. An unavailable or
	// truncated credential write cannot silently lose namespace ownership.
	verified, err := r.read(connectorID)
	if err != nil {
		return err
	}
	for _, present := range verified.Targets {
		if present == target {
			return nil
		}
	}
	return ErrCredentials
}

type namespaceMemorySecrets struct{ values map[string]string }

func (s namespaceMemorySecrets) Get(service, id string) (string, error) {
	value, ok := s.values[service+":"+id]
	if !ok {
		return "", keyring.ErrNotFound
	}
	return value, nil
}
func (s namespaceMemorySecrets) Set(service, id, value string) error {
	s.values[service+":"+id] = value
	return nil
}
func (s namespaceMemorySecrets) Delete(service, id string) error {
	delete(s.values, service+":"+id)
	return nil
}

var _ PackageNamespaceRegistry = (*PackageNamespaces)(nil)
