// Package queryguard compiles a deliberately restricted MySQL query from a
// parsed AST and a locally supplied table/column policy. It does not execute SQL.
package queryguard

import (
	"errors"
	"regexp"
)

var ErrDenied = errors.New("query is not within the supported authorized subset")
var ErrUnavailable = errors.New("query validation is unavailable on this architecture")
var identifier = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)

// MaxCellBytes limits database-to-Connector transfer for each selected cell.
const MaxCellBytes = 32768

// ValidIdentifier deliberately accepts only the identifier subset that can be
// represented without SQL-mode-dependent quoting behavior.
func ValidIdentifier(value string) bool { return identifier.MatchString(value) }

// Policy must come from a trusted local configuration and verified database
// metadata, never directly from a remote task.
type Policy struct {
	Database string
	Tables   map[string][]string
	// BinaryColumns identifies MySQL BIT columns verified from locked metadata.
	// BIT expressions otherwise undergo connection-charset conversion in IF.
	BinaryColumns map[string]bool
	// TextColumns use the exact UTF-8 transfer length, not stored-byte length.
	TextColumns map[string]bool
}

// Plan contains a newly generated SQL statement, never the untrusted input.
// MaxRows is enforced separately by the executor; the extra row detects truncation.
type Plan struct {
	SQL        string
	Table      string
	Columns    []string
	Parameters int
	// NullSafeParameters records which placeholders use MySQL's <=> operator.
	NullSafeParameters []bool
	MaxRows            int
}
