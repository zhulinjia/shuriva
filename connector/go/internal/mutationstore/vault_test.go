package mutationstore

import (
	"github.com/zalando/go-keyring"
	"path/filepath"
	"testing"
)

type fakeSecrets map[string]string

func (f fakeSecrets) Get(service, id string) (string, error) {
	v, ok := f[service+"/"+id]
	if !ok {
		return "", keyring.ErrNotFound
	}
	return v, nil
}
func (f fakeSecrets) Set(service, id, value string) error { f[service+"/"+id] = value; return nil }
func (f fakeSecrets) Delete(service, id string) error     { delete(f, service+"/"+id); return nil }
func TestVaultKeepsCredentialsSeparateAndRefusesPartialOrDuplicateSetup(t *testing.T) {
	secrets := fakeSecrets{}
	vault := SystemVault{Secrets: secrets}
	key, _ := NewKey()
	mac, _ := NewKey()
	p := Profile{SourceID: "source", ConnectorID: "connector", WorkspaceIDs: []string{"workspace"}, Writer: Credential{Host: "127.0.0.1", Port: 13308, Database: "isolated", Username: "writer", Password: "write-secret", TLS: "local"}, Recovery: Credential{Host: "127.0.0.1", Port: 13308, Database: "isolated", Username: "recovery", Password: "recover-secret", TLS: "local"}, ManifestPath: filepath.Join(t.TempDir(), "bundle.json"), JournalKey: key, ManifestMACKey: mac}
	if vault.Put(p) != nil {
		t.Fatal("put")
	}
	loaded, err := vault.Get(p.SourceID)
	if err != nil || loaded.Writer.Password != p.Writer.Password || loaded.Recovery.Password != p.Recovery.Password {
		t.Fatal("credential round trip")
	}
	if vault.Put(p) == nil {
		t.Fatal("configuration overwritten")
	}
	partial := Profile{}
	partial.SourceID = "partial"
	if secrets.Set(credentialService, "partial-writer", "surviving evidence") != nil {
		t.Fatal("partial fixture")
	}
	if exists, err := vault.Exists(partial.SourceID); err != nil || !exists {
		t.Fatal("partial configuration disappeared")
	}
	first, err := vault.CreateTargetKeys("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err != nil {
		t.Fatal(err)
	}
	second, err := vault.CreateTargetKeys("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err != nil || first != second {
		t.Fatal("same canonical target acquired independent journal roots")
	}
}
