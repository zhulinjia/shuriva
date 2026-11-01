//go:build !amd64 && !arm64

package queryguard

import (
	"errors"
	"testing"
)

func TestUnsupportedArchitectureFailsClosed(t *testing.T) {
	if _, err := Validate("SELECT id FROM customers", "", Policy{}, 10); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("expected unavailable, got %v", err)
	}
}
