//go:build !amd64 && !arm64

package mutationguard

func Available() bool                                     { return false }
func VerifyStatement(Table, Statement) error              { return ErrUnsupported }
func StructuralDefinition(string, string) (string, error) { return "", ErrUnsupported }
