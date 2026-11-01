package mutationstore

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	bolt "go.etcd.io/bbolt"
	"time"
)

// RetainLease only switches a package to its original fixed hard deadline.
// Its independent OS credential already expires at that deadline; there is no
// key-renewal operation and neither reboot nor Status can extend the period.
func (s *Store) RetainLease(ctx context.Context, id string, scope mutationrunner.Scope, expires int64) error {
	if err := s.check(ctx); err != nil {
		return err
	}
	if expires <= time.Now().Unix() {
		return ErrPackageExpired
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(leasesBucket)
		raw := b.Get([]byte(id))
		if raw == nil {
			return mutationrunner.ErrNotFound
		}
		lease, err := s.decodeLease(id, raw)
		if err != nil {
			return err
		}
		if lease.Scope != scope || lease.HardExpiresAt != expires {
			return ErrJournal
		}
		if lease.RetainedUntil != 0 {
			if lease.RetainedUntil == expires {
				return nil
			}
			return ErrJournal
		}
		key, hard, err := s.keys.Get(lease.KeyID)
		if err != nil {
			return err
		}
		defer zero(key)
		if hard != lease.HardExpiresAt {
			return ErrJournal
		}
		aead, err := packageAEAD(key)
		if err != nil {
			return err
		}
		n := aead.NonceSize()
		if len(lease.Ciphertext) < n {
			return ErrJournal
		}
		payload, err := aead.Open(nil, lease.Ciphertext[:n], lease.Ciphertext[n:], leaseAAD(id, lease))
		if err != nil {
			return ErrJournal
		}
		defer zero(payload)
		nonce := make([]byte, n)
		if _, err = rand.Read(nonce); err != nil {
			return ErrJournal
		}
		lease.ExpiresAt = expires
		lease.RetainedUntil = expires
		lease.Ciphertext = aead.Seal(nonce, nonce, payload, leaseAAD(id, lease))
		lease.MAC = s.leaseMAC(id, lease)
		raw, err = json.Marshal(lease)
		if err != nil {
			return ErrJournal
		}
		return b.Put([]byte(id), raw)
	})
}

// CleanupLeases deletes independent keys before logical payload removal. A
// failed key deletion retains evidence and returns an error: no deletion is
// reported while an independently usable key may remain. Execution tombstones
// never expire here. The runtime owns the <=5-minute scheduling lifecycle.
func (s *Store) CleanupLeases(ctx context.Context, now int64, activePreviewIDs []string) error {
	if err := s.check(ctx); err != nil {
		return err
	}
	if now <= 0 || len(activePreviewIDs) > 512 {
		return ErrJournal
	}
	active := map[string]bool{}
	for _, id := range activePreviewIDs {
		if id == "" || active[id] {
			return ErrJournal
		}
		active[id] = true
	}
	var protected []string
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(leasesBucket)
		cursor := b.Cursor()
		for id, raw := cursor.First(); id != nil; id, raw = cursor.Next() {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			lease, err := s.decodeLease(string(id), raw)
			if err != nil {
				return err
			}
			if active[string(id)] && lease.HardExpiresAt > now {
				protected = append(protected, lease.KeyID)
				continue
			}
			if lease.ExpiresAt > now && lease.HardExpiresAt > now {
				continue
			}
			if err = s.keys.Delete(lease.KeyID); err != nil {
				return err
			}
			if err = cursor.Delete(); err != nil {
				return ErrJournal
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	return s.keys.CleanupExpired(now, protected)
}

// PackageMissing distinguishes expired reconciliation data from corruption.
// It grants no execution or recovery permission and must not hide other errors.
func PackageMissing(err error) bool {
	return errors.Is(err, ErrPackageExpired) || errors.Is(err, mutationrunner.ErrNotFound)
}
