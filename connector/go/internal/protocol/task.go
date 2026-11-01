package protocol

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var uuid = regexp.MustCompile("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
var actor = regexp.MustCompile("^[A-Za-z0-9._:-]{1,128}$")

// Task is the only task supported in phase 2: a signed, data-free diagnostic.
type Task struct {
	ID          string `json:"id"`
	ConnectorID string `json:"connectorId"`
	ActorID     string `json:"actorId"`
	WorkspaceID string `json:"workspaceId,omitempty"`
	SourceID    string `json:"sourceId,omitempty"`
	Operation   string `json:"operation"`
	Payload     string `json:"payload,omitempty"`
	IssuedAt    int64  `json:"issuedAt"`
	ExpiresAt   int64  `json:"expiresAt"`
	Nonce       string `json:"nonce"`
	Protocol    int    `json:"protocol"`
	Signature   string `json:"signature"`
}

func TaskFields(t Task) []string {
	if t.Operation == "schema_scan" {
		return []string{"connector-v2", "schema-scan", t.ID, t.ConnectorID, t.ActorID, t.WorkspaceID, t.SourceID, strconv.FormatInt(t.IssuedAt, 10), strconv.FormatInt(t.ExpiresAt, 10), t.Nonce, "2"}
	}
	return []string{"connector-v1", "task", t.ID, t.ConnectorID, t.ActorID, t.Operation, strconv.FormatInt(t.IssuedAt, 10), strconv.FormatInt(t.ExpiresAt, 10), t.Nonce, strconv.Itoa(t.Protocol)}
}
func VerifyTask(t Task, connectorID, platformKey string, now time.Time) error {
	if t.Operation == "read_query" || t.Operation == "model_schema" || t.Operation == "model_authorize" {
		_, err := VerifyReadTask(ReadTask{ID: t.ID, ConnectorID: t.ConnectorID, ActorID: t.ActorID, WorkspaceID: t.WorkspaceID, SourceID: t.SourceID, Operation: t.Operation, Payload: t.Payload, IssuedAt: t.IssuedAt, ExpiresAt: t.ExpiresAt, Nonce: t.Nonce, Protocol: t.Protocol, Signature: t.Signature}, connectorID, platformKey, now)
		return err
	}
	if t.Operation == "cancel_read" {
		if t.Protocol != 1 || t.Payload != "" {
			return errors.New("unsupported or invalid task")
		}
		return VerifyReadCancel(ReadCancel{TaskID: t.ID, ConnectorID: t.ConnectorID, ActorID: t.ActorID, WorkspaceID: t.WorkspaceID, SourceID: t.SourceID, IssuedAt: t.IssuedAt, ExpiresAt: t.ExpiresAt, Nonce: t.Nonce, Signature: t.Signature}, connectorID, platformKey, now)
	}
	key, err := Decode(platformKey, ed25519.PublicKeySize)
	if err != nil {
		return errors.New("invalid trusted platform key")
	}
	signature, err := Decode(t.Signature, ed25519.SignatureSize)
	if err != nil {
		return errors.New("invalid task signature")
	}
	if !uuid.MatchString(t.ID) || !uuid.MatchString(t.ConnectorID) || t.ConnectorID != connectorID || !actor.MatchString(t.ActorID) {
		return errors.New("unsupported or invalid task")
	}
	if t.Operation == "diagnostic" {
		if t.Protocol != Version || t.WorkspaceID != "" || t.SourceID != "" || t.Payload != "" {
			return errors.New("unsupported or invalid task")
		}
	} else if t.Operation == "schema_scan" {
		if t.Protocol != 2 || !uuid.MatchString(t.WorkspaceID) || !uuid.MatchString(t.SourceID) || t.Payload != "" {
			return errors.New("unsupported or invalid task")
		}
	} else {
		return errors.New("unsupported or invalid task")
	}
	if _, err = Decode(t.Nonce, 32); err != nil {
		return errors.New("invalid task nonce")
	}
	nowUnix := now.Unix()
	if t.IssuedAt > nowUnix+60 || t.ExpiresAt <= nowUnix || t.ExpiresAt <= t.IssuedAt || t.ExpiresAt-t.IssuedAt > 60 {
		return errors.New("task expired or has invalid lifetime")
	}
	if !ed25519.Verify(ed25519.PublicKey(key), []byte(strings.Join(TaskFields(t), "\n")), signature) {
		return errors.New("task signature verification failed")
	}
	return nil
}

type Result struct {
	Signed
	TaskID  string `json:"taskId"`
	Outcome string `json:"outcome"`
}

func NewResult(connectorID, version, taskID string, private ed25519.PrivateKey, now time.Time) (Result, error) {
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return Result{}, err
	}
	r := Result{Signed: Signed{ConnectorID: connectorID, AgentVersion: version, Protocol: Version, Timestamp: now.Unix(), Nonce: Encode(nonce)}, TaskID: taskID, Outcome: "ok"}
	r.Signature = sign(private, "connector-v1", "result", connectorID, taskID, r.Outcome, version, strconv.Itoa(r.Protocol), strconv.FormatInt(r.Timestamp, 10), r.Nonce)
	return r, nil
}
