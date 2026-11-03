//go:build windows

package mcphost

import (
	"strings"
	"testing"
)

func TestFrameBudgets(t *testing.T) {
	for _, test := range []struct {
		name, raw string
		valid     bool
	}{{"rpc", `{"jsonrpc":"2.0","id":1,"result":{}}`, true}, {"depth", strings.Repeat("[", 25) + "0" + strings.Repeat("]", 25), false}, {"range", `{"n":1e999}`, false}, {"members", "[" + strings.Repeat("0,", 256) + "0]", false}, {"size", `{"text":"` + strings.Repeat("x", 1048576) + `"}`, false}, {"invalid", `{"broken":`, false}} {
		t.Run(test.name, func(t *testing.T) {
			if validFrame([]byte(test.raw)) != test.valid {
				t.Fatal("frame boundary mismatch")
			}
		})
	}
}
