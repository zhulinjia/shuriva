package agent

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"

	"example.com/ai-database-workspace/connector/internal/protocol"
	"github.com/zalando/go-keyring"
)

// HMAC of the task ID assigns an unpredictable shard, keeping individual
// credentials bounded without evicting any unexpired replay records.
func replayKey(id, taskID string, secret []byte) string {
	return replayKeys(id, taskID, secret)[0]
}

func replayKeys(id, taskID string, secret []byte) []string {
	h := hmac.New(sha256.New, secret)
	_, _ = h.Write([]byte(taskID))
	digest := h.Sum(nil)
	keys := make([]string, 0, 4)
	used := make(map[byte]bool, 4)
	for _, value := range digest[:4] {
		for used[value] {
			value++
		}
		used[value] = true
		keys = append(keys, id+":tasks:"+fmt.Sprintf("%02x", value))
	}
	return keys
}

func (v SystemVault) recordTask(id string, task CompletedTask, now int64) (bool, error) {
	identity, err := v.Get(id)
	if err != nil {
		return false, err
	}
	if identity.Resetting {
		return false, errors.New("connector reset is incomplete")
	}
	if identity.ReplayKey == "" {
		secret := make([]byte, 32)
		if _, err = rand.Read(secret); err != nil {
			return false, errors.New("local task state unavailable")
		}
		identity.ReplayKey = protocol.Encode(secret)
		if err = v.Set(id, identity); err != nil {
			return false, errors.New("local task state unavailable")
		}
	}
	secret, err := protocol.Decode(identity.ReplayKey, 32)
	if err != nil {
		return false, errors.New("invalid local task state")
	}
	var selected string
	var available []CompletedTask
	for _, name := range replayKeys(id, task.ID, secret) {
		raw, getErr := keyring.Get(keyService, name)
		if getErr != nil && !errors.Is(getErr, keyring.ErrNotFound) {
			return false, errors.New("local task state unavailable")
		}
		var entries []CompletedTask
		if getErr == nil && (json.Unmarshal([]byte(raw), &entries) != nil || entries == nil || len(entries) > 8) {
			return false, errors.New("invalid local task state")
		}
		current := make([]CompletedTask, 0, len(entries)+1)
		seen := make(map[string]bool, len(entries))
		for _, entry := range entries {
			if !pairingID.MatchString(entry.ID) || entry.ExpiresAt <= 0 || seen[entry.ID] {
				return false, errors.New("invalid local task state")
			}
			if _, err := protocol.Decode(entry.Signature, ed25519.SignatureSize); err != nil {
				return false, errors.New("invalid local task state")
			}
			seen[entry.ID] = true
			if entry.ExpiresAt <= now {
				continue
			}
			if entry.ID == task.ID {
				return entry.Signature == task.Signature, ErrReadReplay
			}
			current = append(current, entry)
		}
		if len(current) < 8 && (selected == "" || len(current) < len(available)) {
			selected, available = name, current
		}
	}
	if selected == "" {
		return false, errors.New("local task capacity reached")
	}
	available = append(available, task)
	encoded, err := json.Marshal(available)
	if err != nil {
		return false, err
	}
	if err = keyring.Set(keyService, selected, string(encoded)); err != nil {
		return false, errors.New("local task state unavailable")
	}
	return false, nil
}

func (SystemVault) deleteReplay(id string) error {
	for i := 0; i < 256; i++ {
		err := keyring.Delete(keyService, id+":tasks:"+fmt.Sprintf("%02x", i))
		if err != nil && !errors.Is(err, keyring.ErrNotFound) {
			return errors.New("cannot clear local task state")
		}
	}
	return nil
}

// Injected vaults can store replay records alongside identity state. The
// operating system vault uses bounded shards to respect credential size limits.
func recordTask(v Vault, id string, task CompletedTask, now int64) (bool, error) {
	if s, ok := v.(SystemVault); ok {
		return s.recordTask(id, task, now)
	}
	state, err := v.Get(id)
	if err != nil {
		return false, err
	}
	if state.Resetting {
		return false, errors.New("connector reset is incomplete")
	}
	entries := make([]CompletedTask, 0, len(state.Completed)+1)
	for _, entry := range state.Completed {
		if entry.ExpiresAt <= now {
			continue
		}
		if entry.ID == task.ID {
			return entry.Signature == task.Signature, ErrReadReplay
		}
		entries = append(entries, entry)
	}
	if len(entries) >= 1024 {
		return false, errors.New("local task capacity reached")
	}
	state.Completed = append(entries, task)
	if err = v.Set(id, state); err != nil {
		return false, errors.New("local task state unavailable")
	}
	return false, nil
}
