package agent

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// LockConfig prevents concurrent run/rotate/reset processes from racing the keyring.
// An unclean shutdown can leave a lock; remove it only after confirming no process uses it.
func LockConfig(configPath string) (func() error, error) {
	if err := os.MkdirAll(filepath.Dir(configPath), 0700); err != nil {
		return nil, err
	}
	path := configPath + ".lock"
	token := make([]byte, 24)
	if _, err := rand.Read(token); err != nil {
		return nil, err
	}
	expected := fmt.Sprintf("%d:%s", os.Getpid(), hex.EncodeToString(token))
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, errors.New("connector identity is in use or its lock needs inspection")
	}
	if _, err = f.WriteString(expected); err != nil {
		f.Close()
		return nil, err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return nil, err
	}
	if err = f.Close(); err != nil {
		return nil, err
	}
	return func() error {
		value, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if string(value) != expected {
			return errors.New("connector lock changed unexpectedly")
		}
		return os.Remove(path)
	}, nil
}
