package protocol

import (
	"crypto/ed25519"
	"errors"
	"strconv"
	"strings"
	"time"
)

// ReadCancel can only cancel the exact currently running signed read task.
type ReadCancel struct {
	TaskID      string `json:"taskId"`
	ConnectorID string `json:"connectorId"`
	ActorID     string `json:"actorId"`
	WorkspaceID string `json:"workspaceId"`
	SourceID    string `json:"sourceId"`
	IssuedAt    int64  `json:"issuedAt"`
	ExpiresAt   int64  `json:"expiresAt"`
	Nonce       string `json:"nonce"`
	Signature   string `json:"signature"`
}

func ReadCancelFields(c ReadCancel) []string {
	return []string{"connector-read-v1", "cancel-read", c.TaskID, c.ConnectorID, c.ActorID, c.WorkspaceID, c.SourceID, strconv.FormatInt(c.IssuedAt, 10), strconv.FormatInt(c.ExpiresAt, 10), c.Nonce, "1"}
}

func VerifyReadCancel(c ReadCancel, connectorID, platformKey string, now time.Time) error {
	key, err := Decode(platformKey, ed25519.PublicKeySize)
	if err != nil {
		return errors.New("invalid trusted platform key")
	}
	sig, err := Decode(c.Signature, ed25519.SignatureSize)
	if err != nil || !uuid.MatchString(c.TaskID) || !uuid.MatchString(c.ConnectorID) || c.ConnectorID != connectorID || !actor.MatchString(c.ActorID) || !uuid.MatchString(c.WorkspaceID) || !uuid.MatchString(c.SourceID) {
		return errors.New("invalid read cancellation")
	}
	if _, err = Decode(c.Nonce, 32); err != nil {
		return errors.New("invalid read cancellation")
	}
	current := now.Unix()
	if c.IssuedAt > current+60 || c.ExpiresAt <= current || c.ExpiresAt <= c.IssuedAt || c.ExpiresAt-c.IssuedAt > 60 {
		return errors.New("expired read cancellation")
	}
	if !ed25519.Verify(ed25519.PublicKey(key), []byte(strings.Join(ReadCancelFields(c), "\n")), sig) {
		return errors.New("read cancellation signature invalid")
	}
	return nil
}
