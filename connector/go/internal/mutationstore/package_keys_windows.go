//go:build windows

package mutationstore

import (
	"errors"
	"github.com/danieljoos/wincred"
	"syscall"
)

func systemPackageKeyNames(prefix string) ([]string, error) {
	entries, err := wincred.FilteredList(prefix + "*")
	if errors.Is(err, syscall.ERROR_NOT_FOUND) {
		return nil, nil
	}
	if err != nil {
		return nil, ErrCredentials
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.TargetName)
	}
	return names, nil
}
