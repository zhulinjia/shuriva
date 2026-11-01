package mutationguard

import (
	"sort"
)

func Columns(t Table) map[string]Column {
	out := map[string]Column{}
	for _, c := range t.Columns {
		out[c.Name] = c
	}
	return out
}
func Primary(t Table) []Column {
	var out []Column
	for _, c := range t.Columns {
		if c.PrimaryOrdinal > 0 {
			out = append(out, c)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PrimaryOrdinal < out[j].PrimaryOrdinal })
	return out
}
func ValidateTable(t Table) error {
	if !t.Complete || !t.BaseTable || t.Engine != "InnoDB" || !ValidIdentifier(t.Database) || !ValidIdentifier(t.Name) || t.Triggers != 0 || t.IncomingForeignKeys != 0 || t.OutgoingForeignKeys != 0 || t.Checks != 0 || len(t.Columns) == 0 || len(t.Columns) > 256 || t.Definition == "" {
		return ErrDenied
	}
	seen := map[string]bool{}
	for _, c := range t.Columns {
		if !ValidIdentifier(c.Name) || seen[c.Name] || c.Generated || c.OnUpdate || c.ExpressionDefault {
			return ErrDenied
		}
		seen[c.Name] = true
		switch c.Kind {
		case "integer":
			if c.Bits != 8 && c.Bits != 16 && c.Bits != 24 && c.Bits != 32 && c.Bits != 64 {
				return ErrDenied
			}
		case "decimal":
			if c.Precision < 1 || c.Precision > 65 || c.Scale < 0 || c.Scale > 30 || c.Scale > c.Precision {
				return ErrDenied
			}
		case "string", "binary":
			if c.MaxLength < 1 || c.MaxLength > MaxCellBytes {
				return ErrDenied
			}
		case "datetime":
			if c.Scale < 0 || c.Scale > 6 {
				return ErrDenied
			}
		case "date", "boolean":
		default:
			return ErrDenied
		}
		if c.AutoIncrement && (c.Kind != "integer" || c.PrimaryOrdinal == 0) {
			return ErrDenied
		}
		if c.Default != nil {
			if _, err := Normalize(c, *c.Default); err != nil {
				return ErrDenied
			}
		}
	}
	pk := Primary(t)
	if len(pk) == 0 || len(pk) > 8 {
		return ErrDenied
	}
	for i, c := range pk {
		if c.PrimaryOrdinal != i+1 || c.Nullable {
			return ErrDenied
		}
	}
	return nil
}
func ValidatePolicy(t Table, p Policy) error {
	if ValidateTable(t) != nil || p.Database != t.Database || p.Table != t.Name || p.Generation == "" || p.MaxRows < 1 || p.MaxRows > MaxRows || p.MaxBytes < 1 || p.MaxBytes > MaxBytes || len(p.RowPredicates) > 32 {
		return ErrDenied
	}
	cols := Columns(t)
	preview := map[string]bool{}
	for _, name := range p.PreviewColumns {
		if _, ok := cols[name]; !ok || preview[name] {
			return ErrDenied
		}
		preview[name] = true
	}
	for _, pk := range Primary(t) {
		if !preview[pk.Name] {
			return ErrDenied
		}
	}
	protected := map[string]bool{}
	for _, pred := range p.RowPredicates {
		if validPredicate(pred) != nil {
			return ErrDenied
		}
		c, ok := cols[pred.Column]
		if !ok || typedPredicate(c, pred) != nil {
			return ErrDenied
		}
		if pred.Value != nil {
			if _, err := Normalize(c, *pred.Value); err != nil {
				return ErrDenied
			}
		}
		protected[pred.Column] = true
	}
	for _, list := range [][]string{p.InsertColumns, p.UpdateColumns} {
		seen := map[string]bool{}
		for _, name := range list {
			if _, ok := cols[name]; !ok || seen[name] || !preview[name] {
				return ErrDenied
			}
			seen[name] = true
		}
	}
	for _, name := range p.UpdateColumns {
		if cols[name].PrimaryOrdinal > 0 || protected[name] {
			return ErrDenied
		}
	}
	return nil
}
