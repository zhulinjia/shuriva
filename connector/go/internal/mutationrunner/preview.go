package mutationrunner

import (
	"context"
	"encoding/json"
	"time"

	"example.com/ai-database-workspace/connector/internal/mutationguard"
)

func (r *Runner) Preview(ctx context.Context, plan mutationguard.Plan) (Preview, error) {
	operationScope, finish, err := r.work(ctx)
	if err != nil {
		return Preview{}, err
	}
	defer finish()
	ctx = operationScope
	if err := r.ready(ctx); err != nil {
		return Preview{}, err
	}
	select {
	case r.previewSlot <- struct{}{}:
		defer func() { <-r.previewSlot }()
	case <-ctx.Done():
		return Preview{}, ErrDenied
	}
	start, err := r.read()
	if err != nil {
		return Preview{}, err
	}
	expires, err := addTicks(start.Ticks, leaseTicks)
	if err != nil {
		return Preview{}, err
	}
	policy, ok := r.config.Policies[plan.Table]
	if !ok {
		return Preview{}, ErrDenied
	}
	operation, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	tx, err := r.target.Begin(operation, r.config.Binding)
	if err != nil {
		return Preview{}, ErrDenied
	}
	defer tx.Rollback()
	table, err := tx.Describe(operation, plan.Table)
	if err != nil {
		return Preview{}, ErrDenied
	}
	if _, err := mutationguard.StructuralDefinition(table.Definition, table.SQLMode); err != nil {
		return Preview{}, ErrDenied
	}
	plan, err = mutationguard.Validate(table, policy, plan)
	if err != nil {
		return Preview{}, ErrDenied
	}
	var originals []mutationguard.Row
	changes := []Change{}
	if plan.Operation == "insert" {
		for _, values := range plan.Rows {
			newRow, err := mutationguard.InsertRow(table, values)
			if err != nil {
				return Preview{}, ErrDenied
			}
			allowed, err := mutationguard.Matches(table, newRow, policy.RowPredicates)
			if err != nil || !allowed {
				return Preview{}, ErrDenied
			}
			change := Change{After: mutationguard.Project(newRow, policy.PreviewColumns)}
			visible, provided := map[string]bool{}, map[string]bool{}
			for _, name := range policy.PreviewColumns {
				visible[name] = true
			}
			for _, value := range values {
				provided[value.Column] = true
			}
			for _, column := range table.Columns {
				if !visible[column.Name] || provided[column.Name] {
					continue
				}
				if column.AutoIncrement {
					change.GeneratedColumns = append(change.GeneratedColumns, column.Name)
				} else {
					change.DefaultColumns = append(change.DefaultColumns, column.Name)
				}
			}
			changes = append(changes, change)
		}
	} else {
		where := append(append([]mutationguard.Predicate{}, plan.Where...), policy.RowPredicates...)
		statement, err := mutationguard.Select(table, where, policy.MaxRows+1, false)
		if err != nil {
			return Preview{}, err
		}
		rows, err := tx.Rows(operation, statement)
		if err != nil || len(rows) == 0 || len(rows) > policy.MaxRows {
			return Preview{}, ErrDenied
		}
		changed := 0
		for _, row := range rows {
			row, err := mutationguard.NormalizeRow(table, row)
			if err != nil {
				return Preview{}, err
			}
			allowed, err := mutationguard.Matches(table, row, where)
			if err != nil || !allowed {
				return Preview{}, ErrDenied
			}
			originals = append(originals, row)
			change := Change{Before: mutationguard.Project(row, policy.PreviewColumns)}
			if plan.Operation == "update" {
				newRow := cloneRow(row)
				for _, a := range plan.Changes {
					newRow[a.Column] = a.Value
				}
				allowed, err := mutationguard.Matches(table, newRow, policy.RowPredicates)
				if err != nil || !allowed {
					return Preview{}, ErrDenied
				}
				change.After = mutationguard.Project(newRow, policy.PreviewColumns)
				if !sameRow(row, newRow) {
					changed++
				}
			}
			changes = append(changes, change)
		}
		if plan.Operation == "update" && changed == 0 {
			return Preview{}, ErrDenied
		}
	}
	if err := tx.Rollback(); err != nil {
		return Preview{}, ErrDenied
	}
	if err := r.ready(operation); err != nil {
		return Preview{}, err
	}
	id, err := randomID()
	if err != nil {
		return Preview{}, err
	}
	payload := leasePayload{PreviewID: id, Binding: r.config.Binding, Plan: plan, Table: table, Rows: originals, ClockEpoch: start.Epoch, ExpiresTicks: expires}
	payload.ReconciliationDeadline = time.Now().UTC().Add(24 * time.Hour).Unix()
	raw, err := json.Marshal(payload)
	if err != nil || len(raw) > policy.MaxBytes {
		return Preview{}, ErrDenied
	}
	publicRaw, err := json.Marshal(changes)
	if err != nil || len(publicRaw) > policy.MaxBytes {
		return Preview{}, ErrDenied
	}
	commitment := r.commitment(raw)
	wallExpiry := time.Now().UTC().Add(2 * time.Minute)
	if err := r.journal.SaveLease(operation, Lease{ID: id, Scope: r.config.Binding.Scope, Commitment: commitment, ExpiresAt: wallExpiry.Unix(), ReconciliationExpiresAt: payload.ReconciliationDeadline, Payload: raw}); err != nil {
		r.freeze(ctx, "journal_unavailable")
		return Preview{}, ErrDenied
	}
	return Preview{Binding: r.config.Binding, PreviewID: id, Commitment: commitment, Revision: 1, Operation: plan.Operation, Table: plan.Table, RowCount: len(changes), ExpiresAt: wallExpiry.Format(time.RFC3339Nano), Rows: changes}, nil
}
