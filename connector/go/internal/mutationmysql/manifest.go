package mutationmysql

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"sort"
)

func (m Manifest) Validate() error {
	if m.Format != "stackoryn-mutation-installation-v1" || m.ServerVersion != "26.7.0" || m.ServerUUID == "" || m.LowerCase != 1 {
		return ErrInstallation
	}
	p, err := BuildInstallation(m.Spec)
	if err != nil || p.ControlCatalog != m.ControlCatalog || p.Definer != m.Definer || m.TemplateHash != templateHash(p) || len(m.Definitions) != len(p.Routines) || len(m.ControlDefinitions) != 2 || m.ControlDefinitions["gate"] == "" || m.ControlDefinitions["receipts"] == "" {
		return ErrInstallation
	}
	for _, r := range p.Routines {
		if m.Definitions[r.Name].CreateSQL == "" {
			return ErrInstallation
		}
	}
	for _, pair := range []struct{ actual, want []string }{{m.DefinerGrants, expectedGrants(p, p.Definer, "definer")}, {m.WriterGrants, expectedGrants(p, p.Spec.Writer, "writer")}, {m.RecoveryGrants, expectedGrants(p, p.Spec.Recovery, "recovery")}} {
		if !sameStrings(pair.actual, pair.want) {
			return ErrInstallation
		}
	}
	return nil
}
func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	a = append([]string(nil), a...)
	b = append([]string(nil), b...)
	sort.Strings(a)
	sort.Strings(b)
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

type sealedManifest struct {
	Manifest json.RawMessage `json:"manifest"`
	MAC      string          `json:"mac"`
}

func SealManifest(m Manifest, key []byte) ([]byte, error) {
	if len(key) != 32 || m.Validate() != nil {
		return nil, ErrInstallation
	}
	raw, err := json.Marshal(m)
	if err != nil {
		return nil, ErrInstallation
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("stackoryn-mutation-installation-v1\x00"))
	mac.Write(raw)
	return json.Marshal(sealedManifest{raw, hex.EncodeToString(mac.Sum(nil))})
}
func ParseManifest(raw, key []byte) (Manifest, error) {
	var m Manifest
	var envelope sealedManifest
	if len(raw) > 1<<20 || len(key) != 32 || strictJSON(raw, &envelope) != nil || !hex64.MatchString(envelope.MAC) {
		return m, ErrInstallation
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("stackoryn-mutation-installation-v1\x00"))
	mac.Write(envelope.Manifest)
	expected, _ := hex.DecodeString(envelope.MAC)
	if !hmac.Equal(mac.Sum(nil), expected) || strictJSON(envelope.Manifest, &m) != nil || m.Validate() != nil {
		return Manifest{}, ErrInstallation
	}
	return m, nil
}
func strictJSON(raw []byte, dest any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dest); err != nil {
		return ErrInstallation
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return ErrInstallation
	}
	return nil
}
