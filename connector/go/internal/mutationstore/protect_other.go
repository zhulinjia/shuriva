//go:build !windows

package mutationstore

import "os"

func protectNewFile(path string) error { return os.Chmod(path, 0600) }
