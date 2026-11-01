//go:build !windows

package mutationstore

import (
	"errors"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
)

type SystemClock struct{}

func NewClock() (*SystemClock, error) {
	return nil, errors.New("mutation clock is not verified on this operating system")
}
func (*SystemClock) Read() (mutationrunner.Reading, error) {
	return mutationrunner.Reading{}, ErrJournal
}
