package protocol

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"time"
)

type ScanResult struct {
	ConnectorID  string `json:"connectorId"`
	TaskID       string `json:"taskId"`
	WorkspaceID  string `json:"workspaceId"`
	SourceID     string `json:"sourceId"`
	Outcome      string `json:"outcome"`
	Payload      string `json:"payload"`
	AgentVersion string `json:"agentVersion"`
	Protocol     int    `json:"protocol"`
	Timestamp    int64  `json:"timestamp"`
	Nonce        string `json:"nonce"`
	Signature    string `json:"signature"`
}

func NewScanResult(task Task, version, outcome, payload string, private ed25519.PrivateKey, now time.Time) (ScanResult, error) {
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return ScanResult{}, err
	}
	r := ScanResult{ConnectorID: task.ConnectorID, TaskID: task.ID, WorkspaceID: task.WorkspaceID, SourceID: task.SourceID, Outcome: outcome, Payload: payload, AgentVersion: version, Protocol: 2, Timestamp: now.Unix(), Nonce: Encode(nonce)}
	hash := sha256.Sum256([]byte(payload))
	r.Signature = sign(private, "connector-v2", "scan-result", r.ConnectorID, r.TaskID, r.WorkspaceID, r.SourceID, r.Outcome, hex.EncodeToString(hash[:]), r.AgentVersion, "2", strconv.FormatInt(r.Timestamp, 10), r.Nonce)
	return r, nil
}
