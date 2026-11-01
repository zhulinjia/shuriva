package mutationguard

import (
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
)

func Argument(v Value) (any, error) {
	if basicValue(v) != nil {
		return nil, ErrDenied
	}
	switch v.Kind {
	case "null":
		return nil, nil
	case "integer":
		if !integer.MatchString(v.Value) {
			return nil, ErrDenied
		}
		if i, err := strconv.ParseInt(v.Value, 10, 64); err == nil {
			return i, nil
		}
		u, err := strconv.ParseUint(v.Value, 10, 64)
		if err != nil {
			return nil, ErrDenied
		}
		return u, nil
	case "decimal":
		if !decimal.MatchString(v.Value) {
			return nil, ErrDenied
		}
		return v.Value, nil
	case "boolean":
		if v.Value == "true" {
			return true, nil
		}
		if v.Value == "false" {
			return false, nil
		}
		return nil, ErrDenied
	case "binary":
		raw, err := base64.StdEncoding.DecodeString(v.Value)
		if err != nil {
			return nil, ErrDenied
		}
		return raw, nil
	case "string", "date", "datetime":
		return v.Value, nil
	}
	return nil, ErrDenied
}
func fullName(t Table) string { return "`" + t.Database + "`.`" + t.Name + "`" }
func predicates(t Table, where []Predicate) (string, []any, error) {
	cols := Columns(t)
	parts := make([]string, 0, len(where))
	var args []any
	for _, p := range where {
		c, ok := cols[p.Column]
		if !ok || typedPredicate(c, p) != nil {
			return "", nil, ErrDenied
		}
		name := "`" + c.Name + "`"
		if p.Operator == "is_null" {
			parts = append(parts, name+" IS NULL")
			continue
		}
		if p.Operator == "not_null" {
			parts = append(parts, name+" IS NOT NULL")
			continue
		}
		v, err := Normalize(c, *p.Value)
		if err != nil {
			return "", nil, err
		}
		a, err := Argument(v)
		if err != nil {
			return "", nil, err
		}
		args = append(args, a)
		op := map[string]string{"eq": "=", "ne": "<>", "lt": "<", "lte": "<=", "gt": ">", "gte": ">="}[p.Operator]
		parts = append(parts, name+" "+op+" ?")
	}
	return strings.Join(parts, " AND "), args, nil
}
func finish(t Table, s Statement) (Statement, error) {
	if err := VerifyStatement(t, s); err != nil {
		return Statement{}, err
	}
	return s, nil
}
func selectPrefix(t Table) string {
	names := make([]string, len(t.Columns))
	for i, c := range t.Columns {
		names[i] = "`" + c.Name + "`"
	}
	return "SELECT " + strings.Join(names, ", ") + " FROM " + fullName(t)
}
func order(t Table) string {
	names := []string{}
	for _, c := range Primary(t) {
		names = append(names, "`"+c.Name+"` ASC")
	}
	return " ORDER BY " + strings.Join(names, ", ")
}
func Select(t Table, where []Predicate, maxRows int, lock bool) (Statement, error) {
	if ValidateTable(t) != nil || maxRows < 1 || maxRows > MaxRows+1 || len(where) > 64 {
		return Statement{}, ErrDenied
	}
	w, args, err := predicates(t, where)
	if err != nil {
		return Statement{}, err
	}
	sql := selectPrefix(t)
	if w != "" {
		sql += " WHERE " + w
	}
	sql += order(t) + fmt.Sprintf(" LIMIT %d", maxRows)
	if lock {
		sql += " FOR UPDATE"
	}
	return finish(t, Statement{SQL: sql, Args: args, Columns: t.Columns, MaxRows: maxRows, Operation: "select"})
}
func keyWhere(t Table, key Row) (string, []any, error) {
	pk := Primary(t)
	if len(pk) == 0 {
		return "", nil, ErrDenied
	}
	parts := []string{}
	var args []any
	for _, c := range pk {
		v, ok := key[c.Name]
		if !ok {
			return "", nil, ErrDenied
		}
		v, err := Normalize(c, v)
		if err != nil || v.Kind == "null" {
			return "", nil, ErrDenied
		}
		a, err := Argument(v)
		if err != nil {
			return "", nil, err
		}
		parts = append(parts, "`"+c.Name+"` = ?")
		args = append(args, a)
	}
	return "(" + strings.Join(parts, " AND ") + ")", args, nil
}
func SelectKeys(t Table, keys []Row, lock bool) (Statement, error) {
	if ValidateTable(t) != nil || len(keys) == 0 || len(keys) > MaxRows {
		return Statement{}, ErrDenied
	}
	parts := []string{}
	var args []any
	for _, key := range keys {
		part, a, err := keyWhere(t, key)
		if err != nil {
			return Statement{}, err
		}
		parts = append(parts, part)
		args = append(args, a...)
	}
	sql := selectPrefix(t) + " WHERE " + strings.Join(parts, " OR ") + order(t) + fmt.Sprintf(" LIMIT %d", len(keys)+1)
	if lock {
		sql += " FOR UPDATE"
	}
	return finish(t, Statement{SQL: sql, Args: args, Columns: t.Columns, MaxRows: len(keys) + 1, Operation: "select"})
}
func Insert(t Table, row []Assignment) (Statement, error) {
	if ValidateTable(t) != nil || len(row) == 0 || validAssignments(row) != nil {
		return Statement{}, ErrDenied
	}
	cols := Columns(t)
	names, values := []string{}, []string{}
	var args []any
	for _, a := range row {
		c, ok := cols[a.Column]
		if !ok {
			return Statement{}, ErrDenied
		}
		v, err := Normalize(c, a.Value)
		if err != nil {
			return Statement{}, err
		}
		arg, err := Argument(v)
		if err != nil {
			return Statement{}, err
		}
		names = append(names, "`"+a.Column+"`")
		values = append(values, "?")
		args = append(args, arg)
	}
	return finish(t, Statement{SQL: "INSERT INTO " + fullName(t) + " (" + strings.Join(names, ", ") + ") VALUES (" + strings.Join(values, ", ") + ")", Args: args, Operation: "insert"})
}
func Update(t Table, changes []Assignment, key Row) (Statement, error) {
	if ValidateTable(t) != nil || len(changes) == 0 || validAssignments(changes) != nil {
		return Statement{}, ErrDenied
	}
	cols := Columns(t)
	sets := []string{}
	var args []any
	for _, a := range changes {
		c, ok := cols[a.Column]
		if !ok || c.PrimaryOrdinal > 0 {
			return Statement{}, ErrDenied
		}
		v, err := Normalize(c, a.Value)
		if err != nil {
			return Statement{}, err
		}
		arg, err := Argument(v)
		if err != nil {
			return Statement{}, err
		}
		sets = append(sets, "`"+a.Column+"` = ?")
		args = append(args, arg)
	}
	w, keyargs, err := keyWhere(t, key)
	if err != nil {
		return Statement{}, err
	}
	args = append(args, keyargs...)
	return finish(t, Statement{SQL: "UPDATE " + fullName(t) + " SET " + strings.Join(sets, ", ") + " WHERE " + w, Args: args, Operation: "update"})
}
func Delete(t Table, key Row) (Statement, error) {
	if ValidateTable(t) != nil {
		return Statement{}, ErrDenied
	}
	w, args, err := keyWhere(t, key)
	if err != nil {
		return Statement{}, err
	}
	return finish(t, Statement{SQL: "DELETE FROM " + fullName(t) + " WHERE " + w, Args: args, Operation: "delete"})
}
