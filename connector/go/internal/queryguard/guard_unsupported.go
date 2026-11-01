//go:build !amd64 && !arm64

package queryguard

func Available() bool { return false }

// Validate fails closed where the parser's upstream dependencies cannot build.
func Validate(_ string, _ string, _ Policy, _ int) (Plan, error) {
	return Plan{}, ErrUnavailable
}
