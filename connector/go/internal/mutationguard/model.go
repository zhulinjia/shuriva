// Package mutationguard validates and compiles the locally authorized mutation
// subset. It has no database, HTTP, credentials or platform dependencies.
package mutationguard

import "errors"

var ErrDenied = errors.New("mutation denied")
var ErrUnsupported = errors.New("mutation validation unavailable")

const MaxRows = 100
const MaxBytes = 1 << 20
const MaxCellBytes = 32768

type Value struct {
	Kind  string `json:"kind"`
	Value string `json:"value"`
}
type Assignment struct {
	Column string `json:"column"`
	Value  Value  `json:"value"`
}
type Predicate struct {
	Column   string `json:"column"`
	Operator string `json:"operator"`
	Value    *Value `json:"value,omitempty"`
}
type Plan struct {
	Operation string         `json:"operation"`
	Table     string         `json:"table"`
	Rows      [][]Assignment `json:"rows,omitempty"`
	Changes   []Assignment   `json:"changes,omitempty"`
	Where     []Predicate    `json:"where,omitempty"`
}
type Row map[string]Value

// Metadata is supplied only by the trusted target adapter after proving the
// fixed installation and complete catalog in the currently locked transaction.
type Column struct {
	Name              string
	Kind              string // integer, decimal, string, binary, date, datetime, boolean
	Bits              int
	Unsigned          bool
	Precision         int
	Scale             int
	MaxLength         int
	Nullable          bool
	Default           *Value
	PrimaryOrdinal    int
	AutoIncrement     bool
	Generated         bool
	ExpressionDefault bool
	OnUpdate          bool
}
type Table struct {
	Database            string
	Name                string
	Engine              string
	BaseTable           bool
	Complete            bool
	SQLMode             string
	Definition          string
	Columns             []Column
	Triggers            int
	IncomingForeignKeys int
	OutgoingForeignKeys int
	Checks              int
}
type Policy struct {
	Database       string      `json:"database"`
	Table          string      `json:"table"`
	InsertColumns  []string    `json:"insertColumns"`
	UpdateColumns  []string    `json:"updateColumns"`
	PreviewColumns []string    `json:"previewColumns"`
	Delete         bool        `json:"delete"`
	RowPredicates  []Predicate `json:"rowPredicates"`
	MaxRows        int         `json:"maxRows"`
	MaxBytes       int         `json:"maxBytes"`
	Generation     string      `json:"generation"`
}
type Statement struct {
	SQL       string
	Args      []any
	Columns   []Column
	MaxRows   int
	Operation string
}
