package datasource

import (
	"reflect"
	"testing"
)

func TestDelegatedScopeIsIntersectionAndDoesNotModifyPolicies(t *testing.T) {
	local := map[string][]string{"customers": {"id", "name", "secret"}, "orders": {"id"}}
	delegated := map[string][]string{"customers": {"id", "name", "other"}, "unknown": {"id"}}
	got, err := IntersectDelegatedReadScope(local, delegated)
	if err != nil || !reflect.DeepEqual(got, map[string][]string{"customers": {"id", "name"}}) {
		t.Fatalf("unexpected intersection: %v, %v", got, err)
	}
	got["customers"][0] = "changed"
	if local["customers"][0] != "id" || delegated["customers"][0] != "id" {
		t.Fatal("intersection mutated an input policy")
	}
}

func TestDelegatedScopeFailsClosedForEmptyInvalidAndCaseMismatch(t *testing.T) {
	local := map[string][]string{"customers": {"id", "name"}}
	for _, value := range []map[string][]string{
		nil, {}, {"customers": {}}, {"customers": {"ID"}}, {"customers": {"id", "id"}},
		{"customers": {"id;DROP"}}, {"other": {"id"}},
	} {
		if _, err := IntersectDelegatedReadScope(local, value); err == nil {
			t.Errorf("invalid or unauthorized scope accepted: %v", value)
		}
	}
	if _, err := IntersectDelegatedReadScope(map[string][]string{"customers": {"id"}, "invalid": {"id", "id"}}, map[string][]string{"customers": {"id"}}); err == nil {
		t.Fatal("invalid local policy must fail closed")
	}
}
