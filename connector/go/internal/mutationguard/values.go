package mutationguard

import (
	"encoding/base64"
	"math/big"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

func Normalize(c Column, v Value) (Value, error) {
	if basicValue(v) != nil {
		return Value{}, ErrDenied
	}
	if v.Kind == "null" {
		if !c.Nullable {
			return Value{}, ErrDenied
		}
		return v, nil
	}
	if v.Kind != c.Kind {
		return Value{}, ErrDenied
	}
	switch c.Kind {
	case "integer":
		if c.Bits != 8 && c.Bits != 16 && c.Bits != 24 && c.Bits != 32 && c.Bits != 64 {
			return Value{}, ErrDenied
		}
		if !integer.MatchString(v.Value) {
			return Value{}, ErrDenied
		}
		n, ok := new(big.Int).SetString(v.Value, 10)
		if !ok {
			return Value{}, ErrDenied
		}
		limit := new(big.Int).Lsh(big.NewInt(1), uint(c.Bits))
		min := big.NewInt(0)
		max := new(big.Int).Sub(limit, big.NewInt(1))
		if !c.Unsigned {
			limit.Rsh(limit, 1)
			min.Neg(new(big.Int).Set(limit))
			max.Sub(limit, big.NewInt(1))
		}
		if n.Cmp(min) < 0 || n.Cmp(max) > 0 {
			return Value{}, ErrDenied
		}
		v.Value = n.String()
	case "decimal":
		if c.Precision < 1 || c.Precision > 65 || c.Scale < 0 || c.Scale > 30 || c.Scale > c.Precision {
			return Value{}, ErrDenied
		}
		if !decimal.MatchString(v.Value) {
			return Value{}, ErrDenied
		}
		negative := strings.HasPrefix(v.Value, "-")
		parts := strings.Split(strings.TrimPrefix(v.Value, "-"), ".")
		fraction := ""
		if len(parts) == 2 {
			fraction = parts[1]
		}
		digits := len(strings.TrimLeft(parts[0], "0"))
		if digits > c.Precision-c.Scale || len(fraction) > c.Scale {
			return Value{}, ErrDenied
		}
		fraction += strings.Repeat("0", c.Scale-len(fraction))
		v.Value = parts[0]
		if c.Scale > 0 {
			v.Value += "." + fraction
		}
		if negative && strings.Trim(v.Value, "0.") != "" {
			v.Value = "-" + v.Value
		}
	case "string":
		if c.MaxLength < 1 || c.MaxLength > MaxCellBytes || utf8.RuneCountInString(v.Value) > c.MaxLength {
			return Value{}, ErrDenied
		}
	case "binary":
		raw, err := base64.StdEncoding.DecodeString(v.Value)
		if err != nil || c.MaxLength < 1 || c.MaxLength > MaxCellBytes || len(raw) > c.MaxLength || base64.StdEncoding.EncodeToString(raw) != v.Value {
			return Value{}, ErrDenied
		}
	case "boolean":
		if v.Value != "true" && v.Value != "false" {
			return Value{}, ErrDenied
		}
	case "date":
		d, err := time.Parse("2006-01-02", v.Value)
		if err != nil || d.Year() < 1000 || d.Format("2006-01-02") != v.Value {
			return Value{}, ErrDenied
		}
	case "datetime":
		if c.Scale < 0 || c.Scale > 6 {
			return Value{}, ErrDenied
		}
		parts := strings.Split(v.Value, ".")
		if len(parts) > 2 || (len(parts) == 2 && (len(parts[1]) > c.Scale || len(parts[1]) == 0)) {
			return Value{}, ErrDenied
		}
		d, err := time.Parse("2006-01-02 15:04:05.999999", v.Value)
		if err != nil || d.Year() < 1000 {
			return Value{}, ErrDenied
		}
		v.Value = d.Format("2006-01-02 15:04:05")
		if c.Scale > 0 {
			fraction := d.Nanosecond() / 1000
			v.Value += "." + strconv.Itoa(1000000 + fraction)[1:1+c.Scale]
		}
	default:
		return Value{}, ErrDenied
	}
	return v, nil
}
