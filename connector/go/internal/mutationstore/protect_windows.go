//go:build windows

package mutationstore

import "example.com/ai-database-workspace/connector/internal/privatefs"

func protectNewFile(path string) error {
	return privatefs.Protect(path, false)
}
