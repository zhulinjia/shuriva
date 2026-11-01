package mutationstore

import (
	"bytes"
	"context"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	bolt "go.etcd.io/bbolt"
)

func (s *Store) ListTargetRecords(ctx context.Context, target, after string) ([]mutationrunner.Record, string, error) {
	if err := s.check(ctx); err != nil {
		return nil, "", err
	}
	if target == "" || len(target) > 256 || len(after) > 80 {
		return nil, "", ErrJournal
	}
	var list []mutationrunner.Record
	next := ""
	err := s.db.View(func(tx *bolt.Tx) error {
		records, index := tx.Bucket(recordsBucket), tx.Bucket(targetRecordsBucket)
		if records.Stats().KeyN != index.Stats().KeyN {
			return ErrJournal
		}
		cursor := index.Cursor()
		prefix := []byte(target + "\x00")
		key, id := cursor.Seek(append(append([]byte(nil), prefix...), []byte(after)...))
		if after != "" && string(id) == after {
			key, id = cursor.Next()
		}
		for ; key != nil && bytes.HasPrefix(key, prefix); key, id = cursor.Next() {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if len(list) == 100 {
				next = list[len(list)-1].Execution.ExecutionID
				break
			}
			record, err := s.decodeRecord(records.Get(id))
			if err != nil {
				return err
			}
			if record.Record.Execution.ExecutionID != string(id) || record.Record.Execution.TargetIdentity != target || string(key) != target+"\x00"+string(id) {
				return ErrJournal
			}
			list = append(list, record.Record)
		}
		return nil
	})
	return list, next, err
}
