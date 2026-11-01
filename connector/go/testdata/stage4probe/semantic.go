package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"time"

	"example.com/ai-database-workspace/connector/internal/agent"
)

type probeAPIError struct {
	method, path string
	status       int
}

func (e *probeAPIError) Error() string {
	return fmt.Sprintf("API %s %s returned %d", e.method, e.path, e.status)
}

// The caller verifies both the random fixture database name and the dedicated
// MySQL instance before supplying this connection. No original data is used.
func verifySemanticStructure(ctx context.Context, client *agent.Client, cfg agent.Config, vault agent.Vault, root *sql.DB, request func(string, string, any, any) error, base, workspace, source, database string) error {
	semanticPath := "/api/semantics/" + workspace + "/" + source
	type semanticState struct {
		Revision   int      `json:"revision"`
		SnapshotID string   `json:"snapshotId"`
		Stale      []string `json:"stale"`
	}
	scan := func() (semanticState, error) {
		var state semanticState
		if err := request("POST", base+"/scan", nil, nil); err != nil {
			return state, err
		}
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			if err := agent.Sync(ctx, client, cfg, vault); err != nil {
				return state, err
			}
			var status struct {
				Scan struct {
					Status string `json:"status"`
				} `json:"scan"`
			}
			if err := request("GET", base+"/scan", nil, &status); err != nil {
				return state, err
			}
			if status.Scan.Status == "completed" {
				err := request("GET", semanticPath, nil, &state)
				return state, err
			}
			if status.Scan.Status != "pending" {
				return state, fmt.Errorf("semantic scan failed: %s", status.Scan.Status)
			}
			time.Sleep(30 * time.Millisecond)
		}
		return state, errors.New("semantic scan timed out")
	}
	save := func(state semanticState, typ string) error {
		document := map[string]any{
			"entities": []any{}, "relationships": []any{}, "metrics": []any{},
			"fields": []any{map[string]any{
				"name": "Customer name", "description": "Synthetic semantic description", "aliases": []string{"client name"},
				"sensitivity": "normal", "table": "customers", "column": "name", "type": typ,
			}},
		}
		return request("PUT", semanticPath, map[string]any{"revision": state.Revision, "snapshotId": state.SnapshotID, "document": document}, nil)
	}
	modelSchema := func() (string, map[string]any, error) {
		var job struct{ ID string }
		input := map[string]any{}
		if err := request("POST", base+"/queries/model-schema", input, &job); err != nil {
			return "", nil, err
		}
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			if err := agent.Sync(ctx, client, cfg, vault); err != nil {
				return "", nil, err
			}
			var status struct{ State string }
			if err := request("GET", base+"/queries/"+job.ID, nil, &status); err != nil {
				return "", nil, err
			}
			if status.State == "completed" {
				return job.ID, input, nil
			}
			if status.State != "queued" && status.State != "running" {
				return "", nil, fmt.Errorf("semantic model schema failed: %s", status.State)
			}
			time.Sleep(30 * time.Millisecond)
		}
		return "", nil, errors.New("semantic model schema timed out")
	}
	var preview struct {
		SchemaHash  string                                         `json:"schemaHash"`
		Destination struct{ BaseURL, Model, ConfigVersion string } `json:"destination"`
		Semantics   struct {
			Fields []struct{ Description string } `json:"fields"`
		} `json:"semantics"`
	}
	state, err := scan()
	if err != nil {
		return err
	}
	if err = save(state, "varchar(50)"); err != nil {
		return err
	}
	id, _, err := modelSchema()
	if err != nil {
		return err
	}
	if err = request("GET", base+"/queries/"+id+"/model-preview", nil, &preview); err != nil {
		return err
	}
	if len(preview.Semantics.Fields) != 1 || preview.Semantics.Fields[0].Description != "Synthetic semantic description" {
		return errors.New("initial semantic preview omitted saved definition")
	}
	var before struct{ Requests int }
	if err = request("GET", "/fixture/model-requests", nil, &before); err != nil {
		return err
	}
	if _, err = root.ExecContext(ctx, "ALTER TABLE `"+database+"`.customers MODIFY COLUMN name VARCHAR(60)"); err != nil {
		return err
	}
	id, _, err = modelSchema()
	if err != nil {
		return err
	}
	var rejected *probeAPIError
	err = request("GET", base+"/queries/"+id+"/model-preview", nil, &preview)
	if !errors.As(err, &rejected) || rejected.status != http.StatusConflict {
		return fmt.Errorf("unscanned VARCHAR change did not reject stale semantics: %v", err)
	}
	var after struct{ Requests int }
	if err = request("GET", "/fixture/model-requests", nil, &after); err != nil {
		return err
	}
	if before.Requests != after.Requests {
		return errors.New("stale semantic preview contacted the model")
	}
	state, err = scan()
	if err != nil {
		return err
	}
	if len(state.Stale) != 1 {
		return errors.New("rescan did not report the changed semantic field")
	}
	if err = save(state, "varchar(60)"); err != nil {
		return err
	}
	id, input, err := modelSchema()
	if err != nil {
		return err
	}
	if err = request("GET", base+"/queries/"+id+"/model-preview", nil, &preview); err != nil {
		return err
	}
	if len(preview.Semantics.Fields) != 1 {
		return errors.New("repaired semantics did not recover preview")
	}
	planInput := map[string]any{"instanceId": input["instanceId"], "scopeToken": input["scopeToken"], "submittedAt": time.Now().UnixMilli(), "question": "查询客户编号", "schemaHash": preview.SchemaHash, "baseUrl": preview.Destination.BaseURL, "model": preview.Destination.Model, "configVersion": preview.Destination.ConfigVersion}
	var plan struct{ Plan struct{ Kind, SQL string } }
	done := make(chan error, 1)
	go func() { done <- request("POST", base+"/queries/"+id+"/model-plan", planInput, &plan) }()
	deadline := time.Now().Add(25 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err = <-done:
			if err != nil {
				return err
			}
			if plan.Plan.Kind != "query" || plan.Plan.SQL != "SELECT `id`, `name` FROM `customers`" {
				return errors.New("repaired semantics did not recover model planning")
			}
			return nil
		default:
			if err = agent.Sync(ctx, client, cfg, vault); err != nil {
				return err
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	return errors.New("repaired semantic model plan timed out")
}
