// Package mutationrunner owns mutation use cases. Concrete SQL, journal,
// credentials, clocks and authenticated transport implement these ports.
package mutationrunner

import (
	"context"
	"errors"
	"example.com/ai-database-workspace/connector/internal/mutationguard"
)

var ErrDenied = errors.New("mutation denied")
var ErrFrozen = errors.New("target writes are frozen")
var ErrUnknown = errors.New("mutation outcome unknown")
var ErrConsumed = errors.New("execution already consumed")
var ErrNotFound = errors.New("mutation record not found")
var ErrExpired = errors.New("mutation reconciliation retention expired")

type Scope struct {
	OwnerID     string `json:"ownerId"`
	WorkspaceID string `json:"workspaceId"`
	SourceID    string `json:"sourceId"`
	ConnectorID string `json:"connectorId"`
}
type Binding struct {
	Scope
	APIBoot                string `json:"apiBoot"`
	ConnectorBoot          string `json:"connectorBoot"`
	TargetIdentity         string `json:"targetIdentity"`
	TargetEpoch            string `json:"targetEpoch"`
	PolicyGeneration       string `json:"policyGeneration"`
	InstallationGeneration string `json:"installationGeneration"`
}
type Preview struct {
	Binding
	PreviewID  string   `json:"previewId"`
	Commitment string   `json:"commitment"`
	Revision   int      `json:"revision"`
	Operation  string   `json:"operation"`
	Table      string   `json:"table"`
	RowCount   int      `json:"rowCount"`
	ExpiresAt  string   `json:"expiresAt"`
	Rows       []Change `json:"rows"`
}
type Change struct {
	Before           mutationguard.Row `json:"before"`
	After            mutationguard.Row `json:"after"`
	GeneratedColumns []string          `json:"generatedColumns,omitempty"`
	DefaultColumns   []string          `json:"defaultColumns,omitempty"`
}
type Execution struct {
	Binding
	ExecutionID string `json:"executionId"`
	PreviewID   string `json:"previewId"`
	Commitment  string `json:"commitment"`
	Revision    int    `json:"revision"`
}
type Result struct {
	Execution
	State                   string `json:"state"`
	Code                    string `json:"code"`
	RowCount                int    `json:"rowCount"`
	ReconciliationExpiresAt string `json:"reconciliationExpiresAt,omitempty"`
}
type Receipt struct {
	ExecutionID    string `json:"executionId"`
	Commitment     string `json:"commitment"`
	TargetIdentity string `json:"targetIdentity"`
	TargetEpoch    string `json:"targetEpoch"`
	Scope          Scope  `json:"scope"`
	RowCount       int    `json:"rowCount"`
}
type ApplyResult struct{ Affected, LastInsertID int64 }
type Transaction interface {
	Describe(context.Context, string) (mutationguard.Table, error)
	Rows(context.Context, mutationguard.Statement) ([]mutationguard.Row, error)
	Exec(context.Context, mutationguard.Statement) (ApplyResult, error)
	PutReceipt(context.Context, Receipt) error
	Commit() error
	Rollback() error
}
type Target interface {
	Begin(context.Context, Binding) (Transaction, error)
	Receipt(context.Context, Scope, string) (*Receipt, error)
}
type Lease struct {
	ID                      string
	Scope                   Scope
	Commitment              string
	ExpiresAt               int64
	ReconciliationExpiresAt int64
	Payload                 []byte
}
type Record struct {
	Execution               Execution
	State                   string
	Code                    string
	RowCount                int
	ReconciliationExpiresAt int64
}
type Journal interface {
	SaveLease(context.Context, Lease) error
	LoadLease(context.Context, string, Scope) (Lease, error)
	DeleteOwnedLease(context.Context, Execution) error
	RetainLease(context.Context, string, Scope, int64) error
	CleanupLeases(context.Context, int64, []string) error
	Accept(context.Context, Record) error
	Consume(context.Context, Execution) error
	Transition(context.Context, Record) error
	Get(context.Context, string, Scope) (Record, error)
	Freeze(context.Context, string, string) error
	IsFrozen(context.Context, string) (bool, error)
}
type Reading struct {
	Epoch string
	Ticks uint64
}
type Clock interface{ Read() (Reading, error) }
type PermitRequest struct {
	Execution
	Challenge string `json:"challenge"`
}

// Permit is returned only by a transport adapter which has verified the
// platform signature. The use case still compares every immutable binding.
type Permit struct {
	PermitRequest
	PermitID     string `json:"permitId"`
	BudgetMillis int    `json:"budgetMillis"`
}
type Platform interface {
	Claim(context.Context, Execution) error
	Permit(context.Context, PermitRequest) (Permit, error)
}
