// Package cli provides local Connector lifecycle commands.
package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"example.com/ai-database-workspace/connector/internal/agent"
	"example.com/ai-database-workspace/connector/internal/datasource"
	"example.com/ai-database-workspace/connector/internal/diagnostics"
	"golang.org/x/term"
)

func Run(args []string, stdout, stderr io.Writer, version string) int {
	return RunWithContext(context.Background(), args, os.Stdin, stdout, stderr, version)
}
func RunWithContext(ctx context.Context, args []string, stdin *os.File, stdout, stderr io.Writer, version string) int {
	logger, logErr := diagnostics.Open(os.Getenv, stderr)
	if logErr != nil {
		logger = diagnostics.Fallback(stderr)
	}
	defer logger.Close()
	ctx = diagnostics.With(ctx, logger)
	command := "status"
	rest := args
	if len(args) > 0 {
		command = args[0]
		rest = args[1:]
	}
	fail := func(err error) int { fmt.Fprintln(stderr, "error:", err); return 1 }
	configPath, err := agent.DefaultConfigPath()
	if err != nil {
		return fail(err)
	}
	vault := agent.SystemVault{}
	if command == "pair" || command == "run" || command == "rotate" || command == "reset" || (command == "write" && len(rest) > 0) || (command == "source" && len(rest) > 0 && rest[0] != "check") {
		release, lockErr := agent.LockConfig(configPath)
		if lockErr != nil {
			return fail(lockErr)
		}
		defer func() {
			if err := release(); err != nil {
				fmt.Fprintln(stderr, "error: connector lock cleanup failed")
			}
		}()
	}
	switch command {
	case "write":
		if err := writeCommand(ctx, rest, stdin, stdout, stderr, configPath); err != nil {
			return fail(err)
		}
		return 0
	case "source":
		if err := sourceCommand(ctx, rest, stdin, stdout, stderr, configPath); err != nil {
			return fail(err)
		}
		return 0
	case "status":
		if len(rest) != 0 {
			return fail(errors.New("status accepts no arguments"))
		}
		fmt.Fprintf(stdout, "Connector %s\n", version)
		cfg, err := agent.ReadConfig(configPath)
		if os.IsNotExist(err) {
			fmt.Fprintln(stdout, "Pairing: not configured")
		} else if err != nil {
			return fail(err)
		} else {
			fmt.Fprintf(stdout, "Pairing: configured\nConnector ID: %s\nName: %s\nServer: %s\n", cfg.ConnectorID, cfg.Name, cfg.Server)
		}
		fmt.Fprintln(stdout, "Connectivity: shown while running or in the workspace")
		fmt.Fprintln(stdout, "Read-only queries: signed platform tasks with platform and local authorization")
		fmt.Fprintln(stdout, "Runtime writes: disabled")
		return 0
	case "version", "--version":
		if len(rest) != 0 {
			return fail(errors.New("version accepts no arguments"))
		}
		fmt.Fprintln(stdout, version)
		return 0
	case "help", "--help", "-h":
		fmt.Fprintln(stdout, "Usage: connector [status|version|pair|run|rotate|reset|source|write|help]")
		fmt.Fprintln(stdout, "pair --server <origin> --name <name>; pairing code is read securely from the terminal.")
		fmt.Fprintln(stdout, "source add configures a local MySQL credential; source check verifies its scope and metadata.")
		fmt.Fprintln(stdout, "source read-allow/read-revoke manage local table and column policy; read-only queries also require platform authorization and SQL validation.")
		fmt.Fprintln(stdout, "run accepts authorized signed read-only tasks when enabled on the platform. Runtime writes are disabled.")
		fmt.Fprintln(stdout, "write plan-install generates offline reviewed SQL; write capture-configure requires an interactive terminal and never installs database objects.")
		return 0
	case "pair":
		flags := flag.NewFlagSet("pair", flag.ContinueOnError)
		flags.SetOutput(stderr)
		server := flags.String("server", "http://127.0.0.1:3000", "platform origin")
		name := flags.String("name", "本机 Connector", "connector name")
		if err = flags.Parse(rest); err != nil {
			return 2
		}
		if flags.NArg() != 0 {
			return fail(errors.New("unexpected arguments"))
		}
		if stdin == nil || !term.IsTerminal(int(stdin.Fd())) {
			return fail(errors.New("pairing requires an interactive terminal"))
		}
		fmt.Fprint(stdout, "请输入一次性配对码（输入不回显）: ")
		value, err := term.ReadPassword(int(stdin.Fd()))
		fmt.Fprintln(stdout)
		if err != nil {
			return fail(errors.New("could not read pairing code"))
		}
		code := strings.TrimSpace(string(value))
		for i := range value {
			value[i] = 0
		}
		operation, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		if err = agent.PairNew(operation, configPath, *server, *name, code, version, vault); err != nil {
			if errors.Is(err, agent.ErrAlreadyPaired) {
				fmt.Fprintln(stdout, "此连接器已配对，本次输入的配对码未使用。运行 connector run 保持在线。")
				return 0
			}
			return fail(err)
		}
		fmt.Fprintln(stdout, "配对成功。运行 connector run 保持在线。")
		return 0
	case "run", "rotate":
		if len(rest) != 0 {
			return fail(errors.New("unexpected arguments"))
		}
		cfg, err := agent.ReadConfig(configPath)
		if err != nil {
			return fail(err)
		}
		if command == "run" {
			if err = agent.Run(ctx, cfg, version, vault, stdout); err != nil {
				return fail(err)
			}
			return 0
		}
		client, err := agent.NewClient(cfg.Server, version)
		if err != nil {
			return fail(err)
		}
		operation, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		if err = agent.StartRotation(operation, client, cfg, vault); err != nil {
			return fail(err)
		}
		fmt.Fprintln(stdout, "Connector 身份密钥已轮换。")
		return 0
	case "reset":
		if len(rest) != 1 || rest[0] != "--confirm-local-reset" {
			return fail(errors.New("reset requires --confirm-local-reset; revoke it in the platform first"))
		}
		cfg, readErr := agent.ReadConfig(configPath)
		if readErr != nil {
			return fail(readErr)
		}
		ids, listErr := (datasource.SystemVault{}).List(cfg.ConnectorID)
		if listErr != nil {
			return fail(listErr)
		}
		if len(ids) > 0 {
			return fail(errors.New("remove local data source credentials first; use source list and source remove"))
		}
		if err = agent.Reset(configPath, vault); err != nil {
			return fail(err)
		}
		fmt.Fprintln(stdout, "本地 Connector 身份已移除。")
		return 0
	default:
		return fail(errors.New("unsupported command; use 'connector help'"))
	}
}
