package mutationguard

import (
	"sort"
)

func Validate(t Table, p Policy, plan Plan) (Plan, error) {
	if ValidateShape(plan) != nil || ValidatePolicy(t, p) != nil || plan.Table != t.Name {
		return Plan{}, ErrDenied
	}
	cols := Columns(t)
	allowed := map[string]bool{}
	if plan.Operation == "delete" && !p.Delete {
		return Plan{}, ErrDenied
	}
	list := p.InsertColumns
	if plan.Operation == "update" {
		list = p.UpdateColumns
	}
	for _, c := range list {
		allowed[c] = true
	}
	check := func(assignments []Assignment) ([]Assignment, error) {
		out := make([]Assignment, len(assignments))
		for i, a := range assignments {
			c, ok := cols[a.Column]
			if !ok || !allowed[a.Column] {
				return nil, ErrDenied
			}
			value, err := Normalize(c, a.Value)
			if err != nil {
				return nil, err
			}
			out[i] = Assignment{a.Column, value}
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Column < out[j].Column })
		return out, nil
	}
	var err error
	if plan.Operation == "insert" {
		if len(plan.Rows) > p.MaxRows {
			return Plan{}, ErrDenied
		}
		rows := make([][]Assignment, len(plan.Rows))
		for i, row := range plan.Rows {
			rows[i], err = check(row)
			if err != nil {
				return Plan{}, err
			}
			if _, err := InsertRow(t, rows[i]); err != nil {
				return Plan{}, err
			}
		}
		plan.Rows = rows
	}
	if plan.Operation == "update" {
		plan.Changes, err = check(plan.Changes)
		if err != nil {
			return Plan{}, err
		}
	}
	where := make([]Predicate, len(plan.Where))
	visible := map[string]bool{}
	for _, name := range p.PreviewColumns {
		visible[name] = true
	}
	for i, pred := range plan.Where {
		c, ok := cols[pred.Column]
		if !ok || !visible[pred.Column] || typedPredicate(c, pred) != nil {
			return Plan{}, ErrDenied
		}
		if pred.Value != nil {
			v, err := Normalize(c, *pred.Value)
			if err != nil {
				return Plan{}, err
			}
			pred.Value = &v
		}
		where[i] = pred
	}
	plan.Where = where
	return plan, nil
}

// InsertRow predicts only literal/NULL defaults. An omitted auto increment PK
// is represented by absence until the adapter returns its reliable identifier.
func InsertRow(t Table, values []Assignment) (Row, error) {
	out := Row{}
	for _, a := range values {
		out[a.Column] = a.Value
	}
	for _, c := range t.Columns {
		if _, ok := out[c.Name]; ok {
			continue
		}
		if c.AutoIncrement {
			continue
		}
		if c.Default != nil {
			v, err := Normalize(c, *c.Default)
			if err != nil {
				return nil, err
			}
			out[c.Name] = v
		} else if c.Nullable {
			out[c.Name] = Value{Kind: "null"}
		} else {
			return nil, ErrDenied
		}
	}
	return out, nil
}
func Project(row Row, columns []string) Row {
	out := Row{}
	for _, name := range columns {
		if v, ok := row[name]; ok {
			out[name] = v
		}
	}
	return out
}
