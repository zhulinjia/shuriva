package mutationguard

import (
	"bytes"
	"encoding/json"
	"io"
	"unicode/utf8"
)

// Reject duplicate keys before decoding typed structures. encoding/json's
// default last-key-wins semantics are inappropriate at this security boundary.
func uniqueJSON(d *json.Decoder, depth int) error {
	if depth > 32 {
		return ErrDenied
	}
	t, err := d.Token()
	if err != nil {
		return ErrDenied
	}
	switch t {
	case json.Delim('{'):
		seen := map[string]bool{}
		for d.More() {
			key, err := d.Token()
			if err != nil {
				return ErrDenied
			}
			name, ok := key.(string)
			if !ok || seen[name] || len(seen) >= 512 {
				return ErrDenied
			}
			seen[name] = true
			if err := uniqueJSON(d, depth+1); err != nil {
				return err
			}
		}
		end, err := d.Token()
		if err != nil || end != json.Delim('}') {
			return ErrDenied
		}
	case json.Delim('['):
		count := 0
		for d.More() {
			count++
			if count > 256 {
				return ErrDenied
			}
			if err := uniqueJSON(d, depth+1); err != nil {
				return err
			}
		}
		end, err := d.Token()
		if err != nil || end != json.Delim(']') {
			return ErrDenied
		}
	}
	return nil
}
func DecodePlan(raw []byte) (Plan, error) {
	var p Plan
	if len(raw) == 0 || len(raw) > MaxBytes || !utf8.Valid(raw) {
		return p, ErrDenied
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if uniqueJSON(d, 0) != nil {
		return p, ErrDenied
	}
	if _, err := d.Token(); err != io.EOF {
		return p, ErrDenied
	}
	d = json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&p) != nil {
		return Plan{}, ErrDenied
	}
	if err := ValidateShape(p); err != nil {
		return Plan{}, err
	}
	return p, nil
}
func (v *Value) UnmarshalJSON(raw []byte) error {
	var shape map[string]json.RawMessage
	if json.Unmarshal(raw, &shape) != nil || len(shape) != 2 || shape["kind"] == nil || shape["value"] == nil {
		return ErrDenied
	}
	type plain Value
	var out plain
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&out) != nil {
		return ErrDenied
	}
	*v = Value(out)
	return nil
}
