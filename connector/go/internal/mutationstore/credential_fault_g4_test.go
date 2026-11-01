package mutationstore

import (
	"bytes"
	"errors"
	"strings"
	"testing"
	"time"
)

type failingCredentials struct {
	data                fakeSecrets
	read, write, remove error
}

func (s failingCredentials) Get(service, id string) (string, error) {
	if s.read != nil {
		return "", s.read
	}
	return s.data.Get(service, id)
}
func (s failingCredentials) Set(service, id, value string) error {
	if s.write != nil {
		return s.write
	}
	return s.data.Set(service, id, value)
}
func (s failingCredentials) Delete(service, id string) error {
	if s.remove != nil {
		return s.remove
	}
	return s.data.Delete(service, id)
}

// Failures are injected at the OS credential port; no real service is stopped
// and no global credential or disk capacity is consumed.
func TestG4CredentialQuotaAndServiceErrorsNeverBecomeMissingKeys(t *testing.T) {
	id := strings.Repeat("a", 64)
	key := bytes.Repeat([]byte{0x19}, 32)
	deadline := time.Now().Unix() + 60
	for _, point := range []string{"service-read", "quota-write", "service-delete", "enumeration"} {
		t.Run(point, func(t *testing.T) {
			data := fakeSecrets{}
			secrets := failingCredentials{data: data}
			store := &SystemPackageKeys{namespace: "g4-disposable", secrets: secrets, names: func(string) ([]string, error) { return []string{"g4-disposable:" + id}, nil }}
			if err := store.Create(id, key, deadline); err != nil {
				t.Fatal(err)
			}
			outage := errors.New("synthetic credential backend unavailable")
			switch point {
			case "service-read":
				secrets.read = outage
				store.secrets = secrets
				if _, _, err := store.Get(id); !errors.Is(err, ErrCredentials) || errors.Is(err, ErrPackageExpired) {
					t.Fatal("service outage became an absent/expired key")
				}
			case "quota-write":
				secrets.write = outage
				store.secrets = secrets
				if err := store.Create(strings.Repeat("b", 64), key, deadline); !errors.Is(err, ErrCredentials) {
					t.Fatal("quota failure succeeded")
				}
				if len(data) != 1 {
					t.Fatal("quota failure replaced or partially installed a key")
				}
			case "service-delete":
				secrets.remove = outage
				store.secrets = secrets
				if err := store.CleanupExpired(deadline+1, nil); !errors.Is(err, ErrCredentials) {
					t.Fatal("failed credential deletion reported cleanup success")
				}
			case "enumeration":
				store.names = func(string) ([]string, error) { return nil, outage }
				if err := store.CleanupExpired(deadline+1, nil); !errors.Is(err, ErrCredentials) {
					t.Fatal("enumeration failure became an empty namespace")
				}
			}
			store.secrets = failingCredentials{data: data}
			restored, expires, err := store.Get(id)
			if err != nil || expires != deadline || !bytes.Equal(restored, key) {
				t.Fatal("backend recovery lost original key identity")
			}
		})
	}
}
