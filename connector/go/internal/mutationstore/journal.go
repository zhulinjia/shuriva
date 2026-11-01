// Package mutationstore implements local durable mutation ports. It never
// derives execution permission from an existing file or a restored timestamp.
package mutationstore

import (
	"context"

	"crypto/hmac"

	"crypto/sha256"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	bolt "go.etcd.io/bbolt"
)

var ErrJournal = errors.New("mutation journal unavailable; writes remain disabled")

var metadataBucket = []byte("metadata-v1")
var leasesBucket = []byte("encrypted-leases-v1")
var recordsBucket = []byte("execution-tombstones-v1")
var frozenBucket = []byte("frozen-targets-v1")
var targetRecordsBucket = []byte("target-record-index-v1")

type Store struct {
	db       *bolt.DB
	keys     PackageKeyStore
	identity string
	macKey   []byte
}
type storedRecord struct {
	Record   mutationrunner.Record
	Consumed bool
	MAC      []byte
}

// Create is an explicit operator action. Open never creates missing evidence.
// If initialization fails the file is retained; callers must not delete it to
// regain write eligibility.
func Create(path string, key []byte, connectorID string, packageKeys PackageKeyStore) (*Store, error) {
	if connectorID == "" || len(key) != 32 || packageKeys == nil {
		return nil, ErrJournal
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return nil, ErrJournal
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, ErrJournal
	}
	if !regularAncestors(filepath.Dir(path)) {
		return nil, ErrJournal
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, ErrJournal
	}
	if err = protectNewFile(path); err != nil {
		f.Close()
		return nil, ErrJournal
	}
	if f.Close() != nil {
		return nil, ErrJournal
	}
	s, err := open(path, key, connectorID, packageKeys, false)
	if err != nil {
		return nil, err
	}
	err = s.db.Update(func(tx *bolt.Tx) error {
		for _, name := range [][]byte{metadataBucket, leasesBucket, recordsBucket, frozenBucket, targetRecordsBucket} {
			if _, err := tx.CreateBucket(name); err != nil {
				return err
			}
		}
		m := tx.Bucket(metadataBucket)
		if err := m.Put([]byte("format"), []byte("stackoryn-mutation-journal-v2")); err != nil {
			return err
		}
		if err := m.Put([]byte("key-check"), s.recordMAC(storedRecord{})); err != nil {
			return err
		}
		return m.Put([]byte("connector"), []byte(connectorID))
	})
	if err != nil {
		s.db.Close()
		return nil, ErrJournal
	}
	return s, nil
}

func Open(path string, key []byte, connectorID string, packageKeys PackageKeyStore) (*Store, error) {
	return open(path, key, connectorID, packageKeys, true)
}
func open(path string, key []byte, connectorID string, packageKeys PackageKeyStore, verify bool) (*Store, error) {
	if connectorID == "" || len(key) != 32 || packageKeys == nil {
		return nil, ErrJournal
	}
	path, err := filepath.Abs(path)
	if err != nil || !regularAncestors(filepath.Dir(path)) {
		return nil, ErrJournal
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || (verify && info.Size() < 4096) {
		return nil, ErrJournal
	}
	db, err := bolt.Open(path, 0600, &bolt.Options{Timeout: 400 * time.Millisecond})
	if err != nil {
		return nil, ErrJournal
	}
	derive := hmac.New(sha256.New, key)
	derive.Write([]byte("stackoryn-mutation-journal-auth-v1"))
	s := &Store{db: db, keys: packageKeys, identity: connectorID, macKey: derive.Sum(nil)}
	if verify {
		err = db.View(func(tx *bolt.Tx) error {
			for _, name := range [][]byte{metadataBucket, leasesBucket, recordsBucket, frozenBucket, targetRecordsBucket} {
				if tx.Bucket(name) == nil {
					return ErrJournal
				}
			}
			m := tx.Bucket(metadataBucket)
			if string(m.Get([]byte("format"))) != "stackoryn-mutation-journal-v2" || string(m.Get([]byte("connector"))) != connectorID {
				return ErrJournal
			}
			if !hmac.Equal(m.Get([]byte("key-check")), s.recordMAC(storedRecord{})) {
				return ErrJournal
			}
			if tx.Bucket(recordsBucket).Stats().KeyN != tx.Bucket(targetRecordsBucket).Stats().KeyN {
				return ErrJournal
			}
			// Version 2 requires every consumed execution to retain its
			// authenticated preview owner; a missing or altered claim is not
			// interpreted as a newly available preview after restart.
			if err := tx.Bucket(recordsBucket).ForEach(func(id, raw []byte) error {
				record, err := s.decodeRecord(raw)
				if err != nil || string(id) != record.Record.Execution.ExecutionID {
					return ErrJournal
				}
				if !record.Consumed {
					return nil
				}
				previewID := record.Record.Execution.PreviewID
				var claim previewOwner
				if previewID == "" || json.Unmarshal(m.Get([]byte("preview-owner-v1:"+previewID)), &claim) != nil || claim.ExecutionID != string(id) || !hmac.Equal(claim.MAC, s.previewOwnerMAC(previewID, claim.ExecutionID)) {
					return ErrJournal
				}
				return nil
			}); err != nil {
				return ErrJournal
			}
			for check := range tx.Check() {
				if check != nil {
					return ErrJournal
				}
			}
			return nil
		})
		if err != nil {
			db.Close()
			return nil, ErrJournal
		}
	}
	return s, nil
}
func regularAncestors(path string) bool {
	for {
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return false
		}
		next := filepath.Dir(path)
		if next == path {
			return true
		}
		path = next
	}
}
func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return ErrJournal
	}
	return s.db.Close()
}
func (s *Store) check(ctx context.Context) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if s == nil || s.db == nil {
		return ErrJournal
	}
	return nil
}
func (s *Store) recordMAC(r storedRecord) []byte {
	r.MAC = nil
	raw, _ := json.Marshal(r)
	m := hmac.New(sha256.New, s.macKey)
	m.Write([]byte(s.identity + "\x00"))
	m.Write(raw)
	return m.Sum(nil)
}
func (s *Store) decodeRecord(raw []byte) (storedRecord, error) {
	var r storedRecord
	if len(raw) == 0 || json.Unmarshal(raw, &r) != nil {
		return r, ErrJournal
	}
	if !hmac.Equal(r.MAC, s.recordMAC(r)) {
		return storedRecord{}, ErrJournal
	}
	return r, nil
}
func (s *Store) putRecord(tx *bolt.Tx, r storedRecord) error {
	r.MAC = s.recordMAC(r)
	raw, err := json.Marshal(r)
	if err != nil {
		return ErrJournal
	}
	return tx.Bucket(recordsBucket).Put([]byte(r.Record.Execution.ExecutionID), raw)
}
func (s *Store) Accept(ctx context.Context, r mutationrunner.Record) error {
	if err := s.check(ctx); err != nil {
		return err
	}
	if r.Execution.ExecutionID == "" || r.Execution.Commitment == "" || r.State != "accepted" {
		return mutationrunner.ErrDenied
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		raw := tx.Bucket(recordsBucket).Get([]byte(r.Execution.ExecutionID))
		if raw != nil {
			old, err := s.decodeRecord(raw)
			if err != nil {
				return err
			}
			if old.Record.Execution != r.Execution {
				return mutationrunner.ErrConsumed
			}
			return nil
		}
		if err := s.putRecord(tx, storedRecord{Record: r}); err != nil {
			return err
		}
		return tx.Bucket(targetRecordsBucket).Put([]byte(r.Execution.TargetIdentity+"\x00"+r.Execution.ExecutionID), []byte(r.Execution.ExecutionID))
	})
}
func (s *Store) Consume(ctx context.Context, e mutationrunner.Execution) error {
	if err := s.check(ctx); err != nil {
		return err
	}
	if e.PreviewID == "" || e.ExecutionID == "" {
		return mutationrunner.ErrDenied
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		r, err := s.decodeRecord(tx.Bucket(recordsBucket).Get([]byte(e.ExecutionID)))
		if err != nil {
			return err
		}
		if r.Consumed || r.Record.Execution != e || r.Record.State != "accepted" {
			return mutationrunner.ErrConsumed
		}
		// A preview is a single local authorization, even when a faulty or
		// compromised platform issues multiple execution IDs for it. Persist
		// the claim in this same transaction as the execution tombstone.
		key := []byte("preview-owner-v1:" + e.PreviewID)
		metadata := tx.Bucket(metadataBucket)
		if raw := metadata.Get(key); raw != nil {
			var claim previewOwner
			if json.Unmarshal(raw, &claim) != nil || claim.ExecutionID == "" || !hmac.Equal(claim.MAC, s.previewOwnerMAC(e.PreviewID, claim.ExecutionID)) {
				return ErrJournal
			}
			owner, err := s.decodeRecord(tx.Bucket(recordsBucket).Get([]byte(claim.ExecutionID)))
			if err != nil || !owner.Consumed || owner.Record.Execution.PreviewID != e.PreviewID {
				return ErrJournal
			}
			return mutationrunner.ErrConsumed
		}
		claim, err := json.Marshal(previewOwner{ExecutionID: e.ExecutionID, MAC: s.previewOwnerMAC(e.PreviewID, e.ExecutionID)})
		if err != nil {
			return ErrJournal
		}
		if err = metadata.Put(key, claim); err != nil {
			return err
		}
		r.Consumed = true
		return s.putRecord(tx, r)
	})
}

type previewOwner struct {
	ExecutionID string
	MAC         []byte
}

func (s *Store) previewOwnerMAC(previewID, executionID string) []byte {
	mac := hmac.New(sha256.New, s.macKey)
	mac.Write([]byte("mutation-preview-owner-v1\x00" + s.identity + "\x00" + previewID + "\x00" + executionID))
	return mac.Sum(nil)
}
func terminal(state string) bool {
	return state == "committed" || state == "rolled_back" || state == "rejected"
}
func validTransition(old, next string) bool {
	if old == next {
		return true
	}
	if terminal(old) {
		return false
	}
	if old == "outcome_unknown" {
		return next == "committed"
	}
	switch next {
	case "execution_started":
		return old == "accepted"
	case "commit_intent":
		return old == "execution_started"
	case "committed":
		return old == "commit_intent"
	case "outcome_unknown":
		return old == "accepted" || old == "execution_started" || old == "commit_intent"
	case "rolled_back":
		return old == "execution_started" || old == "commit_intent"
	case "rejected":
		return old == "accepted" || old == "execution_started"
	}
	return false
}
func (s *Store) Transition(ctx context.Context, next mutationrunner.Record) error {
	if err := s.check(ctx); err != nil {
		return err
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		r, err := s.decodeRecord(tx.Bucket(recordsBucket).Get([]byte(next.Execution.ExecutionID)))
		if err != nil {
			return err
		}
		if r.Record.Execution != next.Execution || !validTransition(r.Record.State, next.State) || (next.State == "execution_started" && !r.Consumed) {
			return mutationrunner.ErrConsumed
		}
		if r.Record.State == next.State && (r.Record.Code != next.Code || r.Record.RowCount != next.RowCount) {
			return mutationrunner.ErrConsumed
		}
		r.Record = next
		return s.putRecord(tx, r)
	})
}
func (s *Store) Get(ctx context.Context, id string, scope mutationrunner.Scope) (mutationrunner.Record, error) {
	var result mutationrunner.Record
	if err := s.check(ctx); err != nil {
		return result, err
	}
	err := s.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(recordsBucket).Get([]byte(id))
		if raw == nil {
			return mutationrunner.ErrNotFound
		}
		r, err := s.decodeRecord(raw)
		if err != nil {
			return err
		}
		if r.Record.Execution.Scope != scope {
			return mutationrunner.ErrDenied
		}
		result = r.Record
		return nil
	})
	return result, err
}
func (s *Store) Freeze(ctx context.Context, target, reason string) error {
	if err := s.check(ctx); err != nil {
		return err
	}
	if target == "" || len(target) > 256 || reason == "" || len(reason) > 128 {
		return mutationrunner.ErrDenied
	}
	return s.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(frozenBucket).Put([]byte(target), []byte(reason)) })
}
func (s *Store) IsFrozen(ctx context.Context, target string) (bool, error) {
	if err := s.check(ctx); err != nil {
		return true, err
	}
	frozen := true
	err := s.db.View(func(tx *bolt.Tx) error { frozen = tx.Bucket(frozenBucket).Get([]byte(target)) != nil; return nil })
	return frozen, err
}

var _ mutationrunner.Journal = (*Store)(nil)
