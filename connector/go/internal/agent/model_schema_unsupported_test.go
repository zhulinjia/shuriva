//go:build !amd64 && !arm64

package agent

import (
	"context"
	"errors"
	"testing"

	"example.com/ai-database-workspace/connector/internal/datasource"
	"example.com/ai-database-workspace/connector/internal/protocol"
)

func TestModelSchemaFailsClosedOnUnsupportedArchitecture(t *testing.T) {
	runner := NewReadRunner(Config{}, nil, nil)
	if _, err := runner.ExecuteModelSchema(context.Background(), protocol.ReadTask{Operation: "model_schema"}); !errors.Is(err, datasource.ErrQueryUnsupported) {
		t.Fatal("model schema must be unavailable when query validation is unavailable")
	}
}
