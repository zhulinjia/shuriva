package mutationmysql

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"example.com/ai-database-workspace/connector/internal/mutationguard"
)

// Bundle is a protected local installation/policy artifact. Its content is
// never uploaded to the platform or automatically adopted from a server.
type Bundle struct {
	Manifest Manifest               `json:"manifest"`
	Policies []mutationguard.Policy `json:"policies"`
}

func (b Bundle) Validate() error {
	if b.Manifest.Validate() != nil || len(b.Policies) == 0 || len(b.Policies) > 32 {
		return ErrInstallation
	}
	seen := map[string]bool{}
	commonGeneration := b.Policies[0].Generation
	for _, p := range b.Policies {
		if p.Database != b.Manifest.Spec.Catalog || !hex64.MatchString(p.Generation) || p.Generation != commonGeneration || seen[p.Table] || p.MaxRows < 1 || p.MaxRows > 100 || p.MaxBytes < 1 || p.MaxBytes > 1<<20 || !mutationguard.ValidIdentifier(p.Table) {
			return ErrInstallation
		}
		found := false
		for _, table := range b.Manifest.Spec.Tables {
			if p.Table == table {
				found = true
			}
		}
		if !found {
			return ErrInstallation
		}
		seen[p.Table] = true
	}
	return nil
}
func SealBundle(b Bundle, key []byte) ([]byte, error) {
	if b.Validate() != nil || len(key) != 32 {
		return nil, ErrInstallation
	}
	raw, err := json.Marshal(b)
	if err != nil {
		return nil, ErrInstallation
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("stackoryn-mutation-bundle-v1\x00"))
	mac.Write(raw)
	return json.Marshal(sealedManifest{raw, hex.EncodeToString(mac.Sum(nil))})
}
func ParseBundle(raw, key []byte) (Bundle, error) {
	var b Bundle
	var envelope sealedManifest
	if len(raw) > 1<<20 || len(key) != 32 || strictJSON(raw, &envelope) != nil {
		return b, ErrInstallation
	}
	expected, err := hex.DecodeString(envelope.MAC)
	if err != nil {
		return b, ErrInstallation
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("stackoryn-mutation-bundle-v1\x00"))
	mac.Write(envelope.Manifest)
	if !hmac.Equal(expected, mac.Sum(nil)) || strictJSON(envelope.Manifest, &b) != nil || b.Validate() != nil {
		return Bundle{}, ErrInstallation
	}
	return b, nil
}
