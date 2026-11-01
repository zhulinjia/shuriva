package cli

import (
	"bytes"
	"strings"
	"testing"
)

func TestDefaultStatusReportsDisabledCapabilities(t *testing.T) {
	t.Setenv("CONNECTOR_CONFIG_PATH", t.TempDir()+"/connector.json")
	var out, errOut bytes.Buffer
	code := Run(nil, &out, &errOut, "test-version")
	if code != 0 || errOut.Len() != 0 {
		t.Fatalf("status: exit=%d stderr=%q", code, errOut.String())
	}
	for _, want := range []string{"test-version", "Database connection: local metadata checks only", "Query and write execution: disabled"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("status output missing %q: %q", want, out.String())
		}
	}
}

func TestUnsupportedOperationsFailClosed(t *testing.T) {
	for _, args := range [][]string{{"query"}, {"execute"}, {"write"}, {"status", "--connect"}} {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			var out, errOut bytes.Buffer
			if code := Run(args, &out, &errOut, "test"); code == 0 {
				t.Fatalf("unsupported command %q succeeded", args)
			}
			if out.Len() != 0 || errOut.Len() == 0 {
				t.Fatalf("unsupported command should only report an error: stdout=%q stderr=%q", out.String(), errOut.String())
			}
		})
	}
}

func TestVersionAndHelp(t *testing.T) {
	for _, tc := range []struct {
		arg  string
		want string
	}{
		{"version", "test-version"},
		{"--version", "test-version"},
		{"help", "Usage: connector"},
		{"--help", "Usage: connector"},
		{"-h", "Usage: connector"},
	} {
		t.Run(tc.arg, func(t *testing.T) {
			var out, errOut bytes.Buffer
			if code := Run([]string{tc.arg}, &out, &errOut, "test-version"); code != 0 || !strings.Contains(out.String(), tc.want) || errOut.Len() != 0 {
				t.Fatalf("exit=%d stdout=%q stderr=%q", code, out.String(), errOut.String())
			}
		})
	}
}

func TestUnavailableDiagnosticConfigurationDoesNotStopCommand(t *testing.T) {
	t.Setenv("CONNECTOR_CONFIG_PATH", t.TempDir()+"/connector.json")
	t.Setenv("CONNECTOR_LOG_OUTPUT", "file")
	t.Setenv("CONNECTOR_LOG_FILE", "sensitive-relative-file")
	var out, errOut bytes.Buffer
	if code := Run([]string{"version"}, &out, &errOut, "test-version"); code != 0 || !strings.Contains(out.String(), "test-version") {
		t.Fatal("diagnostic failure blocked the command")
	}
	if !strings.Contains(errOut.String(), "connector.diagnostics_unavailable") || strings.Contains(errOut.String(), "sensitive-relative-file") {
		t.Fatal("diagnostic failure was silent or leaked its cause")
	}
}
