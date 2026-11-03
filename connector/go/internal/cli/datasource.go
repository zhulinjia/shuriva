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
	"golang.org/x/term"
)

func sourceCommand(ctx context.Context, args []string, stdin *os.File, stdout, stderr io.Writer, configPath string) error {
	if len(args) == 0 {
		return errors.New("source requires add, list, update, check, allow, disallow, read-allow, read-revoke or remove")
	}
	switch args[0] {
	case "read-allow", "read-revoke":
		flags := flag.NewFlagSet("source "+args[0], flag.ContinueOnError)
		flags.SetOutput(stderr)
		id := flags.String("id", "", "data source ID")
		workspace := flags.String("workspace", "", "authorized workspace ID")
		table := flags.String("table", "", "base table name")
		columns := flags.String("columns", "", "comma-separated permitted column names")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 || !datasource.ValidID(*workspace) {
			return errors.New("valid workspace ID required")
		}
		cfg, err := agent.ReadConfig(configPath)
		if err != nil {
			return errors.New("connector identity unavailable")
		}
		store := datasource.SystemVault{}
		p, err := store.Get(*id)
		if err != nil {
			return err
		}
		if p.ConnectorID != cfg.ConnectorID || !p.Allows(*workspace) {
			return errors.New("data source or workspace is not locally authorized")
		}
		if args[0] == "read-revoke" {
			if *columns != "" || *table == "" {
				return errors.New("read-revoke requires --table without --columns")
			}
			if err := p.RevokeReadScope(*workspace, *table); err != nil {
				return err
			}
		} else {
			if *table == "" || *columns == "" {
				return errors.New("read-allow requires --table and --columns")
			}
			operation, cancel := context.WithTimeout(ctx, 25*time.Second)
			defer cancel()
			snapshot, err := datasource.Scan(operation, p, cfg.ConnectorID, *workspace)
			if err != nil {
				return err
			}
			if err := p.GrantReadScope(*workspace, *table, strings.Split(*columns, ","), snapshot); err != nil {
				return err
			}
		}
		if err := store.Replace(p); err != nil {
			return err
		}
		fmt.Fprintln(stdout, "本机只读表和字段授权已更新；查询须同时通过平台授权、SQL 校验和本机策略。")
		return nil
	case "adopt":
		flags := flag.NewFlagSet("source adopt", flag.ContinueOnError)
		flags.SetOutput(stderr)
		id := flags.String("id", "", "data source ID")
		old := flags.String("from", "", "previous connector ID")
		confirm := flags.Bool("confirm-both-stopped", false, "both connector processes are stopped")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 || !*confirm {
			return errors.New("adopt requires --id, --from and --confirm-both-stopped")
		}
		cfg, err := agent.ReadConfig(configPath)
		if err != nil {
			return errors.New("connector identity unavailable")
		}
		if err := (datasource.SystemVault{}).Adopt(*id, *old, cfg.ConnectorID); err != nil {
			return err
		}
		fmt.Fprintln(stdout, "本机数据源已转移到当前 Connector；请在平台重新关联。")
		return nil
	case "list":
		if len(args) != 1 {
			return errors.New("source list accepts no arguments")
		}
		cfg, err := agent.ReadConfig(configPath)
		if err != nil {
			return errors.New("connector identity unavailable")
		}
		ids, err := (datasource.SystemVault{}).List(cfg.ConnectorID)
		if err != nil {
			return err
		}
		for _, id := range ids {
			fmt.Fprintln(stdout, id)
		}
		return nil
	case "update":
		flags := flag.NewFlagSet("source update", flag.ContinueOnError)
		flags.SetOutput(stderr)
		id := flags.String("id", "", "data source ID")
		host := flags.String("host", "", "new MySQL host, or omit to retain")
		port := flags.Int("port", 0, "new MySQL port, or omit to retain")
		database := flags.String("database", "", "new database, or omit to retain")
		username := flags.String("user", "", "new database account, or omit to retain")
		tlsPolicy := flags.String("tls", "", "required or local, or omit to retain")
		passwordChange := flags.Bool("password", false, "read new password securely")
		confirmTarget := flags.Bool("confirm-target-change", false, "confirm the new host/port is the same database; old snapshots remain")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return errors.New("unexpected arguments")
		}
		cfg, err := agent.ReadConfig(configPath)
		if err != nil {
			return errors.New("connector identity unavailable")
		}
		store := datasource.SystemVault{}
		p, err := store.Get(*id)
		if err != nil {
			return err
		}
		if p.ConnectorID != cfg.ConnectorID {
			return errors.New("data source belongs to another connector")
		}
		if err := validateTargetChange(p, *host, *port, *database, *confirmTarget); err != nil {
			return err
		}
		if *host != "" {
			p.Host = *host
		}
		if *port != 0 {
			p.Port = *port
		}
		if *database != "" {
			p.Database = *database
		}
		if *username != "" {
			p.Username = *username
		}
		if *tlsPolicy != "" {
			p.TLS = *tlsPolicy
		}
		if *passwordChange {
			if stdin == nil || !term.IsTerminal(int(stdin.Fd())) {
				return errors.New("data source password requires an interactive terminal")
			}
			fmt.Fprint(stdout, "请输入新的只读数据库账号密码（输入不回显）: ")
			password, err := term.ReadPassword(int(stdin.Fd()))
			fmt.Fprintln(stdout)
			if err != nil {
				return errors.New("could not read database password")
			}
			p.Password = string(password)
			for i := range password {
				password[i] = 0
			}
		}
		if err := p.Validate(); err != nil {
			return err
		}
		if len(p.WorkspaceIDs) == 0 {
			return errors.New("authorize a workspace before updating the connection")
		}
		operation, cancel := context.WithTimeout(ctx, 25*time.Second)
		defer cancel()
		if _, err := datasource.Scan(operation, p, cfg.ConnectorID, p.WorkspaceIDs[0]); err != nil {
			return err
		}
		if err := store.Replace(p); err != nil {
			return err
		}
		fmt.Fprintln(stdout, "本机数据源配置已更新，数据源 ID 保持不变。")
		return nil
	case "add":
		flags := flag.NewFlagSet("source add", flag.ContinueOnError)
		flags.SetOutput(stderr)
		existingID := flags.String("id", "", "existing source ID for migration, or omit to generate")
		confirmExisting := flags.Bool("confirm-existing-source", false, "confirm this is the same database; old snapshots remain")
		host := flags.String("host", "127.0.0.1", "MySQL hostname")
		port := flags.Int("port", 3306, "MySQL port")
		database := flags.String("database", "", "allowed database")
		username := flags.String("user", "", "restricted database account")
		workspaces := flags.String("workspaces", "", "comma-separated allowed workspace IDs")
		tlsPolicy := flags.String("tls", "required", "required or local (loopback only)")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return errors.New("unexpected arguments")
		}
		cfg, err := agent.ReadConfig(configPath)
		if err != nil {
			return errors.New("pair the connector before configuring a data source")
		}
		if *existingID != "" && !*confirmExisting {
			return errors.New("using an existing ID preserves old snapshots; use --confirm-existing-source only when migrating the same database")
		}
		id := *existingID
		if id == "" {
			id, err = datasource.NewID()
			if err != nil {
				return err
			}
		} else if !datasource.ValidID(id) {
			return errors.New("invalid data source ID")
		}
		if stdin == nil || !term.IsTerminal(int(stdin.Fd())) {
			return errors.New("data source password requires an interactive terminal")
		}
		fmt.Fprint(stdout, "请输入只读数据库账号的密码（输入不回显）: ")
		password, err := term.ReadPassword(int(stdin.Fd()))
		fmt.Fprintln(stdout)
		if err != nil {
			return errors.New("could not read database password")
		}
		p := datasource.Profile{ID: id, ConnectorID: cfg.ConnectorID, WorkspaceIDs: strings.Split(*workspaces, ","), Host: *host, Port: *port, Database: *database, Username: *username, Password: string(password), TLS: *tlsPolicy}
		for i := range password {
			password[i] = 0
		}
		if err := p.Validate(); err != nil {
			return err
		}
		operation, cancel := context.WithTimeout(ctx, 25*time.Second)
		defer cancel()
		if _, err := datasource.Scan(operation, p, cfg.ConnectorID, p.WorkspaceIDs[0]); err != nil {
			return err
		}
		if err := (datasource.SystemVault{}).Set(p); err != nil {
			return err
		}
		fmt.Fprintf(stdout, "数据源已保存到本机凭据管理器。数据源 ID: %s\n", p.ID)
		return nil
	case "check":
		flags := flag.NewFlagSet("source check", flag.ContinueOnError)
		flags.SetOutput(stderr)
		id := flags.String("id", "", "data source ID")
		workspace := flags.String("workspace", "", "authorized workspace ID")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return errors.New("unexpected arguments")
		}
		cfg, err := agent.ReadConfig(configPath)
		if err != nil {
			return errors.New("connector identity unavailable")
		}
		p, err := (datasource.SystemVault{}).Get(*id)
		if err != nil {
			return err
		}
		operation, cancel := context.WithTimeout(ctx, 25*time.Second)
		defer cancel()
		result, err := datasource.Scan(operation, p, cfg.ConnectorID, *workspace)
		if err != nil {
			return err
		}
		fmt.Fprintf(stdout, "连接和只读权限检查通过：%d 个表或视图，%d 个字段，%d 个关系。\n", len(result.Tables), len(result.Columns), len(result.Relations))
		return nil
	case "allow", "disallow":
		flags := flag.NewFlagSet("source "+args[0], flag.ContinueOnError)
		flags.SetOutput(stderr)
		id := flags.String("id", "", "data source ID")
		workspace := flags.String("workspace", "", "workspace ID")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 || !datasource.ValidID(*workspace) {
			return errors.New("valid workspace ID required")
		}
		cfg, err := agent.ReadConfig(configPath)
		if err != nil {
			return errors.New("connector identity unavailable")
		}
		store := datasource.SystemVault{}
		p, err := store.Get(*id)
		if err != nil {
			return err
		}
		if p.ConnectorID != cfg.ConnectorID {
			return errors.New("data source belongs to another connector")
		}
		allowed := p.Allows(*workspace)
		if args[0] == "allow" && !allowed {
			p.WorkspaceIDs = append(p.WorkspaceIDs, *workspace)
		}
		if args[0] == "disallow" && allowed {
			filtered := make([]string, 0, len(p.WorkspaceIDs))
			for _, item := range p.WorkspaceIDs {
				if item != *workspace {
					filtered = append(filtered, item)
				}
			}
			p.WorkspaceIDs = filtered
			delete(p.ReadScopes, *workspace)
		}
		if err := store.Replace(p); err != nil {
			return err
		}
		fmt.Fprintln(stdout, "本机数据源工作空间范围已更新。")
		return nil
	case "remove":
		flags := flag.NewFlagSet("source remove", flag.ContinueOnError)
		flags.SetOutput(stderr)
		id := flags.String("id", "", "data source ID")
		confirm := flags.Bool("confirm-local-remove", false, "remove local credential")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 || !*confirm {
			return errors.New("remove requires --id and --confirm-local-remove")
		}
		cfg, err := agent.ReadConfig(configPath)
		if err != nil {
			return errors.New("connector identity unavailable")
		}
		store := datasource.SystemVault{}
		p, err := store.Get(*id)
		if err != nil {
			if cleanupErr := store.ForgetMissing(cfg.ConnectorID, *id); cleanupErr != nil {
				return err
			}
			fmt.Fprintln(stdout, "已移除没有对应凭据的数据源索引。")
			return nil
		}
		if p.ConnectorID != cfg.ConnectorID {
			return errors.New("data source belongs to another connector")
		}
		if err := store.Delete(*id); err != nil {
			return err
		}
		fmt.Fprintln(stdout, "本机数据源凭据已移除。")
		return nil
	default:
		return errors.New("source requires add, list, update, check, allow, disallow, read-allow, read-revoke or remove")
	}
}

func validateTargetChange(p datasource.Profile, host string, port int, database string, confirmed bool) error {
	if database != "" && database != p.Database {
		return errors.New("a different database requires a new data source ID; old snapshots belong to the original database")
	}
	if ((host != "" && host != p.Host) || (port != 0 && port != p.Port)) && !confirmed {
		return errors.New("changing host or port preserves old snapshots; use --confirm-target-change only when moving the same database")
	}
	return nil
}
