package mutationstore

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	bolt "go.etcd.io/bbolt"
	"time"
)

type storedLease struct {
	Scope         mutationrunner.Scope
	Commitment    string
	ExpiresAt     int64
	HardExpiresAt int64
	Ciphertext    []byte
	RetainedUntil int64
	KeyID         string
	MAC           []byte
}

func leaseAAD(id string, stored storedLease) []byte {
	stored.MAC = nil
	stored.Ciphertext = nil
	raw, _ := json.Marshal(struct {
		ID    string
		Lease storedLease
	}{id, stored})
	return append([]byte("stackoryn-mutation-package-v1\x00"), raw...)
}
func (s *Store) leaseMAC(id string, lease storedLease) []byte {
	lease.MAC = nil
	raw, _ := json.Marshal(lease)
	m := hmac.New(sha256.New, s.macKey)
	m.Write([]byte("mutation-package-metadata-v1\x00" + s.identity + "\x00" + id + "\x00"))
	m.Write(raw)
	return m.Sum(nil)
}
func (s *Store) decodeLease(id string, raw []byte) (storedLease, error) {
	var lease storedLease
	if json.Unmarshal(raw, &lease) != nil || !packageID.MatchString(lease.KeyID) || lease.HardExpiresAt <= 0 || lease.ExpiresAt > lease.HardExpiresAt || !hmac.Equal(lease.MAC, s.leaseMAC(id, lease)) {
		return storedLease{}, ErrJournal
	}
	return lease, nil
}
func packageAEAD(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, ErrJournal
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrJournal
	}
	return cipher.NewGCM(block)
}
func zero(key []byte) {
	for i := range key {
		key[i] = 0
	}
}
func (s *Store) openLease(id string, lease storedLease) ([]byte, error) {
	key, hard, err := s.keys.Get(lease.KeyID)
	if err != nil {
		return nil, err
	}
	defer zero(key)
	if hard != lease.HardExpiresAt {
		return nil, ErrJournal
	}
	aead, err := packageAEAD(key)
	if err != nil || len(lease.Ciphertext) < aead.NonceSize() {
		return nil, ErrJournal
	}
	n := aead.NonceSize()
	payload, err := aead.Open(nil, lease.Ciphertext[:n], lease.Ciphertext[n:], leaseAAD(id, lease))
	if err != nil {
		return nil, ErrJournal
	}
	return payload, nil
}
func (s *Store) SaveLease(ctx context.Context, l mutationrunner.Lease) error {
	if err := s.check(ctx); err != nil {
		return err
	}
	now := time.Now().Unix()
	if l.ID == "" || l.Commitment == "" || len(l.Payload) > 1<<20 || l.ExpiresAt <= now || l.ReconciliationExpiresAt < l.ExpiresAt || l.ReconciliationExpiresAt > now+86400 {
		return ErrJournal
	}
	id, key, err := newPackageKey()
	if err != nil {
		return err
	}
	defer zero(key)
	aead, err := packageAEAD(key)
	if err != nil {
		return err
	}
	stored := storedLease{Scope: l.Scope, Commitment: l.Commitment, ExpiresAt: l.ExpiresAt, HardExpiresAt: l.ReconciliationExpiresAt, KeyID: id}
	nonce := make([]byte, aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return ErrJournal
	}
	stored.Ciphertext = aead.Seal(nonce, nonce, l.Payload, leaseAAD(l.ID, stored))
	stored.MAC = s.leaseMAC(l.ID, stored)
	raw, err := json.Marshal(stored)
	if err != nil {
		return ErrJournal
	}
	if err = s.keys.Create(id, key, l.ReconciliationExpiresAt); err != nil {
		return err
	}
	err = s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(leasesBucket)
		if b.Get([]byte(l.ID)) != nil {
			return mutationrunner.ErrConsumed
		}
		if b.Stats().KeyN >= 512 {
			return ErrJournal
		}
		return b.Put([]byte(l.ID), raw)
	})
	if err != nil {
		if deletion := s.keys.Delete(id); deletion != nil {
			return deletion
		}
		return err
	}
	return nil
}
func (s *Store) LoadLease(ctx context.Context, id string, scope mutationrunner.Scope) (mutationrunner.Lease, error) {
	var result mutationrunner.Lease
	if err := s.check(ctx); err != nil {
		return result, err
	}
	var stored storedLease
	err := s.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(leasesBucket).Get([]byte(id))
		if raw == nil {
			return mutationrunner.ErrNotFound
		}
		var err error
		stored, err = s.decodeLease(id, raw)
		return err
	})
	if err != nil {
		return result, err
	}
	if stored.Scope != scope {
		return result, mutationrunner.ErrDenied
	}
	payload, err := s.openLease(id, stored)
	if err != nil {
		return result, err
	}
	return mutationrunner.Lease{ID: id, Scope: scope, Commitment: stored.Commitment, ExpiresAt: stored.ExpiresAt, ReconciliationExpiresAt: stored.HardExpiresAt, Payload: payload}, nil
}
func (s *Store) DeleteLease(ctx context.Context, id string) error {
	if err := s.check(ctx); err != nil {
		return err
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(leasesBucket)
		raw := b.Get([]byte(id))
		if raw == nil {
			return nil
		}
		stored, err := s.decodeLease(id, raw)
		if err != nil {
			return err
		}
		if err = s.keys.Delete(stored.KeyID); err != nil {
			return err
		}
		return b.Delete([]byte(id))
	})
}

// DeleteOwnedLease never lets a different execution remove the original
// preview's reconciliation material. Owner lookup, validation and deletion
// are serialized by the same journal transaction as Consume.
func (s *Store) DeleteOwnedLease(ctx context.Context, e mutationrunner.Execution) error {
	if err := s.check(ctx); err != nil {
		return err
	}
	if e.PreviewID == "" || e.ExecutionID == "" {
		return mutationrunner.ErrDenied
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		raw := tx.Bucket(metadataBucket).Get([]byte("preview-owner-v1:" + e.PreviewID))
		if raw == nil {
			// A consumed record without its owner claim is corrupt. An
			// unconsumed execution cannot delete another operation's package.
			if value := tx.Bucket(recordsBucket).Get([]byte(e.ExecutionID)); value != nil {
				record, err := s.decodeRecord(value)
				if err != nil || record.Consumed {
					return ErrJournal
				}
			}
			return nil
		}
		var claim previewOwner
		if json.Unmarshal(raw, &claim) != nil || claim.ExecutionID == "" || !hmac.Equal(claim.MAC, s.previewOwnerMAC(e.PreviewID, claim.ExecutionID)) {
			return ErrJournal
		}
		owner, err := s.decodeRecord(tx.Bucket(recordsBucket).Get([]byte(claim.ExecutionID)))
		if err != nil || !owner.Consumed || owner.Record.Execution.PreviewID != e.PreviewID {
			return ErrJournal
		}
		if claim.ExecutionID != e.ExecutionID {
			return nil
		}
		if owner.Record.Execution != e {
			return mutationrunner.ErrDenied
		}
		bucket := tx.Bucket(leasesBucket)
		value := bucket.Get([]byte(e.PreviewID))
		if value == nil {
			return nil
		}
		lease, err := s.decodeLease(e.PreviewID, value)
		if err != nil {
			return err
		}
		if lease.Scope != e.Scope || lease.Commitment != e.Commitment {
			return mutationrunner.ErrDenied
		}
		if err = s.keys.Delete(lease.KeyID); err != nil {
			return err
		}
		return bucket.Delete([]byte(e.PreviewID))
	})
}
