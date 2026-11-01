package mutationstore

import (
	"io"
	"os"
	"path/filepath"
)

// WriteProtectedArtifact only creates a new operator-selected local artifact.
// It never replaces a manifest/journal or deletes partial evidence on failure.
func WriteProtectedArtifact(path string, raw []byte) error {
	if len(raw) == 0 || len(raw) > 1<<20 {
		return ErrJournal
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return ErrJournal
	}
	if err = os.MkdirAll(filepath.Dir(absolute), 0700); err != nil || !regularAncestors(filepath.Dir(absolute)) {
		return ErrJournal
	}
	f, err := os.OpenFile(absolute, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return ErrJournal
	}
	defer f.Close()
	if protectNewFile(absolute) != nil {
		return ErrJournal
	}
	written, err := f.Write(raw)
	if err != nil || written != len(raw) {
		return ErrJournal
	}
	if f.Sync() != nil {
		return ErrJournal
	}
	return f.Close()
}
func ReadProtectedArtifact(path string) ([]byte, error) {
	absolute, err := filepath.Abs(path)
	if err != nil || !regularAncestors(filepath.Dir(absolute)) {
		return nil, ErrJournal
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 1<<20 {
		return nil, ErrJournal
	}
	f, err := os.Open(absolute)
	if err != nil {
		return nil, ErrJournal
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 {
		return nil, ErrJournal
	}
	return raw, nil
}
