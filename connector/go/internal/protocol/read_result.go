package protocol

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// ReadResult binds result bytes and all task routing fields to the Connector's
// identity. Payload is sensitive and must never be written to ordinary logs.
type ReadResult struct {
	TaskID      string `json:"taskId"`
	ConnectorID string `json:"connectorId"`
	ActorID     string `json:"actorId"`
	WorkspaceID string `json:"workspaceId"`
	SourceID    string `json:"sourceId"`
	TaskNonce   string `json:"taskNonce"`
	Outcome     string `json:"outcome"`
	Payload     string `json:"payload"`
	Timestamp   int64  `json:"timestamp"`
	Nonce       string `json:"nonce"`
	Signature   string `json:"signature"`
}

func ReadResultFields(r ReadResult) []string {
	hash := sha256.Sum256([]byte(r.Payload))
	return []string{"connector-read-v1", "read-result", r.TaskID, r.ConnectorID, r.ActorID, r.WorkspaceID, r.SourceID, r.TaskNonce, r.Outcome, hex.EncodeToString(hash[:]), strconv.FormatInt(r.Timestamp, 10), r.Nonce, "1"}
}

// NewReadResult accepts encoded result JSON or a fixed non-sensitive failure
// code. Signing does not replace platform-side authorization checks.
func NewReadResult(task ReadTask, outcome, payload string, private ed25519.PrivateKey, now time.Time) (ReadResult, error) {
	var empty ReadResult
	if _, err := Decode(task.Nonce, 32); err != nil {
		return empty, errors.New("invalid read result task nonce")
	}
	if len(private) != ed25519.PrivateKeySize || (outcome != "ok" && outcome != "failed") || len(payload) == 0 || len(payload) > 1_398_102 {
		return empty, errors.New("invalid read result")
	}
	if outcome == "failed" {
		switch payload {
		case "denied", "unavailable", "cancelled", "timeout", "error", "outcome_unknown", "schema_changed":
		default:
			return empty, errors.New("invalid read result")
		}
	} else {
		raw, err := base64.RawURLEncoding.DecodeString(payload)
		if err != nil || len(raw) > 1_048_576 || base64.RawURLEncoding.EncodeToString(raw) != payload || !utf8.Valid(raw) || !json.Valid(raw) {
			return empty, errors.New("invalid read result")
		}
	}
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return empty, err
	}
	result := ReadResult{TaskID: task.ID, ConnectorID: task.ConnectorID, ActorID: task.ActorID, WorkspaceID: task.WorkspaceID, SourceID: task.SourceID, TaskNonce: task.Nonce, Outcome: outcome, Payload: payload, Timestamp: now.Unix(), Nonce: Encode(nonce)}
	result.Signature = Encode(ed25519.Sign(private, []byte(strings.Join(ReadResultFields(result), "\n"))))
	return result, nil
}
