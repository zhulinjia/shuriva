package mutationguard

import (
	"bytes"
	"encoding/base64"
	"math/big"
	"strings"
)

func NormalizeRow(t Table, row Row) (Row, error) {
	if len(row) != len(t.Columns) {
		return nil, ErrDenied
	}
	out := Row{}
	for _, c := range t.Columns {
		v, ok := row[c.Name]
		if !ok {
			return nil, ErrDenied
		}
		n, err := Normalize(c, v)
		if err != nil {
			return nil, err
		}
		out[c.Name] = n
	}
	return out, nil
}
func Matches(t Table, row Row, predicates []Predicate) (bool, error) {
	cols := Columns(t)
	for _, p := range predicates {
		c, ok := cols[p.Column]
		if !ok || typedPredicate(c, p) != nil {
			return false, ErrDenied
		}
		actual, ok := row[p.Column]
		if !ok {
			return false, ErrDenied
		}
		actual, err := Normalize(c, actual)
		if err != nil {
			return false, err
		}
		if p.Operator == "is_null" {
			if actual.Kind != "null" {
				return false, nil
			}
			continue
		}
		if p.Operator == "not_null" {
			if actual.Kind == "null" {
				return false, nil
			}
			continue
		}
		if actual.Kind == "null" {
			return false, nil
		}
		wanted, err := Normalize(c, *p.Value)
		if err != nil {
			return false, err
		}
		comparison := strings.Compare(actual.Value, wanted.Value)
		if c.Kind == "integer" || c.Kind == "decimal" {
			a, ok1 := new(big.Rat).SetString(actual.Value)
			b, ok2 := new(big.Rat).SetString(wanted.Value)
			if !ok1 || !ok2 {
				return false, ErrDenied
			}
			comparison = a.Cmp(b)
		}
		if c.Kind == "binary" {
			a, _ := base64.StdEncoding.DecodeString(actual.Value)
			b, _ := base64.StdEncoding.DecodeString(wanted.Value)
			comparison = bytes.Compare(a, b)
		}
		match := false
		switch p.Operator {
		case "eq":
			match = comparison == 0
		case "ne":
			match = comparison != 0
		case "lt":
			match = comparison < 0
		case "lte":
			match = comparison <= 0
		case "gt":
			match = comparison > 0
		case "gte":
			match = comparison >= 0
		}
		if !match {
			return false, nil
		}
	}
	return true, nil
}
