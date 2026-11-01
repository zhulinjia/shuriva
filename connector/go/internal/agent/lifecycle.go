package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"

	"example.com/ai-database-workspace/connector/internal/datasource"
	"example.com/ai-database-workspace/connector/internal/diagnostics"
	"example.com/ai-database-workspace/connector/internal/protocol"
	"github.com/zalando/go-keyring"
)

var pairingID = regexp.MustCompile("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

// ErrAlreadyPaired means the existing identity was confirmed by the platform;
// the new one-time code supplied for recovery was not sent or consumed.
var ErrAlreadyPaired = errors.New("connector is already paired; the supplied code was not used")

func validCode(code string) bool {
	parts := strings.Split(code, ".")
	if len(parts) != 3 || !pairingID.MatchString(parts[0]) {
		return false
	}
	_, err := protocol.Decode(parts[1], 32)
	if err != nil {
		return false
	}
	_, err = protocol.Decode(parts[2], 32)
	return err == nil
}
func PairNew(ctx context.Context, configPath, server, name, code, version string, vault Vault) error {
	if !validCode(code) {
		return errors.New("invalid pairing code")
	}
	if !validName(name) {
		return errors.New("invalid connector name")
	}
	client, err := NewClient(server, version)
	if err != nil {
		return err
	}
	if _, err = os.Stat(configPath); err == nil {
		// A lost pairing response is ambiguous. Keep the same identity, first
		// confirm whether it is already registered, and only retry on denial.
		cfg, err := ReadConfig(configPath)
		if err != nil {
			return err
		}
		if cfg.Server != client.Server || cfg.PlatformPublicKey != strings.Split(code, ".")[2] {
			return errors.New("existing identity belongs to another platform; revoke it there and reset locally before changing platforms")
		}
		state, err := vault.Get(cfg.ConnectorID)
		if err != nil {
			return err
		}
		if state.Resetting {
			return errors.New("connector reset is incomplete; run reset again")
		}
		if state.Pending != "" {
			return errors.New("identity has a pending rotation; run the connector to recover it first")
		}
		private, err := privateKey(state.Active)
		if err != nil {
			return err
		}
		client.PlatformKey = cfg.PlatformPublicKey
		if err = client.Probe(ctx, cfg.ConnectorID, private); err == nil {
			return ErrAlreadyPaired
		}
		var denied *APIError
		if !errors.As(err, &denied) || denied.Status != 403 {
			return fmt.Errorf("could not verify existing identity; retry when the platform is available: %w", err)
		}
		if err = client.Pair(ctx, cfg, code, private); err != nil {
			return fmt.Errorf("pairing incomplete; retry with a valid code or check whether this identity was revoked: %w", err)
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	id, err := newID()
	if err != nil {
		return err
	}
	private, _, err := newKey()
	if err != nil {
		return err
	}
	if err = vault.Set(id, KeyState{Active: protocol.Encode(private)}); err != nil {
		return err
	}
	cfg := Config{ConnectorID: id, Server: client.Server, Name: name, PlatformPublicKey: strings.Split(code, ".")[2]}
	client.PlatformKey = cfg.PlatformPublicKey
	if err = WriteConfig(configPath, cfg); err != nil {
		_ = vault.Delete(id)
		return err
	}
	if err = client.Pair(ctx, cfg, code, private); err != nil {
		return fmt.Errorf("pairing incomplete; identity retained; retry pairing with a valid code, or run the connector if pairing succeeded: %w", err)
	}
	return nil
}
func Run(ctx context.Context, cfg Config, version string, vault Vault, out io.Writer) error {
	return RunWithSources(ctx, cfg, version, vault, datasource.SystemVault{}, out)
}

// RunWithSources accepts a locally supplied vault; ordinary CLI execution
// uses Run and the operating system credential store.
func RunWithSources(ctx context.Context, cfg Config, version string, vault Vault, sources datasource.Vault, out io.Writer) error {
	diagnostics.Record(ctx, diagnostics.Event{Code: "connector.lifecycle", Outcome: "started", ConnectorID: cfg.ConnectorID})
	defer diagnostics.Record(ctx, diagnostics.Event{Code: "connector.lifecycle", Outcome: "stopped", ConnectorID: cfg.ConnectorID})
	client, err := NewClient(cfg.Server, version)
	if err != nil {
		return err
	}
	state, err := vault.Get(cfg.ConnectorID)
	if err != nil {
		return err
	}
	if state.Resetting {
		return errors.New("connector reset is incomplete; run reset again")
	}
	if _, err = privateKey(state.Active); err != nil {
		return err
	}
	if state.Pending != "" {
		if _, err = privateKey(state.Pending); err != nil {
			return err
		}
	}
	ctx, stop := context.WithCancel(ctx)
	client.readRunner = NewReadRunner(cfg, vault, sources)
	client.readFailure = make(chan error, 1)
	defer func() { stop(); client.readWait.Wait(); client.closeMutations() }()
	online := false
	reportedOffline := false
	for {
		err = Sync(ctx, client, cfg, vault)
		if err == nil && !online {
			diagnostics.Record(ctx, diagnostics.Event{Code: "connector.lifecycle", Outcome: "success", ConnectorID: cfg.ConnectorID})
			fmt.Fprintln(out, "Connector connected")
			online = true
			reportedOffline = false
		}
		if err != nil {
			if online || !reportedOffline {
				diagnostics.Record(ctx, diagnostics.Event{Code: "connector.lifecycle", Outcome: "unavailable", ConnectorID: cfg.ConnectorID})
				fmt.Fprintln(out, "Connector offline; retrying")
				online = false
				reportedOffline = true
			}
			var denied *APIError
			if errors.As(err, &denied) && (denied.Status == 403 || denied.Status == 426) {
				return err
			}
		}
		// Online task pickup is interactive; offline retry must not hammer an
		// unavailable platform. Active work still checks cancellations faster.
		interval := 2 * time.Second
		if err != nil {
			interval = 15 * time.Second
		} else if client.readInProgress() {
			interval = time.Second
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case failure := <-client.readFailure:
			timer.Stop()
			return failure
		case <-timer.C:
		}
	}
}
func Reset(configPath string, vault Vault) error {
	cfg, err := ReadConfig(configPath)
	if err != nil {
		return err
	}
	state, err := vault.Get(cfg.ConnectorID)
	if err != nil && !errors.Is(err, keyring.ErrNotFound) {
		return err
	}
	if err == nil && !state.Resetting {
		// Invalidate the identity before removing any replay evidence. A failed
		// cleanup is resumable, but this identity can never execute again.
		state.Resetting = true
		state.Active = ""
		state.Pending = ""
		if err = vault.Set(cfg.ConnectorID, state); err != nil {
			return err
		}
	}
	if cleaner, ok := vault.(interface{ deleteReplay(string) error }); ok {
		if err = cleaner.deleteReplay(cfg.ConnectorID); err != nil {
			return err
		}
	}
	if err = vault.Delete(cfg.ConnectorID); err != nil && !errors.Is(err, keyring.ErrNotFound) {
		return err
	}
	return os.Remove(configPath)
}
