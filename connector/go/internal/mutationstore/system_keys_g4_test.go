//go:build windows

package mutationstore

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/zalando/go-keyring"
)

func TestG4WindowsCredentialNamespaceRoundTripAndExpiry(t *testing.T) {
	if os.Getenv("STAGE8_G4_KEYRING_TEST") != "1" {
		t.Skip("requires explicit isolated credential test")
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	raw[6] = (raw[6] & 15) | 64
	raw[8] = (raw[8] & 63) | 128
	connector := fmt.Sprintf("%x-%x-%x-%x-%x", raw[:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16])
	if !namespaceConnectorID.MatchString(connector) {
		t.Fatal("invalid test namespace identity")
	}
	target := hex.EncodeToString(raw)
	keysPort, err := NewSystemPackageKeys(connector, target)
	if err != nil {
		t.Fatal(err)
	}
	keys := keysPort.(*SystemPackageKeys)
	id := hex.EncodeToString(bytes.Repeat([]byte{0x43}, 32))
	key := bytes.Repeat([]byte{0x27}, 32)
	if _, _, err := keys.Get(id); !errors.Is(err, ErrPackageExpired) {
		t.Fatal("test credential namespace was not empty")
	}
	t.Cleanup(func() {
		if keys.Delete(id) != nil {
			t.Error("cannot remove owned test package credential")
		}
	})
	deadline := time.Now().Unix() + 3
	if err := keys.Create(id, key, deadline); err != nil {
		t.Fatal("real credential write unavailable")
	}
	if keys.Create(id, key, deadline) == nil {
		t.Fatal("duplicate key was overwritten")
	}
	got, expires, err := keys.Get(id)
	if err != nil || !bytes.Equal(got, key) || expires != deadline {
		t.Fatal("real credential round trip failed")
	}
	names, err := systemPackageKeyNames(keys.namespace + ":")
	if err != nil || len(names) != 1 || names[0] != keys.namespace+":"+id {
		t.Fatal("real filtered enumeration crossed namespace or lost key")
	}
	time.Sleep(time.Until(time.Unix(deadline, 0)) + 20*time.Millisecond)
	if _, _, err := keys.Get(id); !errors.Is(err, ErrPackageExpired) {
		t.Fatal("expired real credential remained usable")
	}
	names, err = systemPackageKeyNames(keys.namespace + ":")
	if err != nil || len(names) != 0 {
		t.Fatal("expired owned credential not removed")
	}

	registry := NewSystemPackageNamespaces()
	account := registryAccount(connector)
	t.Cleanup(func() {
		if err := keyring.Delete(credentialService, account); err != nil && !errors.Is(err, keyring.ErrNotFound) {
			t.Error("cannot remove owned test namespace index")
		}
	})
	for i := 0; i < 32; i++ {
		if err := registry.Register(connector, fmt.Sprintf("%064x", i+1)); err != nil {
			t.Fatal("real credential index cannot hold supported target bound")
		}
	}
	if registry.Register(connector, fmt.Sprintf("%064x", 33)) == nil {
		t.Fatal("namespace limit exceeded")
	}
	targets, err := registry.List(connector)
	if err != nil || len(targets) != 32 {
		t.Fatal("real index lost bounded namespaces")
	}
}
