// Package protocol defines the language-neutral Connector v1 wire contract.
package protocol

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"time"
)

const Version = 1
const PairVersion = 2

type Pair struct {
	PairingID    string `json:"pairingId"`
	Proof        string `json:"proof"`
	ConnectorID  string `json:"connectorId"`
	Name         string `json:"name"`
	PublicKey    string `json:"publicKey"`
	AgentVersion string `json:"agentVersion"`
	Protocol     int    `json:"protocol"`
	Signature    string `json:"signature"`
}
type Signed struct {
	ConnectorID  string `json:"connectorId"`
	AgentVersion string `json:"agentVersion"`
	Protocol     int    `json:"protocol"`
	Timestamp    int64  `json:"timestamp"`
	Nonce        string `json:"nonce"`
	Signature    string `json:"signature"`
}
type Rotate struct {
	Signed
	NewPublicKey string `json:"newPublicKey"`
}

func Encode(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }
func Decode(s string, length int) ([]byte, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || len(b) != length || Encode(b) != s {
		return nil, errors.New("invalid encoded value")
	}
	return b, nil
}
func sign(private ed25519.PrivateKey, fields ...string) string {
	return Encode(ed25519.Sign(private, []byte(strings.Join(fields, "\n"))))
}
func PairProof(p Pair, secret string) string {
	key := sha256.Sum256([]byte(secret))
	mac := hmac.New(sha256.New, key[:])
	_, _ = mac.Write([]byte(strings.Join([]string{"connector-v2", "pair-proof", p.PairingID, p.ConnectorID, p.Name, p.PublicKey, p.AgentVersion, strconv.Itoa(p.Protocol)}, "\n")))
	return Encode(mac.Sum(nil))
}
func SignPair(p *Pair, secret string, private ed25519.PrivateKey) {
	p.Proof = PairProof(*p, secret)
	p.Signature = sign(private, "connector-v2", "pair", p.PairingID, p.Proof, p.ConnectorID, p.Name, p.PublicKey, p.AgentVersion, strconv.Itoa(p.Protocol))
}
func SignHeartbeat(p *Signed, private ed25519.PrivateKey) {
	p.Signature = sign(private, "connector-v1", "heartbeat", p.ConnectorID, p.AgentVersion, strconv.Itoa(p.Protocol), strconv.FormatInt(p.Timestamp, 10), p.Nonce)
}
func SignProbe(p *Signed, private ed25519.PrivateKey) {
	p.Signature = sign(private, "connector-v1", "probe", p.ConnectorID, p.AgentVersion, strconv.Itoa(p.Protocol), strconv.FormatInt(p.Timestamp, 10), p.Nonce)
}
func SignRotation(p *Rotate, private ed25519.PrivateKey) {
	p.Signature = sign(private, "connector-v1", "rotate", p.ConnectorID, p.NewPublicKey, p.AgentVersion, strconv.Itoa(p.Protocol), strconv.FormatInt(p.Timestamp, 10), p.Nonce)
}
func NewHeartbeat(id, version string, private ed25519.PrivateKey, now time.Time) (Signed, error) {
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return Signed{}, err
	}
	p := Signed{ConnectorID: id, AgentVersion: version, Protocol: Version, Timestamp: now.Unix(), Nonce: Encode(nonce)}
	SignHeartbeat(&p, private)
	return p, nil
}
func NewProbe(id, version string, private ed25519.PrivateKey, now time.Time) (Signed, error) {
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return Signed{}, err
	}
	p := Signed{ConnectorID: id, AgentVersion: version, Protocol: Version, Timestamp: now.Unix(), Nonce: Encode(nonce)}
	SignProbe(&p, private)
	return p, nil
}
func NewRotation(id, version, newKey string, private ed25519.PrivateKey, now time.Time) (Rotate, error) {
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return Rotate{}, err
	}
	p := Rotate{Signed: Signed{ConnectorID: id, AgentVersion: version, Protocol: Version, Timestamp: now.Unix(), Nonce: Encode(nonce)}, NewPublicKey: newKey}
	SignRotation(&p, private)
	return p, nil
}
