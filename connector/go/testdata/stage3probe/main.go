// This isolated integration probe uses synthetic credentials and in-memory vaults.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"

	"example.com/ai-database-workspace/connector/internal/agent"
	"example.com/ai-database-workspace/connector/internal/datasource"
)

type identityVault struct{ data map[string]agent.KeyState }

func (v *identityVault) Get(id string) (agent.KeyState, error) {
	s, ok := v.data[id]
	if !ok {
		return s, errors.New("missing")
	}
	return s, nil
}
func (v *identityVault) Set(id string, s agent.KeyState) error { v.data[id] = s; return nil }
func (v *identityVault) Delete(id string) error                { delete(v.data, id); return nil }

type sourceVault struct{ p datasource.Profile }

func (v sourceVault) Get(id string) (datasource.Profile, error) {
	if id != v.p.ID {
		return datasource.Profile{}, errors.New("missing")
	}
	return v.p, nil
}
func (v sourceVault) Set(p datasource.Profile) error { return errors.New("unsupported") }
func (v sourceVault) Delete(id string) error         { return errors.New("unsupported") }

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "stage 3 probe failed:", err)
		os.Exit(1)
	}
}
func run() error {
	var input struct {
		Server         string `json:"server"`
		Code           string `json:"code"`
		Owner          string `json:"owner"`
		Workspace      string `json:"workspace"`
		Source         string `json:"source"`
		SourceDatabase string `json:"sourceDatabase"`
		SourceUsername string `json:"sourceUsername"`
		SourcePassword string `json:"sourcePassword"`
	}
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "stage3-probe-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "config.json")
	vault := &identityVault{data: map[string]agent.KeyState{}}
	ctx := context.Background()
	if err = agent.PairNew(ctx, path, input.Server, "isolated test", input.Code, "test", vault); err != nil {
		return err
	}
	cfg, err := agent.ReadConfig(path)
	if err != nil {
		return err
	}
	post := func(method, path string, body any) error {
		var b []byte
		if body != nil {
			b, _ = json.Marshal(body)
		}
		req, err := http.NewRequest(method, input.Server+path, bytes.NewReader(b))
		if err != nil {
			return err
		}
		req.Header.Set("Origin", "http://127.0.0.1:5173")
		req.Header.Set("X-Test-Owner", input.Owner)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("test API returned %d", resp.StatusCode)
		}
		return nil
	}
	if err = post("POST", "/api/data-sources", map[string]string{"id": input.Source, "connectorId": cfg.ConnectorID, "name": "test source"}); err != nil {
		return err
	}
	base := "/api/data-sources/workspaces/" + input.Workspace + "/" + input.Source
	if err = post("PUT", base, nil); err != nil {
		return err
	}
	client, err := agent.NewClient(cfg.Server, "test")
	if err != nil {
		return err
	}
	client.SourceVault = sourceVault{p: datasource.Profile{ID: input.Source, ConnectorID: cfg.ConnectorID, WorkspaceIDs: []string{input.Workspace}, Host: "127.0.0.1", Port: 13307, Database: input.SourceDatabase, Username: input.SourceUsername, Password: input.SourcePassword, TLS: "local"}}
	if err = agent.Sync(ctx, client, cfg, vault); err != nil {
		return err
	}
	if err = post("POST", base+"/scan", nil); err != nil {
		return err
	}
	if err = agent.Sync(ctx, client, cfg, vault); err != nil {
		return err
	}
	// Re-pair another connector, transfer the same source ID after unbinding,
	// and verify that it can publish a new scan without losing prior history.
	if err = post("DELETE", base, nil); err != nil {
		return err
	}
	req, err := http.NewRequest("POST", input.Server+"/api/connectors/pairings", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Origin", "http://127.0.0.1:5173")
	req.Header.Set("X-Test-Owner", input.Owner)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	var offer struct{ PairingID, Secret, PlatformPublicKey string }
	err = json.NewDecoder(response.Body).Decode(&offer)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusCreated {
		return errors.New("second pairing offer failed")
	}
	path2 := filepath.Join(dir, "config2.json")
	if err = agent.PairNew(ctx, path2, input.Server, "replacement test", offer.PairingID+"."+offer.Secret+"."+offer.PlatformPublicKey, "test", vault); err != nil {
		return err
	}
	cfg2, err := agent.ReadConfig(path2)
	if err != nil {
		return err
	}
	if err = post("PUT", "/api/data-sources/"+input.Source+"/connector", map[string]string{"connectorId": cfg2.ConnectorID}); err != nil {
		return err
	}
	if err = post("PUT", base, nil); err != nil {
		return err
	}
	client2, err := agent.NewClient(cfg2.Server, "test")
	if err != nil {
		return err
	}
	client2.SourceVault = sourceVault{p: datasource.Profile{ID: input.Source, ConnectorID: cfg2.ConnectorID, WorkspaceIDs: []string{input.Workspace}, Host: "127.0.0.1", Port: 13307, Database: input.SourceDatabase, Username: input.SourceUsername, Password: input.SourcePassword, TLS: "local"}}
	if err = post("POST", base+"/scan", nil); err != nil {
		return err
	}
	if err = agent.Sync(ctx, client2, cfg2, vault); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]string{"connectorId": cfg2.ConnectorID, "firstConnectorId": cfg.ConnectorID})
}
