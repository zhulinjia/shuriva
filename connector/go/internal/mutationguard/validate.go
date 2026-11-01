package mutationguard

import (
	"regexp"
	"unicode/utf8"
)

var identifier = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)
var integer = regexp.MustCompile(`^-?(0|[1-9][0-9]*)$`)
var decimal = regexp.MustCompile(`^-?(0|[1-9][0-9]*)(\.[0-9]+)?$`)

func ValidIdentifier(v string) bool { return identifier.MatchString(v) }
func Quote(v string) (string, error) {
	if !ValidIdentifier(v) {
		return "", ErrDenied
	}
	return "`" + v + "`", nil
}

func ValidateShape(p Plan) error {
	if !ValidIdentifier(p.Table) {
		return ErrDenied
	}
	switch p.Operation {
	case "insert":
		if len(p.Rows) == 0 || len(p.Rows) > MaxRows || len(p.Changes) != 0 || len(p.Where) != 0 {
			return ErrDenied
		}
		for _, r := range p.Rows {
			if len(r) == 0 || len(r) > 256 {
				return ErrDenied
			}
			if validAssignments(r) != nil {
				return ErrDenied
			}
		}
	case "update":
		if len(p.Rows) != 0 || len(p.Changes) == 0 || len(p.Changes) > 256 || len(p.Where) == 0 || len(p.Where) > 32 || validAssignments(p.Changes) != nil {
			return ErrDenied
		}
	case "delete":
		if len(p.Rows) != 0 || len(p.Changes) != 0 || len(p.Where) == 0 || len(p.Where) > 32 {
			return ErrDenied
		}
	default:
		return ErrDenied
	}
	for _, where := range p.Where {
		if validPredicate(where) != nil {
			return ErrDenied
		}
	}
	return nil
}
func validAssignments(a []Assignment) error {
	seen := map[string]bool{}
	for _, a := range a {
		if !ValidIdentifier(a.Column) || seen[a.Column] || basicValue(a.Value) != nil {
			return ErrDenied
		}
		seen[a.Column] = true
	}
	return nil
}
func basicValue(v Value) error {
	if !utf8.ValidString(v.Value) || len(v.Value) > MaxCellBytes {
		return ErrDenied
	}
	switch v.Kind {
	case "null":
		if v.Value != "" {
			return ErrDenied
		}
	case "string", "integer", "decimal", "binary", "date", "datetime", "boolean":
	default:
		return ErrDenied
	}
	return nil
}
func validPredicate(p Predicate) error {
	if !ValidIdentifier(p.Column) {
		return ErrDenied
	}
	if p.Operator == "is_null" || p.Operator == "not_null" {
		if p.Value != nil {
			return ErrDenied
		}
		return nil
	}
	if p.Operator != "eq" && p.Operator != "ne" && p.Operator != "lt" && p.Operator != "lte" && p.Operator != "gt" && p.Operator != "gte" {
		return ErrDenied
	}
	if p.Value == nil || p.Value.Kind == "null" {
		return ErrDenied
	}
	return basicValue(*p.Value)
}

// Native MySQL text collations can narrow inequalities differently from our
// exact local comparison. Equality is a candidate superset and is rechecked;
// ordering/not-equal text predicates need a separately validated collation
// compiler before they can represent a complete target set.
func typedPredicate(c Column, p Predicate) error {
	if validPredicate(p) != nil {
		return ErrDenied
	}
	if c.Kind == "string" && p.Operator != "eq" && p.Operator != "is_null" && p.Operator != "not_null" {
		return ErrDenied
	}
	return nil
}
