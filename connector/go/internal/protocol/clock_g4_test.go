package protocol

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestG4ConnectorClockOffsetBoundariesMatchAPI(t *testing.T) {
	raw, err := os.ReadFile("../../testdata/mutation-vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector struct {
		PublicKey string          `json:"publicKey"`
		Message   MutationMessage `json:"message"`
	}
	if err := json.Unmarshal(raw, &vector); err != nil {
		t.Fatal(err)
	}
	for _, offset := range []int64{-86400, -3, -2, 0, 29, 30, 86400} {
		now := vector.Message.IssuedAt + offset
		err := VerifyMutationMessage(vector.Message, vector.Message.ConnectorID, vector.PublicKey, time.Unix(now, 0))
		accepted := offset >= -2 && now < vector.Message.ExpiresAt
		if (err == nil) != accepted {
			t.Fatalf("wrong envelope result for injected offset %d", offset)
		}
	}
}
