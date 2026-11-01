package mutationrunner

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strconv"
	"time"

	"example.com/ai-database-workspace/connector/internal/mutationguard"
)

func (r *Runner) Execute(ctx context.Context, e Execution) (Result, error) {
	if !validExecution(e) || e.Scope != r.config.Binding.Scope {
		return Result{Execution: e, State: "rejected", Code: "stale_binding"}, ErrDenied
	}
	if e.Binding != r.config.Binding {
		r.Block(context.WithoutCancel(ctx), "recovery_unproven")
		return Result{Execution: e, State: "outcome_unknown", Code: "recovery_unproven"}, ErrUnknown
	}
	operationScope, finish, err := r.work(ctx)
	if err != nil {
		return Result{Execution: e, State: "rejected", Code: "closed"}, err
	}
	defer finish()
	ctx = operationScope
	if err := r.config.Coordinator.beginRegistration(ctx); err != nil {
		return Result{Execution: e, State: "rejected", Code: "cancelled"}, err
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		r.config.Coordinator.endRegistration()
		return Result{Execution: e, State: "rejected", Code: "closed"}, ErrDenied
	}
	if _, exists := r.active[e.ExecutionID]; exists {
		r.mu.Unlock()
		r.config.Coordinator.endRegistration()
		return r.Status(ctx, e.Scope, e.ExecutionID)
	}
	operation, cancel := context.WithTimeout(ctx, 15*time.Second)
	a := &activeExecution{execution: e, cancel: cancel}
	r.active[e.ExecutionID] = a
	r.mu.Unlock()
	r.config.Coordinator.endRegistration()
	defer cancel()
	defer func() { r.mu.Lock(); delete(r.active, e.ExecutionID); r.mu.Unlock() }()
	if previous, err := r.journal.Get(operation, e.ExecutionID, e.Scope); err == nil {
		if previous.Execution != e {
			return Result{Execution: e, State: "rejected", Code: "identity_conflict"}, ErrDenied
		}
		return result(previous), nil
	} else if !errors.Is(err, ErrNotFound) {
		r.freeze(context.WithoutCancel(ctx), "journal_unavailable")
		return Result{Execution: e, State: "rejected", Code: "journal_unavailable"}, err
	}
	if err := r.journal.Accept(operation, recordError(e, "accepted", "", 0)); err != nil {
		r.freeze(ctx, "journal_unavailable")
		return Result{Execution: e, State: "rejected", Code: "journal_unavailable"}, err
	}
	consumed := false
	reject := func(code string) (Result, error) {
		record := recordError(e, "rejected", code, 0)
		if r.persist(context.WithoutCancel(ctx), record) != nil {
			return Result{Execution: e, State: "outcome_unknown", Code: "journal_unavailable"}, ErrUnknown
		}
		// A different execution may own this same preview, including an
		// unresolved commit. Only its successful local consumer may delete it.
		if consumed {
			r.clearPayload(context.WithoutCancel(ctx), e)
		}
		return result(record), ErrDenied
	}
	if err := r.config.Coordinator.acquire(operation); err != nil {
		return reject("cancelled")
	}
	defer r.config.Coordinator.release()
	if r.ready(operation) != nil {
		return reject("frozen")
	}
	lease, err := r.loadLease(operation, e)
	if err != nil {
		return reject("preview_invalid")
	}
	policy, ok := r.config.Policies[lease.Plan.Table]
	if !ok {
		return reject("policy_changed")
	}
	if err := r.journal.Consume(operation, e); err != nil {
		return reject("consumed")
	}
	consumed = true
	if err := r.platform.Claim(operation, e); err != nil {
		return reject("claim_failed")
	}
	if err := r.persist(operation, recordError(e, "execution_started", "", 0)); err != nil {
		return Result{Execution: e, State: "outcome_unknown", Code: "journal_unavailable"}, err
	}
	start, err := r.read()
	if err != nil {
		return reject("clock_unavailable")
	}
	txDeadline, err := addTicks(start.Ticks, transactionTicks)
	if err != nil {
		return reject("clock_unavailable")
	}
	tx, err := r.target.Begin(operation, e.Binding)
	if err != nil {
		return reject("target_unavailable")
	}
	defer tx.Rollback()
	fail := func(code string) (Result, error) {
		state := "rolled_back"
		if tx.Rollback() != nil {
			state = "outcome_unknown"
			r.freeze(context.WithoutCancel(ctx), "rollback_unproven")
		}
		record := recordError(e, state, code, 0)
		if state == "outcome_unknown" {
			r.retainUnknown(context.WithoutCancel(ctx), &record)
		}
		if r.persist(context.WithoutCancel(ctx), record) != nil {
			return Result{Execution: e, State: "outcome_unknown", Code: "journal_unavailable"}, ErrUnknown
		}
		if state == "outcome_unknown" {
			return result(record), ErrUnknown
		}
		r.clearPayload(context.WithoutCancel(ctx), e)
		return result(record), ErrDenied
	}
	table, err := tx.Describe(operation, lease.Plan.Table)
	if err != nil || !unchangedTable(table, lease.Table) {
		return fail("structure_changed")
	}
	plan, err := mutationguard.Validate(table, policy, lease.Plan)
	if err != nil {
		return fail("policy_changed")
	}
	a.mu.Lock()
	cancelled := a.cancelled
	a.mu.Unlock()
	if cancelled || operation.Err() != nil {
		return fail("cancelled")
	}
	count, err := apply(operation, tx, table, policy, plan, lease.Rows)
	if err != nil {
		return fail("target_changed_or_denied")
	}
	if count < 1 || count > policy.MaxRows {
		return fail("row_limit")
	}
	if err := tx.PutReceipt(operation, Receipt{ExecutionID: e.ExecutionID, Commitment: e.Commitment, TargetIdentity: e.TargetIdentity, TargetEpoch: e.TargetEpoch, Scope: e.Scope, RowCount: count}); err != nil {
		return fail("receipt_failed")
	}
	first, err := r.read()
	if err != nil {
		return fail("clock_unavailable")
	}
	deadline, err := addTicks(first.Ticks, permitTicks)
	if err != nil {
		return fail("clock_unavailable")
	}
	if txDeadline < deadline {
		deadline = txDeadline
	}
	var challenge [32]byte
	if _, err := rand.Read(challenge[:]); err != nil {
		return fail("permit_failed")
	}
	request := PermitRequest{Execution: e, Challenge: base64.RawURLEncoding.EncodeToString(challenge[:])}
	grant, err := r.platform.Permit(operation, request)
	if err != nil || grant.PermitRequest != request || grant.BudgetMillis != 3000 || !uuidPattern.MatchString(grant.PermitID) {
		return fail("permit_failed")
	}
	// The same lock orders cancellation with the final qualification sample.
	// Journal persistence occurs before this sample, so it consumes the budget.
	a.mu.Lock()
	if a.cancelled || operation.Err() != nil {
		a.mu.Unlock()
		return fail("cancelled")
	}
	if r.persist(operation, recordError(e, "commit_intent", "", count)) != nil {
		a.mu.Unlock()
		return fail("journal_unavailable")
	}
	now, err := r.read()
	if err != nil || now.Epoch != first.Epoch || now.Ticks < first.Ticks || now.Ticks >= deadline || deadline-now.Ticks <= reserveTicks {
		a.mu.Unlock()
		return fail("permit_expired")
	}
	a.handoff = true
	commitErr := tx.Commit()
	a.mu.Unlock()
	state, code := "committed", ""
	if commitErr != nil {
		state, code = "outcome_unknown", "commit_unproven"
		r.freeze(context.WithoutCancel(ctx), code)
	}
	record := recordError(e, state, code, count)
	if state == "outcome_unknown" {
		r.retainUnknown(context.WithoutCancel(ctx), &record)
	}
	if r.persist(context.WithoutCancel(ctx), record) != nil {
		if state == "committed" {
			return Result{Execution: e, State: "committed", Code: "journal_unavailable", RowCount: count}, nil
		}
		return result(record), ErrUnknown
	}
	if state != "outcome_unknown" {
		r.clearPayload(context.WithoutCancel(ctx), e)
	}
	if state == "outcome_unknown" {
		return result(record), ErrUnknown
	}
	return result(record), nil
}

func apply(ctx context.Context, tx Transaction, t mutationguard.Table, p mutationguard.Policy, plan mutationguard.Plan, originals []mutationguard.Row) (int, error) {
	if plan.Operation == "insert" {
		return insert(ctx, tx, t, p, plan)
	}
	keys := make([]mutationguard.Row, 0, len(originals))
	oldByKey := map[string]mutationguard.Row{}
	for _, row := range originals {
		k, err := key(t, row)
		if err != nil {
			return 0, err
		}
		hash, err := contentHash(k)
		if err != nil || oldByKey[hash] != nil {
			return 0, ErrDenied
		}
		keys = append(keys, k)
		oldByKey[hash] = row
	}
	selectSQL, err := mutationguard.SelectKeys(t, keys, true)
	if err != nil {
		return 0, err
	}
	current, err := tx.Rows(ctx, selectSQL)
	if err != nil || len(current) != len(originals) {
		return 0, ErrDenied
	}
	count := 0
	for _, row := range current {
		row, err = mutationguard.NormalizeRow(t, row)
		if err != nil {
			return 0, err
		}
		k, err := key(t, row)
		if err != nil {
			return 0, err
		}
		hash, err := contentHash(k)
		if err != nil {
			return 0, err
		}
		old, exists := oldByKey[hash]
		if !exists || !sameRow(row, old) {
			return 0, ErrDenied
		}
		delete(oldByKey, hash)
		allowed, err := mutationguard.Matches(t, row, append(append([]mutationguard.Predicate{}, plan.Where...), p.RowPredicates...))
		if err != nil || !allowed {
			return 0, ErrDenied
		}
		var statement mutationguard.Statement
		var after mutationguard.Row
		if plan.Operation == "update" {
			after = cloneRow(row)
			for _, a := range plan.Changes {
				after[a.Column] = a.Value
			}
			if sameRow(row, after) {
				continue
			}
			allowed, err := mutationguard.Matches(t, after, p.RowPredicates)
			if err != nil || !allowed {
				return 0, ErrDenied
			}
			statement, err = mutationguard.Update(t, plan.Changes, k)
		} else {
			statement, err = mutationguard.Delete(t, k)
		}
		if err != nil {
			return 0, err
		}
		result, err := tx.Exec(ctx, statement)
		if err != nil || result.Affected != 1 {
			return 0, ErrDenied
		}
		read, err := mutationguard.SelectKeys(t, []mutationguard.Row{k}, true)
		if err != nil {
			return 0, err
		}
		real, err := tx.Rows(ctx, read)
		if err != nil {
			return 0, err
		}
		if plan.Operation == "delete" {
			if len(real) != 0 {
				return 0, ErrDenied
			}
		} else {
			if len(real) != 1 {
				return 0, ErrDenied
			}
			normalized, err := mutationguard.NormalizeRow(t, real[0])
			if err != nil || !sameRow(after, normalized) {
				return 0, ErrDenied
			}
			allowed, err := mutationguard.Matches(t, normalized, p.RowPredicates)
			if err != nil || !allowed {
				return 0, ErrDenied
			}
		}
		count++
	}
	if len(oldByKey) != 0 {
		return 0, ErrDenied
	}
	return count, nil
}
func insert(ctx context.Context, tx Transaction, t mutationguard.Table, p mutationguard.Policy, plan mutationguard.Plan) (int, error) {
	for _, row := range plan.Rows {
		predicted, err := mutationguard.InsertRow(t, row)
		if err != nil {
			return 0, err
		}
		statement, err := mutationguard.Insert(t, row)
		if err != nil {
			return 0, err
		}
		applied, err := tx.Exec(ctx, statement)
		if err != nil || applied.Affected != 1 {
			return 0, ErrDenied
		}
		for _, c := range mutationguard.Primary(t) {
			if _, provided := predicted[c.Name]; !provided {
				if !c.AutoIncrement || applied.LastInsertID < 1 {
					return 0, ErrDenied
				}
				v, err := mutationguard.Normalize(c, mutationguard.Value{Kind: "integer", Value: strconv.FormatInt(applied.LastInsertID, 10)})
				if err != nil {
					return 0, err
				}
				predicted[c.Name] = v
			}
		}
		k, err := key(t, predicted)
		if err != nil {
			return 0, err
		}
		query, err := mutationguard.SelectKeys(t, []mutationguard.Row{k}, true)
		if err != nil {
			return 0, err
		}
		actual, err := tx.Rows(ctx, query)
		if err != nil || len(actual) != 1 {
			return 0, ErrDenied
		}
		normalized, err := mutationguard.NormalizeRow(t, actual[0])
		if err != nil || !sameRow(normalized, predicted) {
			return 0, ErrDenied
		}
		allowed, err := mutationguard.Matches(t, normalized, p.RowPredicates)
		if err != nil || !allowed {
			return 0, ErrDenied
		}
	}
	return len(plan.Rows), nil
}
