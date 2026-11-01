package protocol

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

func TestSharedContractVector(t *testing.T) {
	raw, err := os.ReadFile("../../../testdata/protocol-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Seed      string `json:"seed"`
		Pair      Pair   `json:"pair"`
		Heartbeat Signed `json:"heartbeat"`
		Rotate    Rotate `json:"rotate"`
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	seed, err := hex.DecodeString(fixture.Seed)
	if err != nil {
		t.Fatal(err)
	}
	private := ed25519.NewKeyFromSeed(seed)
	if Encode(private.Public().(ed25519.PublicKey)) != fixture.Pair.PublicKey {
		t.Fatal("public key differs")
	}
	beatSig := fixture.Heartbeat.Signature
	SignHeartbeat(&fixture.Heartbeat, private)
	if fixture.Heartbeat.Signature != beatSig {
		t.Error("heartbeat signature differs")
	}
	rotateSig := fixture.Rotate.Signature
	SignRotation(&fixture.Rotate, private)
	if fixture.Rotate.Signature != rotateSig {
		t.Error("rotation signature differs")
	}
}

func TestPairV2SharedContractVector(t *testing.T) {
	raw, err := os.ReadFile("../../../testdata/pair-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Seed   string `json:"seed"`
		Secret string `json:"secret"`
		Pair   Pair   `json:"pair"`
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	seed, err := hex.DecodeString(fixture.Seed)
	if err != nil {
		t.Fatal(err)
	}
	private := ed25519.NewKeyFromSeed(seed)
	if Encode(private.Public().(ed25519.PublicKey)) != fixture.Pair.PublicKey {
		t.Fatal("public key differs")
	}
	proof, signature := fixture.Pair.Proof, fixture.Pair.Signature
	SignPair(&fixture.Pair, fixture.Secret, private)
	if fixture.Pair.Proof != proof || fixture.Pair.Signature != signature {
		t.Fatal("pair v2 proof or signature differs")
	}
}
