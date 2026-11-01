package protocol

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// ReadTask is a signed request. Payload contains query text and parameters and
// must be handled as sensitive in-memory data, never written to logs.
type ReadTask struct {
	ID          string `json:"id"`
	ConnectorID string `json:"connectorId"`
	ActorID     string `json:"actorId"`
	WorkspaceID string `json:"workspaceId"`
	SourceID    string `json:"sourceId"`
	Operation   string `json:"operation"`
	Payload     string `json:"payload"`
	IssuedAt    int64  `json:"issuedAt"`
	ExpiresAt   int64  `json:"expiresAt"`
	Nonce       string `json:"nonce"`
	Protocol    int    `json:"protocol"`
	Signature   string `json:"signature"`
}

type ReadParameter struct {
	Kind  string `json:"kind"`
	Value string `json:"value"`
}
type ReadRequest struct {
	SQL           string          `json:"sql"`
	Parameters    []ReadParameter `json:"parameters"`
	MaxRows       int             `json:"maxRows"`
	SchemaVersion *string         `json:"schemaVersion"`
}

var schemaVersionPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func ReadTaskFields(t ReadTask) []string {
	hash := sha256.Sum256([]byte(t.Payload))
	operation := "read-query"
	if t.Operation == "model_schema" {
		operation = "model-schema"
	} else if t.Operation == "model_authorize" {
		operation = "model-authorize"
	}
	return []string{"connector-read-v1", operation, t.ID, t.ConnectorID, t.ActorID, t.WorkspaceID, t.SourceID, hex.EncodeToString(hash[:]), strconv.FormatInt(t.IssuedAt, 10), strconv.FormatInt(t.ExpiresAt, 10), t.Nonce, "1"}
}

// VerifyReadTask authenticates and binds every routing field before decoding
// the query payload. It does not grant access to any data source or field.
func VerifyReadTask(t ReadTask, connectorID, platformKey string, now time.Time) (ReadRequest, error) {
	var empty ReadRequest
	key, err := Decode(platformKey, ed25519.PublicKeySize)
	if err != nil {
		return empty, errors.New("invalid trusted platform key")
	}
	sig, err := Decode(t.Signature, ed25519.SignatureSize)
	if err != nil || !uuid.MatchString(t.ID) || !uuid.MatchString(t.ConnectorID) || t.ConnectorID != connectorID || !actor.MatchString(t.ActorID) || !uuid.MatchString(t.WorkspaceID) || !uuid.MatchString(t.SourceID) || (t.Operation != "read_query" && t.Operation != "model_schema" && t.Operation != "model_authorize") || t.Protocol != 1 || len(t.Payload) == 0 || len(t.Payload) > 32768 {
		return empty, errors.New("invalid read task")
	}
	if _, err = Decode(t.Nonce, 32); err != nil {
		return empty, errors.New("invalid read task")
	}
	current := now.Unix()
	if t.IssuedAt > current+60 || t.ExpiresAt <= current || t.ExpiresAt <= t.IssuedAt || t.ExpiresAt-t.IssuedAt > 60 {
		return empty, errors.New("expired read task")
	}
	if t.Operation == "model_authorize" && t.ExpiresAt-t.IssuedAt > 30 {
		return empty, errors.New("invalid authorization lease timing")
	}
	if !ed25519.Verify(ed25519.PublicKey(key), []byte(strings.Join(ReadTaskFields(t), "\n")), sig) {
		return empty, errors.New("read task signature invalid")
	}
	raw, err := base64.RawURLEncoding.DecodeString(t.Payload)
	if err != nil || !utf8.Valid(raw) || base64.RawURLEncoding.EncodeToString(raw) != t.Payload {
		return empty, errors.New("invalid read payload")
	}
	if t.Operation == "model_schema" || t.Operation == "model_authorize" {
		if string(raw) != "{}" {
			return empty, errors.New("invalid model schema payload")
		}
		return empty, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var request ReadRequest
	var shape map[string]json.RawMessage
	if json.Unmarshal(raw, &shape) != nil || len(shape) != 4 || shape["schemaVersion"] == nil {
		return empty, errors.New("invalid read payload")
	}
	if err = decoder.Decode(&request); err != nil {
		return empty, errors.New("invalid read payload")
	}
	var extra any
	if err = decoder.Decode(&extra); err != io.EOF || len(request.SQL) == 0 || len(request.SQL) > 16384 || len(request.Parameters) > 64 || request.MaxRows < 1 || request.MaxRows > 1000 || (request.SchemaVersion != nil && !schemaVersionPattern.MatchString(*request.SchemaVersion)) {
		return empty, errors.New("invalid read payload")
	}
	return request, nil
}
