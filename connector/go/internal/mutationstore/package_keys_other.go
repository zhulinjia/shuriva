//go:build !windows

package mutationstore

func systemPackageKeyNames(string) ([]string, error) { return nil, ErrCredentials }
