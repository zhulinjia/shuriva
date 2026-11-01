package protocol

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// MutationMessage authenticates transport only. Domain authorization, journal
// consumption and current commit eligibility are checked independently.
type MutationMessage struct {
	ID          string `json:"id"`
	ConnectorID string `json:"connectorId"`
	OwnerID     string `json:"ownerId"`
	WorkspaceID string `json:"workspaceId"`
	SourceID    string `json:"sourceId"`
	Kind        string `json:"kind"`
	Operation   string `json:"operation"`
	Payload     string `json:"payload"`
	IssuedAt    int64  `json:"issuedAt"`
	ExpiresAt   int64  `json:"expiresAt"`
	Nonce       string `json:"nonce"`
	ReplyTo     string `json:"replyTo"`
	Protocol    int    `json:"protocol"`
	Signature   string `json:"signature"`
}

const MutationPayloadMax = (1 << 20) + (64 << 10)

func MutationFields(m MutationMessage) []string {
	hash := sha256.Sum256([]byte(m.Payload))
	return []string{"connector-mutation-v1", m.Kind, m.Operation, m.ID, m.ConnectorID, m.OwnerID, m.WorkspaceID, m.SourceID, hex.EncodeToString(hash[:]), strconv.FormatInt(m.IssuedAt, 10), strconv.FormatInt(m.ExpiresAt, 10), m.Nonce, m.ReplyTo, "1"}
}

func ValidateMutationMessage(m MutationMessage, now time.Time) error {
	if m.Protocol != 1 || !uuid.MatchString(m.ID) || !uuid.MatchString(m.ConnectorID) || len(m.Payload) < 1 || len(m.Payload) > 2097152 || m.ExpiresAt <= now.Unix() || m.ExpiresAt <= m.IssuedAt || m.ExpiresAt-m.IssuedAt > 30 || m.IssuedAt > now.Unix()+2 {
		return errors.New("invalid mutation envelope")
	}
	if _, err := Decode(m.Nonce, 32); err != nil {
		return errors.New("invalid mutation nonce")
	}
	poll := m.Kind == "poll" || m.Kind == "poll_reply"
	if poll {
		if m.OwnerID != "" || m.WorkspaceID != "" || m.SourceID != "" || m.Operation != "" {
			return errors.New("invalid poll routing")
		}
	} else {
		if !actor.MatchString(m.OwnerID) || !uuid.MatchString(m.WorkspaceID) || !uuid.MatchString(m.SourceID) {
			return errors.New("invalid mutation routing")
		}
		switch m.Operation {
		case "capability", "preview", "execute", "status", "cancel", "recover":
		default:
			return errors.New("invalid mutation operation")
		}
	}
	switch m.Kind {
	case "poll", "task", "claim", "permit":
		if m.ReplyTo != "" {
			return errors.New("unexpected mutation reply nonce")
		}
	case "poll_reply", "result", "result_reply", "claim_reply", "permit_reply":
		if _, err := Decode(m.ReplyTo, 32); err != nil {
			return errors.New("missing mutation reply binding")
		}
	default:
		return errors.New("invalid mutation message kind")
	}
	raw, err := base64.RawURLEncoding.DecodeString(m.Payload)
	if err != nil || len(raw) > MutationPayloadMax || !utf8.Valid(raw) || base64.RawURLEncoding.EncodeToString(raw) != m.Payload || !json.Valid(raw) {
		return errors.New("invalid mutation payload")
	}
	return nil
}

func VerifyMutationMessage(m MutationMessage, connectorID, key string, now time.Time) error {
	if m.ConnectorID != connectorID {
		return errors.New("mutation connector mismatch")
	}
	if err := ValidateMutationMessage(m, now); err != nil {
		return err
	}
	public, err := Decode(key, ed25519.PublicKeySize)
	if err != nil {
		return errors.New("invalid mutation signing key")
	}
	signature, err := Decode(m.Signature, ed25519.SignatureSize)
	if err != nil || !ed25519.Verify(ed25519.PublicKey(public), []byte(strings.Join(MutationFields(m), "\n")), signature) {
		return errors.New("mutation signature invalid")
	}
	return nil
}

func NewMutationMessage(connectorID, kind string, private ed25519.PrivateKey, now time.Time) (MutationMessage, error) {
	var id [16]byte
	var nonce [32]byte
	if _, err := rand.Read(id[:]); err != nil {
		return MutationMessage{}, err
	}
	if _, err := rand.Read(nonce[:]); err != nil {
		return MutationMessage{}, err
	}
	id[6] = (id[6] & 15) | 64
	id[8] = (id[8] & 63) | 128
	h := hex.EncodeToString(id[:])
	m := MutationMessage{ID: h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:], ConnectorID: connectorID, Kind: kind, Payload: Encode([]byte("{}")), IssuedAt: now.Unix(), ExpiresAt: now.Unix() + 30, Nonce: Encode(nonce[:]), Protocol: 1}
	SignMutationMessage(&m, private)
	return m, nil
}

func SignMutationMessage(m *MutationMessage, private ed25519.PrivateKey) {
	m.Signature = Encode(ed25519.Sign(private, []byte(strings.Join(MutationFields(*m), "\n"))))
}

func DecodeMutationPayload(m MutationMessage, destination any) error {
	raw, err := base64.RawURLEncoding.DecodeString(m.Payload)
	if err != nil {
		return errors.New("invalid mutation payload")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return errors.New("invalid mutation payload")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return errors.New("invalid mutation payload trailing content")
	}
	return nil
}
