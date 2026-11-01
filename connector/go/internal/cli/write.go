package cli

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"example.com/ai-database-workspace/connector/internal/agent"
	"example.com/ai-database-workspace/connector/internal/datasource"
	"example.com/ai-database-workspace/connector/internal/mutationguard"
	"example.com/ai-database-workspace/connector/internal/mutationmysql"
	"example.com/ai-database-workspace/connector/internal/mutationstore"
	mysql "github.com/go-sql-driver/mysql"
	"golang.org/x/term"
)

var errWriteCommand = errors.New("受控写入尚未通过 G4 验收；仅支持离线 plan-install、显式 capture-configure 和本机 status")

func writeCommand(ctx context.Context, args []string, stdin *os.File, out, errOut io.Writer, configPath string) error {
	if len(args) == 0 {
		return errWriteCommand
	}
	switch args[0] {
	case "plan-install":
		return writePlan(args[1:], out, errOut)
	case "capture-configure":
		return writeConfigure(ctx, args[1:], stdin, out, errOut, configPath)
	case "status":
		return writeStatus(args[1:], out, errOut, configPath)
	default:
		return errWriteCommand
	}
}
func readWriteJSON(path string, dest any) error {
	raw, err := mutationstore.ReadProtectedArtifact(path)
	if err != nil {
		return errors.New("本机配置文件不可读取")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(dest) != nil {
		return errors.New("本机配置文件格式无效")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return errors.New("本机配置文件格式无效")
	}
	return nil
}
func writePlan(args []string, out, errOut io.Writer) error {
	flags := flag.NewFlagSet("write plan-install", flag.ContinueOnError)
	flags.SetOutput(errOut)
	specPath := flags.String("spec", "", "reviewed installation specification JSON")
	output := flags.String("out", "", "new offline SQL artifact path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *specPath == "" || *output == "" {
		return errors.New("plan-install requires --spec and --out")
	}
	var spec mutationmysql.InstallSpec
	if err := readWriteJSON(*specPath, &spec); err != nil {
		return err
	}
	var err error
	if spec.Incarnation == "" {
		spec.Incarnation, err = mutationmysql.NewEpoch()
		if err != nil {
			return err
		}
	}
	if spec.Generation == "" {
		spec.Generation, err = mutationmysql.NewEpoch()
		if err != nil {
			return err
		}
	}
	plan, err := mutationmysql.BuildInstallation(spec)
	if err != nil {
		return err
	}
	resolved, err := json.MarshalIndent(plan.Spec, "", "  ")
	if err != nil {
		return errors.New("无法生成固定安装规格")
	}
	if err = mutationstore.WriteProtectedArtifact(*output, []byte(plan.SQL())); err != nil {
		return errors.New("无法创建新的安装 SQL；已有文件不会被覆盖")
	}
	if err = mutationstore.WriteProtectedArtifact(*output+".spec.json", resolved); err != nil {
		return errors.New("安装 SQL 已保留，但固定规格文件创建失败；请检查现场，不要自动覆盖重试")
	}
	fmt.Fprintln(out, "已生成离线安装 SQL：", *output)
	fmt.Fprintln(out, "已固定安装世代：", *output+".spec.json")
	fmt.Fprintln(out, "未连接数据库、未执行安装。由 DBA 审核并停写安装后，再使用 capture-configure；运行写入口仍关闭。")
	return nil
}
func passwordFromTerminal(stdin *os.File, out io.Writer, label string) (string, error) {
	fmt.Fprint(out, label+"（输入不回显）: ")
	raw, err := term.ReadPassword(int(stdin.Fd()))
	fmt.Fprintln(out)
	if err != nil {
		return "", errors.New("无法读取安全输入")
	}
	password := string(raw)
	for i := range raw {
		raw[i] = 0
	}
	if password == "" || len(password) > 1024 {
		return "", errors.New("凭据输入为空或过长")
	}
	return password, nil
}

type writeConfigureFlags struct {
	source, spec, policy, manifest, host, tls, admin, workspaces string
	port                                                         int
	reviewed                                                     bool
}

func parseWriteConfigure(args []string, errOut io.Writer) (writeConfigureFlags, error) {
	var c writeConfigureFlags
	flags := flag.NewFlagSet("write capture-configure", flag.ContinueOnError)
	flags.SetOutput(errOut)
	flags.StringVar(&c.source, "source", "", "local source ID")
	flags.StringVar(&c.spec, "spec", "", "resolved reviewed installation specification")
	flags.StringVar(&c.policy, "policy", "", "reviewed local policy array JSON")
	flags.StringVar(&c.manifest, "manifest", "", "new signed local bundle path")
	flags.StringVar(&c.host, "host", "", "explicit source host")
	flags.IntVar(&c.port, "port", 0, "explicit source port")
	flags.StringVar(&c.tls, "tls", "", "required, or explicit loopback local")
	flags.StringVar(&c.admin, "admin", "", "offline metadata verification account")
	flags.StringVar(&c.workspaces, "workspaces", "", "comma-separated explicitly authorized workspace IDs")
	flags.BoolVar(&c.reviewed, "confirm-reviewed-installation", false, "DBA reviewed the fixed templates, installed them offline and stopped controlled-write processes")
	if err := flags.Parse(args); err != nil {
		return c, err
	}
	if flags.NArg() != 0 || !datasource.ValidID(c.source) || c.spec == "" || c.policy == "" || c.manifest == "" || c.host == "" || c.port < 1 || c.port > 65535 || c.admin == "" || c.workspaces == "" || !c.reviewed {
		return c, errors.New("capture-configure requires explicit source/spec/policy/manifest/host/port/tls/admin/workspaces and --confirm-reviewed-installation")
	}
	return c, nil
}
func writeConfigure(ctx context.Context, args []string, stdin *os.File, out, errOut io.Writer, configPath string) error {
	c, err := parseWriteConfigure(args, errOut)
	if err != nil {
		return err
	}
	if stdin == nil || !term.IsTerminal(int(stdin.Fd())) {
		return errors.New("capture-configure requires an interactive terminal; database passwords are not accepted from arguments, environment or files")
	}
	cfg, err := agent.ReadConfig(configPath)
	if err != nil {
		return errors.New("本机 Connector 身份不可读取")
	}
	source, err := (datasource.SystemVault{}).Get(c.source)
	if err != nil || source.ConnectorID != cfg.ConnectorID || source.Host != c.host || source.Port != c.port || source.TLS != c.tls {
		return errors.New("源配置与当前 Connector、本机地址或 TLS 模式不一致")
	}
	if source.ModelLeaseUntil > time.Now().Unix() {
		return errors.New("模型发送授权租约仍在使用中，请租约结束后再配置本机写策略")
	}
	var workspaces []string
	seen := map[string]bool{}
	for _, workspace := range strings.Split(c.workspaces, ",") {
		if !datasource.ValidID(workspace) || seen[workspace] || !source.Allows(workspace) {
			return errors.New("工作区未获本机数据源授权或重复")
		}
		seen[workspace] = true
		workspaces = append(workspaces, workspace)
	}
	var spec mutationmysql.InstallSpec
	if err = readWriteJSON(c.spec, &spec); err != nil {
		return err
	}
	if spec.Catalog != source.Database {
		return errors.New("安装规格与本机数据源目录不一致")
	}
	plan, err := mutationmysql.BuildInstallation(spec)
	if err != nil {
		return err
	}
	var policies []mutationguard.Policy
	if err = readWriteJSON(c.policy, &policies); err != nil {
		return err
	}
	if len(policies) == 0 {
		return errors.New("至少需要一项本机写策略")
	}
	generation, err := mutationmysql.NewEpoch()
	if err != nil {
		return err
	}
	for i := range policies {
		if policies[i].Generation == "" {
			policies[i].Generation = generation
		}
	}
	vault := mutationstore.SystemVault{}
	if exists, err := vault.Exists(c.source); err != nil || exists {
		return errors.New("本机已有完整或部分写配置；禁止覆盖、清空日志或通过重新配置恢复写资格")
	}
	adminPassword, err := passwordFromTerminal(stdin, out, "离线核验账号密码")
	if err != nil {
		return err
	}
	writerPassword, err := passwordFromTerminal(stdin, out, "受限写账号密码")
	if err != nil {
		return err
	}
	recoveryPassword, err := passwordFromTerminal(stdin, out, "独立恢复账号密码")
	if err != nil {
		return err
	}
	writerCredential := mutationstore.Credential{Host: c.host, Port: c.port, Database: spec.Catalog, Username: spec.Writer.User, Password: writerPassword, TLS: c.tls}
	recoveryCredential := writerCredential
	recoveryCredential.Username, recoveryCredential.Password = spec.Recovery.User, recoveryPassword
	if writerCredential.Validate() != nil || recoveryCredential.Validate() != nil {
		return errors.New("本机连接参数无效")
	}
	db, err := openCaptureDatabase(c, source.Database, adminPassword)
	adminPassword = ""
	if err != nil {
		return errors.New("离线核验连接不可用")
	}
	defer db.Close()
	operation, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	manifest, err := mutationmysql.CaptureInstallation(operation, db, plan)
	if err != nil {
		return errors.New("安装模板、完整权限、固定定义或目标身份未通过核验；没有保存写配置")
	}
	bundle := mutationmysql.Bundle{Manifest: manifest, Policies: policies}
	if bundle.Validate() != nil {
		return errors.New("本机策略与安装目标或世代不一致")
	}
	// Register the verified canonical namespace before generating either the
	// target roots or any package key. Startup can therefore expire keys even
	// if the journal later becomes missing or corrupt.
	if err = mutationstore.NewSystemPackageNamespaces().Register(cfg.ConnectorID, manifest.TargetIdentity()); err != nil {
		return errors.New("不能登记本Connector的受信包密钥命名空间；没有创建密钥或开启写入")
	}
	keys, err := vault.CreateTargetKeys(manifest.TargetIdentity())
	if err != nil {
		return errors.New("系统安全凭据库不可用")
	}
	macKey, err := mutationstore.DecodeKey(keys.ManifestMACKey)
	if err != nil {
		return err
	}
	raw, err := mutationmysql.SealBundle(bundle, macKey)
	if err != nil {
		return err
	}
	absolute, err := filepath.Abs(c.manifest)
	if err != nil {
		return errors.New("本机清单路径无效")
	}
	profile := mutationstore.Profile{SourceID: c.source, ConnectorID: cfg.ConnectorID, WorkspaceIDs: workspaces, Writer: writerCredential, Recovery: recoveryCredential, ManifestPath: absolute, ManifestMACKey: keys.ManifestMACKey, JournalKey: keys.JournalKey}
	if profile.Validate() != nil {
		return errors.New("本机写配置无效")
	}
	// Verify both runtime credentials with read-only metadata operations before
	// persisting. The administrator credential is neither reused nor stored.
	controller, err := mutationmysql.New(profile.Target(), manifest)
	if err != nil {
		return err
	}
	if err = controller.Verify(operation); err != nil {
		controller.Close()
		return errors.New("受限写账号或独立恢复账号未通过核验")
	}
	if err = controller.ValidatePolicies(operation, policies); err != nil {
		controller.Close()
		return errors.New("本机策略包含未获授权或不能核验的表、字段或行规则")
	}
	controller.Close()
	if err = mutationstore.WriteProtectedArtifact(absolute, raw); err != nil {
		return errors.New("签名清单不能覆盖已有文件；部分配置现场已保留")
	}
	journalPath := agent.MutationJournalPath(filepath.Dir(configPath), cfg.ConnectorID, manifest.TargetIdentity())
	journalKey, err := mutationstore.DecodeKey(keys.JournalKey)
	if err != nil {
		return err
	}
	var journal *mutationstore.Store
	packetKeys, err := mutationstore.NewSystemPackageKeys(cfg.ConnectorID, manifest.TargetIdentity())
	if err != nil {
		return err
	}
	if _, err = os.Stat(journalPath); os.IsNotExist(err) {
		journal, err = mutationstore.Create(journalPath, journalKey, cfg.ConnectorID, packetKeys)
	} else if err == nil {
		journal, err = mutationstore.Open(journalPath, journalKey, cfg.ConnectorID, packetKeys)
	}
	if err != nil {
		return errors.New("执行日志不可用；已保留清单与安全凭据现场，未开启写入")
	}
	if journal.Close() != nil {
		return errors.New("执行日志不能安全关闭；未开启写入")
	}
	if vault.Put(profile) != nil {
		return errors.New("本机配置保存不完整；请保留现场核对，不要重置日志或密钥")
	}
	fmt.Fprintln(out, "本机固定安装、策略、签名清单和独立凭据已配置。管理员密码未保存；未执行业务修改。")
	fmt.Fprintln(out, "G4 安全验收前平台与 Connector 的运行写入口继续关闭。")
	return nil
}
func openCaptureDatabase(c writeConfigureFlags, catalog, password string) (*sql.DB, error) {
	credential := mutationstore.Credential{Host: c.host, Port: c.port, Database: catalog, Username: c.admin, Password: password, TLS: c.tls}
	if credential.Validate() != nil {
		return nil, mutationstore.ErrCredentials
	}
	config := mysql.NewConfig()
	config.User, config.Passwd, config.Net, config.Addr, config.DBName = c.admin, password, "tcp", net.JoinHostPort(c.host, strconv.Itoa(c.port)), catalog
	config.Timeout, config.ReadTimeout, config.WriteTimeout = 3*time.Second, 10*time.Second, 5*time.Second
	config.MultiStatements, config.InterpolateParams = false, false
	if c.tls == "required" {
		config.TLSConfig = "true"
	} else {
		config.TLSConfig = "false"
	}
	connector, err := mysql.NewConnector(config)
	if err != nil {
		return nil, mutationstore.ErrCredentials
	}
	db := sql.OpenDB(connector)
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(0)
	return db, nil
}
func writeStatus(args []string, out, errOut io.Writer, configPath string) error {
	flags := flag.NewFlagSet("write status", flag.ContinueOnError)
	flags.SetOutput(errOut)
	source := flags.String("source", "", "local source ID")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || !datasource.ValidID(*source) {
		return errors.New("write status requires --source")
	}
	cfg, err := agent.ReadConfig(configPath)
	if err != nil {
		return errors.New("Connector 身份不可用")
	}
	p, err := (mutationstore.SystemVault{}).Get(*source)
	if err != nil || p.ConnectorID != cfg.ConnectorID {
		return errors.New("本机写配置不可用；运行写入口关闭")
	}
	key, err := mutationstore.DecodeKey(p.ManifestMACKey)
	if err != nil {
		return err
	}
	raw, err := mutationstore.ReadProtectedArtifact(p.ManifestPath)
	if err != nil {
		return err
	}
	bundle, err := mutationmysql.ParseBundle(raw, key)
	if err != nil {
		return err
	}
	fmt.Fprintln(out, "Local controlled-write installation: configured")
	fmt.Fprintln(out, "Target identity:", bundle.Manifest.TargetIdentity())
	fmt.Fprintln(out, "Installation generation:", bundle.Manifest.Spec.Generation)
	fmt.Fprintln(out, "Policy count:", len(bundle.Policies))
	fmt.Fprintln(out, "Runtime writes: disabled until G4 acceptance")
	fmt.Fprintln(out, "Connectivity and commit outcomes were not queried.")
	return nil
}
