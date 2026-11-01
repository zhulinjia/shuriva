package mutationstore

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

const registryConnector = "04abef13-71e1-4e58-866b-23b91ada1234"

func TestPackageNamespaceRegistrationConcurrentBoundedAndConnectorScoped(t *testing.T) {
	secrets := fakeSecrets{}
	r, err := NewPackageNamespacesWithSecrets(secrets)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	failures := make(chan error, 64)
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := r.Register(registryConnector, fmt.Sprintf("%064x", i%32+1)); err != nil {
				failures <- err
			}
		}(i)
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
	items, err := r.List(registryConnector)
	if err != nil || len(items) != 32 {
		t.Fatalf("lost registered targets: count=%d err=%v", len(items), err)
	}
	for i, target := range items {
		if target != fmt.Sprintf("%064x", i+1) {
			t.Fatal("registry ordering or uniqueness invalid")
		}
	}
	if len(secrets[credentialService+"/"+registryAccount(registryConnector)]) > maxNamespaceBlob {
		t.Fatal("registry exceeded Windows credential limit")
	}
	if r.Register(registryConnector, fmt.Sprintf("%064x", 33)) == nil {
		t.Fatal("unbounded registry accepted")
	}
	items[0] = "mutated caller slice"
	again, _ := r.List(registryConnector)
	if again[0] == items[0] {
		t.Fatal("caller mutated trusted registry")
	}
	other := "14abef13-71e1-4e58-866b-23b91ada1234"
	foreign, err := r.List(other)
	if err != nil || len(foreign) != 0 {
		t.Fatal("registry leaked another Connector's target")
	}
}

type unavailableNamespaceSecrets struct{}

func (unavailableNamespaceSecrets) Get(string, string) (string, error) {
	return "", errors.New("credential service unavailable")
}
func (unavailableNamespaceSecrets) Set(string, string, string) error {
	return errors.New("credential service unavailable")
}
func (unavailableNamespaceSecrets) Delete(string, string) error {
	return errors.New("credential service unavailable")
}

func TestPackageNamespaceMalformedOrUnavailableRegistryFailsClosed(t *testing.T) {
	target := fmt.Sprintf("%064x", 1)
	for _, raw := range []string{"{}", `{"format":"stackoryn-package-namespaces-v1","connectorId":"` + registryConnector + `","targets":null}`, `{"format":"stackoryn-package-namespaces-v1","connectorId":"` + registryConnector + `"}`, `{"format":"stackoryn-package-namespaces-v1","connectorId":"` + registryConnector + `","targets":["invalid"]}`} {
		secrets := fakeSecrets{credentialService + "/" + registryAccount(registryConnector): raw}
		registry, _ := NewPackageNamespacesWithSecrets(secrets)
		if _, err := registry.List(registryConnector); err == nil {
			t.Fatal("malformed registry became empty trusted state")
		}
		if registry.Register(registryConnector, target) == nil {
			t.Fatal("malformed registry overwritten")
		}
	}
	registry, _ := NewPackageNamespacesWithSecrets(unavailableNamespaceSecrets{})
	if _, err := registry.List(registryConnector); err == nil {
		t.Fatal("unavailable registry became empty state")
	}
	if registry.Register(registryConnector, target) == nil {
		t.Fatal("unavailable registration accepted")
	}
	if _, err := NewPackageNamespacesWithSecrets(nil); err == nil {
		t.Fatal("nil test store fell back to real credential storage")
	}
	if NewMemoryPackageNamespaces().Register("invalid connector", target) == nil {
		t.Fatal("invalid namespace owner accepted")
	}
}

// The registry and independent key metadata can be processed without opening
// or even knowing a journal path. This models the manager's failed-open path.
func TestRegisteredNamespaceExpiresPackageWithoutReadableJournal(t *testing.T) {
	registry := NewMemoryPackageNamespaces()
	target := fmt.Sprintf("%064x", 1)
	if registry.Register(registryConnector, target) != nil {
		t.Fatal("register")
	}
	secrets := fakeSecrets{"other-service:untouched": "outside owned namespace"}
	id := fmt.Sprintf("%064x", 2)
	keyStore := &SystemPackageKeys{namespace: "owned-registered-test", secrets: secrets, names: func(prefix string) ([]string, error) { return []string{prefix + id}, nil }}
	key := make([]byte, 32)
	key[0] = 7
	now := time.Now().Unix()
	if keyStore.Create(id, key, now+60) != nil {
		t.Fatal("key setup")
	}
	listed, err := registry.List(registryConnector)
	if err != nil || len(listed) != 1 || listed[0] != target {
		t.Fatal("startup lost trusted namespace")
	}
	// No bbolt Store is created/opened. Only the registered namespace's
	// independent fixed-expiry metadata grants this cleanup operation.
	if err := keyStore.CleanupExpired(now+61, nil); err != nil {
		t.Fatal(err)
	}
	if _, _, err := keyStore.Get(id); !errors.Is(err, ErrPackageExpired) {
		t.Fatal("unreadable journal prevented expired key removal")
	}
	if secrets["other-service:untouched"] != "outside owned namespace" {
		t.Fatal("cleanup crossed a credential namespace")
	}
	badIndex := namespaceIndex{Format: namespaceRegistryFormat, ConnectorID: registryConnector, Targets: []string{target, target}}
	raw, _ := json.Marshal(badIndex)
	fault := fakeSecrets{credentialService + "/" + registryAccount(registryConnector): string(raw)}
	broken, _ := NewPackageNamespacesWithSecrets(fault)
	if _, err := broken.List(registryConnector); err == nil {
		t.Fatal("duplicate targets in index accepted")
	}
}
