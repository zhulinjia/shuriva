# 第八阶段 G2 隔离实验

2026-11-01。此模块不被平台或 Connector 导入，不提供生产写入 API。依赖仅存在本实验 `go.mod/go.sum`：复用 mysql v1.10.1、bbolt v1.4.3 和已锁定 x/sys/windows。结论见 [第二轮修订与复验](../../../docs/20-第八阶段核验计时与恢复修订.md)，[第一轮失败记录](../../../docs/19-第八阶段隔离验证与准入记录.md) 保留历史。

## 目标隔离

- 仅允许 `127.0.0.1:13308`；拒绝原实例端口 `3306`、已有演示端口 `13307`、其他地址及其他目录。不读取项目 `.env` 或系统凭据库。
- 启动脚本只新建 `.cache/stage8-g2-<随机编号>/mysql-data`，显式 `--no-defaults`、数据目录和端口；端口占用就停止本次启动，不停止已有服务。原库与旧演示库均不使用。
- 管理清单只保存在该新目录，包含实验随机凭据，目录 ACL 仅当前运行用户可访问。不要把清单、bootstrap SQL 或整个实例目录提交到版本库。
- `lab.Load` 核对清单位置、新目录、链接/接合点和 `auto.cnf` UUID。`OpenAccount` 只接受当前经过校验且未改变的清单；每个新池连接在接收测试 SQL 前核对 `@@port`、`@@datadir`、`@@server_uuid`、`@@pid_file` 及实际 PID 文件。
- MySQL 实验使用随机 `stage8_g2_*` 库和随机账号，清理先核对实例身份，只删除该用例自己的对象。本机日志实验只使用 `t.TempDir()` 与本测试程序的隐藏子进程。

## 复现

从项目根目录运行 `scripts/start-stage8-isolated-mysql.ps1`。它只为已安装的 MySQL 26.7 程序创建全新实例；没有安装程序或该端口占用时直接拒绝。脚本返回此次清单路径，不复用报告里的历史实例。

在本目录设置实验变量，并使用脚本刚返回的路径：

```powershell
$env:GOARCH = 'amd64'
$env:GOCACHE = 'I:/wwwroot/stackoryn-com/.cache/stage8-g2-build'
$env:GOMODCACHE = 'I:/wwwroot/stackoryn-com/.cache/stage8-g2-modcache'
$env:STAGE8_G2_MANIFEST = '<脚本返回的全新 manifest.json 路径>'
go mod download
go run ./cmd/fixturectl inspect $env:STAGE8_G2_MANIFEST
go test -mod=readonly -json -count=1 -timeout=120s ./...
go vet ./...
go run ./cmd/fixturectl shutdown $env:STAGE8_G2_MANIFEST
```

数据库组和隔离守卫要求显式清单，未提供时失败，不静默跳过。日志和协议模型可分别用 `-run '^TestG2Journal'`、`-run '^TestProtocol'` 运行，不连接数据库。父级研究模块及原 Connector 的依赖不受影响。

第二轮最终完整运行 **45 个顶层实验：45 通过、0 失败、0 跳过**，退出码 0。原 24 项基线加 7 项固定元数据、6 项新计时与 8 项恢复实验。Kernel32 直接加载与 Definer view 原方案已经退役，作为明确拒绝反例/诊断回归，第一轮 22/24 及失败日志没有删除；新方案有独立的严格正向、负向和真实数据库证据，不能把改名当修复。

本轮实验实例已按身份守卫关闭，测试 schema/账号/角色残留均为 0。复现须运行脚本新建另一实例，不直接用报告里已关闭的 manifest。实验可能在这个新实例内短暂调整 partial_revokes、角色配置或安装固定过程，均有清理恢复；连接守卫禁止对原实例做这些操作。

## 证据边界

- `mysql_test.go`：真实隔离 MySQL 权限、隐藏依赖、副作用、MDL、行回读/回滚、类型精度和计数行为。Definer view 是拒绝反例。
- `metadata_helper_test.go` / [METADATA](METADATA.md)：受信固定 procedure 的完整依赖、定义/协议与隐式权限核验；同事务目标/例程 MDL。没有生产安装器或授权器，也不抵抗恶意 DBA。
- `registration_test.go`：真实 MySQL 事务、唯一约束、作用域锁、确认消费/关闭/恢复及 outbox 原子性；不是 Better Auth、HTTP、队列或 WriteRunner 的端到端验证。
- `journal_test.go`：真实 bbolt 文件锁、同步提交后进程骤退、CAS、回滚、损坏及旧快照；外部检查点只是恢复参考模型，不证明跨系统事务或两份权威同时回退。
- `protocol_test.go`：真实签名和合成时钟/并发参考模型；并非已接入产品的许可或多来源冻结服务。
- `clock_windows*.go`：只读取 Windows 时钟并做普通进程等待。没有调整时钟、电源设置或使电脑休眠；不证明真实休眠、电源转换及安全裕量已验证。
- `timing_*` / [TIMING](TIMING.md)：官方含休眠计数适配器、固定预算与单次交付资格；真实系统 API 加注入边界向量，非硬实时网络保证，硬件电源转换未实测。
- `recovery_test.go` / [RECOVERY](RECOVERY.md)：受限账号同事务回执、真实子进程骤退、SQL+bbolt 回退、交叉消费、分页发现及目标世代门；平台表为新实例 fixture，API boot 为内存实验值，不是 HTTP/真实 API 生命周期端到端。缺回执与空列表不授予重跑或解冻。

本轮未运行 race detector：目标为 Windows/amd64，现有 Go 安装宿主是 windows/386，目标配置 `CGO_ENABLED=0` 且没有可用的 gcc。没有为此安装额外工具链。
