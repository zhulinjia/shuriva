package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"

	"example.com/ai-database-workspace/connector/internal/agent"
)

type vault struct{ data map[string]agent.KeyState }

func (v *vault) Get(id string) (agent.KeyState, error) {
	s, ok := v.data[id]
	if !ok {
		return s, fmt.Errorf("not found")
	}
	return s, nil
}
func (v *vault) Set(id string, s agent.KeyState) error { v.data[id] = s; return nil }
func (v *vault) Delete(id string) error                { delete(v.data, id); return nil }
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "probe failed:", err)
		os.Exit(1)
	}
}
func run() error {
	var input struct {
		Server string `json:"server"`
		Code   string `json:"code"`
	}
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "connector-probe-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "state.json")
	store := &vault{data: map[string]agent.KeyState{}}
	ctx := context.Background()
	if err = agent.PairNew(ctx, path, input.Server, "跨语言测试", input.Code, "probe-v1", store); err != nil {
		return err
	}
	cfg, err := agent.ReadConfig(path)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, input.Server+"/api/connectors/"+cfg.ConnectorID+"/diagnostics", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Origin", "http://127.0.0.1:5173")
	req.Header.Set("X-Test-Owner", "owner")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("diagnostic request returned %d", resp.StatusCode)
	}
	client, err := agent.NewClient(cfg.Server, "probe-v1")
	if err != nil {
		return err
	}
	if err = agent.Sync(ctx, client, cfg, store); err != nil {
		return err
	}
	if err = agent.StartRotation(ctx, client, cfg, store); err != nil {
		return err
	}
	if err = agent.Sync(ctx, client, cfg, store); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(struct {
		ID string `json:"id"`
	}{cfg.ConnectorID})
}
