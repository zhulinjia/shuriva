# Go Connector

当前实现配对、在线心跳、连接诊断、身份密钥轮换、撤销后的本地清理，以及本机 MySQL 凭据配置、授权结构扫描和受限只读查询。平台数据源及查询功能需显式启用；未经验证的语法和写入执行仍不可用。协议和安全边界见 [协议说明](../PROTOCOL.md)。需要 Go 1.24 或更高版本及可用的操作系统凭据管理器。

在项目的 `connector/go` 目录执行：

```powershell
go run ./cmd/connector pair --server http://127.0.0.1:5173 --name 本机连接器
go run ./cmd/connector run
```

先在登录后的“连接器”页面生成一次性配对码，在第一条命令的提示中粘贴；输入不会回显。运行第二条命令后保持终端打开，页面会显示状态，并可发起不读取数据库的连接诊断。按 Ctrl+C 停止运行，之后可以重新运行。仅本机回环地址可使用 HTTP；远程地址需要 HTTPS，但远程服务部署尚未验收。

如果配对被拒绝或网络中断，可从同一个平台重新获取配对码并再次运行配对命令；本机身份会保留，重试时首先验证它是否已经成功配对。若先前配对实际已成功，终端会提示新配对码未使用，此时直接运行 `run` 即可。不能通过重试切换到其他平台；如需切换，应先在原平台撤销身份，再按下方步骤重置。

项目尚未上线，平台和 Connector 一起按当前协议开发，不维护假设旧版本的兼容分支。配对码原文不会通过配对接口发送。

```powershell
go run ./cmd/connector status
go run ./cmd/connector rotate
go run ./cmd/connector reset --confirm-local-reset
go test ./...
```

轮换前先停止 `run`，成功后可重新运行。重置会删除本机身份，应先在平台页面撤销对应连接，执行 `source list` 查看登记的本机数据源，用 `source remove --id SOURCE_ID --confirm-local-remove` 逐个移除凭据，再执行重置并重新配对。重置先使身份不可用，再清理其防重放凭据；若中断或清理失败，请再次执行同一重置命令完成清理，不要重新运行该身份。重置前如有本机历史测试凭据，请在操作系统凭据管理器中核对并按需手动清理。配置只含公开身份信息；私钥保存在系统凭据管理器。`CONNECTOR_CONFIG_PATH` 可指定配置文件位置；不要并发运行同一身份。异常中止后若锁文件残留，确认相关进程已停止后再移除对应配置旁的 `.lock` 文件。

当前仅在 Windows 进行了凭据管理器实测，Linux/macOS 尚需验证。Go 模块路径仍为公开仓库地址确定前的占位值。

## 第三阶段：本机 MySQL 数据源

在 Connector 所在环境准备仅对目标数据库授予 `SELECT` 的专用账号。当前检查只接受 MySQL 返回的 `USAGE`、目标数据库范围的 `SELECT` 和可选 `SHOW VIEW`；未知授权、角色、全局查询权限或写入权限会被拒绝。该检查不是对所有 MySQL 权限组合的完整证明。不要使用 root 或把密码放在命令参数中。

停止 `run`，在 `connector/go` 目录执行：

```powershell
go run ./cmd/connector source add --host 127.0.0.1 --port 3306 --database YOUR_DB --user READ_ONLY_USER --workspaces WORKSPACE_ID --tls local
go run ./cmd/connector run
```

把数据库名、账号和工作空间 ID 替换成实际值；ID 可在数据源页面的示例命令中查看。输入密码时不会回显，连接和只读授权检查通过后，整个连接配置只保存在 Connector 本机系统凭据管理器，并显示一个数据源 ID。将该 ID 和对应 Connector 选择在平台中登记、绑定工作空间，再发起测试和扫描。多个本地允许的工作空间 ID 可用逗号分隔。

`--tls local` 只允许连接本机回环地址，连接不加密，需信任本机环境；远程数据库必须使用 `--tls required`，并使用系统信任的有效证书。不能跳过证书校验。扫描只读取目标数据库的 `information_schema`，支持表、视图、字段和范围内外键；限制为 256 个对象、4096 个字段、2048 条关系和 1 MiB 结果，超限时失败而不覆盖旧快照。数据库结构在扫描期间并发变化时，结果不保证是数据库事务级一致快照。

停止 `run` 后，可用 `source allow --id SOURCE_ID --workspace WORKSPACE_ID` 或 `source disallow --id SOURCE_ID --workspace WORKSPACE_ID` 调整本机授权；`source check --id SOURCE_ID --workspace WORKSPACE_ID` 重新检查连接和授权。解绑平台数据源后，如需移除本机凭据，可用 `source remove --id SOURCE_ID --confirm-local-remove`。更改本机范围后重新运行 Connector；平台解绑或归档会取消尚未完成的任务，已下发任务可能已经开始读取结构，但失去授权后的结果不会发布。

第四阶段使用本机表和字段授权。停止 `run` 后，可用 `source read-allow --id SOURCE_ID --workspace WORKSPACE_ID --table TABLE_NAME --columns COLUMN_A,COLUMN_B` 配置范围，使用 `source read-revoke --id SOURCE_ID --workspace WORKSPACE_ID --table TABLE_NAME` 撤销；只接受已允许的工作空间、实际存在的基础表及字段。撤销工作空间时对应表和字段授权也会清除。平台显式启用查询后，只允许经过验证的单表、明确字段及参数条件；未经验证的语法、视图和写入被拒绝。解析器当前在 64 位目标架构验证，32 位构建的查询校验返回不可用；其他已有 Connector 能力不受影响。如果本机 Go 默认是 32 位而操作系统支持 64 位，在运行 Connector 的 PowerShell 会话中设置 `$env:GOARCH = 'amd64'`。当前数据库执行器仅验证了 MySQL 26.7.0 的特定模式，MySQL 8.0 尚未验证。

查询派发或结果确认丢失时，会在任务有效期内重发任务或已有结果；Connector 记录已处理任务，不自动重复执行。若 Connector 重启后结果无法恢复，会返回“结果未知”，应先确认原查询状态，再决定是否重新提交。防重放记录按本机密钥选择四个候选分片，每片最多 8 条未过期记录，若四片均满则失败关闭而不提前删除记录。平台或 Connector 进程重启后未确认结果仍可能丢失；查询只适用于受信任的数据源，取消不保证数据库端线程立刻停止。

允许的条件包括授权字段与 `?` 的简单比较、`AND`/`OR`，以及 `字段 IS NULL` 和 `字段 IS NOT NULL`。筛选空值应使用后两种语法，不应期望 `字段 = ?` 绑定空值能匹配 NULL；整数参数支持有符号 64 位和非负无符号 64 位范围。

数据库换密可在停止 `run` 后执行 `source update --id SOURCE_ID --password`，在终端安全输入新密码；还可使用 `--host`、`--port`、`--user` 和 `--tls` 更新连接参数。更换 host 或 port 必须额外指定 `--confirm-target-change`，仅在确认仍是同一个数据库的迁移时使用：历史快照仍来自原服务器。不同数据库必须创建新的数据源 ID。程序检查新配置后才覆盖本机凭据。MySQL 库名中的 `_` 或 `%` 在 `partial_revokes` 关闭时必须在数据库级授权中正确转义，否则权限范围可能超过目标库，检查会拒绝该账号。

如需将凭据转给同一机器新配对的 Connector，应先停止旧、新 Connector，记录原 Connector ID，并运行 `source adopt --id SOURCE_ID --from OLD_CONNECTOR_ID --confirm-both-stopped`；然后在平台重新关联到新 Connector。此操作只适用于同一数据库的迁移，会保留数据源 ID、本机工作空间范围和原有历史快照；不应借此将其他数据库的历史混在一起。

迁移至其他机器时，可在新 Connector 使用 `source add --id SOURCE_ID --confirm-existing-source` 及其余连接参数，交互输入数据库密码并检查授权，再在平台解除原工作空间绑定、重新关联新 Connector 并重新绑定。该命令只适用于确认同一数据库迁移：旧快照仍被保留；新机器上已有的同 ID 凭据不会被覆盖。原机器的凭据应在确认迁移后按需移除。

## 第八阶段 G3：受控写入的安装与本机配置

G3 已加入正式授权器、执行日志、固定 MySQL 安装模板、独立恢复身份和签名协议的实现，供隔离测试与审核。**产品运行入口仍关闭，不能用于用户原数据库。** 普通 `connector run` 尚未装配受控写入处理器；以下配置成功也不会开启写入。平台主入口拒绝 `ENABLE_STAGE8_WRITES` 的非 `0` 值；不存在可用的 `write enable` 命令。G4 安全验收前不要修改这些门禁来使用真实业务数据。

操作分为离线生成、DBA 审核安装、只读核验和本机登记。安装 SQL 由 DBA 在明确授权的独立实验环境中执行；Connector 的三个 `write` 命令均不执行安装 DDL。先停止当前身份的 `run`；命令共用 Connector 配置排他锁，不应并发操作。以下文件、账号、表名均为虚构示例，密码不写入文件、参数或环境变量。

1. 准备安装规格，例如 `install-spec.json`：

   ```json
   {
     "catalog": "write_lab",
     "tables": ["items"],
     "writer": { "user": "lab_writer", "host": "localhost" },
     "recovery": { "user": "lab_recovery", "host": "localhost" }
   }
   ```

   目标库、表必须已存在；当前仅接受小写目录和表名、两个不同的非 root 账号，账号 `host` 仅接受 `localhost`、`127.0.0.1` 或 `::1`。writer 和 recovery 由 DBA 单独安全创建，不由模板生成密码。省略的 `incarnation` 和 `generation` 由命令生成；不要手工复用旧安装世代。单个规格最多 32 张表。

2. 在 `connector/go` 目录生成新的离线文件：

   ```powershell
   go run ./cmd/connector write plan-install --spec C:\safe-location\install-spec.json --out C:\safe-location\write-install.sql
   ```

   此命令不连接数据库，不读取数据库凭据，输出 `write-install.sql` 和固定世代的 `write-install.sql.spec.json`，已有文件不会覆盖。DBA 须审核实际输出的全部 SQL、账号权限、固定过程和停写安排，再决定是否在已授权的独立库安装。模板会新建独立控制库和锁定的 definer；该身份拥有元数据核验所需的全局 `REFERENCES`、`TRIGGER` 及控制对象权限，不应称为只读身份。writer 只获得指定业务表的权限和固定过程的 `EXECUTE`；recovery 使用独立账号及固定恢复过程。安装无自动复用或重置路径；部分失败应保留现场核查。

3. 准备经过本机管理员审核的策略数组，例如 `write-policy.json`：

   ```json
   [
     {
       "database": "write_lab",
       "table": "items",
       "insertColumns": ["id", "label", "tenant_id"],
       "updateColumns": ["label"],
       "previewColumns": ["id", "label", "tenant_id"],
       "delete": false,
       "rowPredicates": [
         { "column": "tenant_id", "operator": "eq", "value": { "kind": "integer", "value": "7" } }
       ],
       "maxRows": 10,
       "maxBytes": 65536
     }
   ]
   ```

   示例要求实际表有对应列及可验证的主键，不会创建这些列。行条件由 Connector 强制执行；`previewColumns` 至少包含全部主键及允许写入的列，候选条件也只能使用其中的字段。完整行值留在 Connector 的短期加密包中。策略不从平台或模型接收；省略的策略 `generation` 在登记时统一生成。触发器、外键、CHECK、生成列、表达式默认值、自动更新及未支持的类型等均会被拒绝，不可通过删减核验继续执行。

4. 在已配对、已登记本机只读数据源的同一身份下，显式核验 DBA 已安装的对象。以下 PowerShell 变量须先设为该独立环境的真实配置；`$sourceId`、`$workspaceId` 来自现有本机数据源及其授权范围：

   ```powershell
   go run ./cmd/connector write capture-configure `
     --source $sourceId `
     --spec C:\safe-location\write-install.sql.spec.json `
     --policy C:\safe-location\write-policy.json `
     --manifest C:\safe-location\write-bundle.json `
     --host $isolatedHost --port $isolatedPort --tls local `
     --admin $metadataAccount --workspaces $workspaceId `
     --confirm-reviewed-installation
   ```

   `--tls local` 仅允许回环地址；命令不提供跳过证书验证的模式。命令只在交互终端读取核验账号、writer、recovery 的密码，输入不回显。核验账号只执行只读检查且密码不保存；随后分别核验运行账号和恢复账号、完整安装定义、权限及策略。地址、端口、TLS、目录和工作区必须匹配已有本机数据源；尚未过期的模型发送授权租约会阻止配置。确认标记表示 DBA 已审核并安装，不能代替实际核验。

   本机写 profile 与只读数据源分开；writer、recovery 和目标根密钥保存在系统凭据库，安装清单与策略合并为 MAC 认证的本机 bundle。新 bundle 和 bbolt 日志采用 Windows 当前用户文件权限及独占创建，不覆盖已有文件。同一目标的别名共享规范目标身份、根密钥、日志及恢复门；不能靠新增数据源绕过冻结。部分配置或已有 profile 会拒绝覆盖，失败后应保留日志、清单和凭据现场，不能删掉重试。

5. 仅查看本机登记元数据：

   ```powershell
   go run ./cmd/connector write status --source $sourceId
   ```

   `status` 验证本机 bundle 的 MAC，显示目标身份、安装世代和策略数量；不连接数据库、不查询提交结果，也不证明当前连接可用。以上命令不为正常 `run` 开启写入。

每个敏感预览包使用独立随机 AES-GCM 密钥，系统凭据库只在本 Connector、目标身份的专有命名空间内保存和枚举密钥；bbolt 保存密文及带认证的元数据。受保护的命名空间索引在创建密钥前登记，单 Connector 当前最多 32 个目标。显式装配的 G3 会话管理器在启动和后台清理这些命名空间，即使日志缺失或损坏也处理已过期密钥；读取索引、清理或日志验证失败会关闭写入准入并保留可追踪状态。普通 `run` 当前没有装配该管理器，不能将其当作已运行的保留期限服务。

基础设施复用 bbolt 的事务日志、现有 go-keyring/Windows wincred 凭据接口、标准库 AES-GCM 和 x/sys/windows 系统计时能力；项目自身仍校验密钥归属、完整元数据、权限、事务与确认协议。固定过程的安装维护由可信 DBA 管理，不能防御恶意 DBA 或被攻陷的 Connector 主机。

短期预览到期后删除独立包密钥，再逻辑删除负载；提交结果未知时仅允许保留到首次预览确定的最多 24 小时核对期限，不随重启续期。永久执行墓碑不随负载清理删除。操作系统凭据库**没有原生 TTL**：Connector 停止时不会自动清理，离线时间、凭据库故障及凭据备份可能延长材料留存；不能宣称磁盘物理擦除、备份删除或整机快照防回退。保留期限清理不授予旧操作再次执行的资格。

恢复需先排空并轮换目标门，再核对本机登记与同事务目标回执；缺少可靠证据保持结果未知，不重跑旧执行。备份须将平台登记、目标业务数据与回执、本机 bundle、日志和受限凭据作为关联材料规划；不得仅还原一份日志就解冻。业务库和回执一起回退时，须停写、停相关进程并按维护方案建立新 incarnation；没有可靠外部权威时无法自动证明被回退的提交。迁移、重置、丢失密钥或恢复备份均不应靠清空日志、删除凭据或手工改终态解决。

当前执行日志使用 v2 格式，为每个预览持久记录并认证唯一的执行归属，防止其他执行或清理流程删除未知结果所需的恢复包。不支持的日志格式会拒绝打开，既不自动迁移也不删除或重写文件；遇到这种情况应保留现场核查。

当前 G3 证据来自 Windows/amd64 和 MySQL 26.7.0 的新独立实例，使用虚构数据、独立账号与显式测试密钥存储；未操作用户原库或真实用户凭据库。计时实现要求 Windows 10+ amd64，并使用含休眠语义的系统 API；普通等待及故障注入不等于真实休眠、电源转换或断电验收。MySQL 8.0、其他系统/架构、完整故障与 W01–W64 验收仍待 G4；不能据此宣称生产可用。

## 结构化诊断日志

G4 的真实 TCP 提交响应丢失、进程终止、锁竞争与凭据验证见 [本机隔离验证记录](../../docs/23-第八阶段G4本机隔离验证记录.md)。按用户决定，真实断电、实机休眠和物理磁盘故障不再作为当前实测任务或阻断项，对应行为仍未验证；其余矩阵尚未全部通过，普通 `run` 的写入 Handler 继续关闭。

Connector 的运行诊断默认以 UTF-8 JSON 写入标准错误，级别为 `info`。事件码、结果类别和字段均有固定允许列表；可关联的 `connectorId`、`sourceId`、`taskId`、`executionId` 与平台响应的 `requestId` 只接受 UUID 形式，耗时以 `durationMs` 给出。没有记录 SQL、参数、结果行、数据库或模型凭据、原始问题、连接串或原始错误文本。常规成功心跳仅在 `debug` 级别记录，普通终端进度仍保留。

使用 `CONNECTOR_LOG_LEVEL=debug|info|warn|error` 设置级别。默认输出为标准错误；如明确需要文件，将 `CONNECTOR_LOG_OUTPUT` 设为 `file`，并用 `CONNECTOR_LOG_FILE` 指定绝对路径。`CONNECTOR_LOG_MAX_SIZE_MB` 可选，默认 10 MB、范围 1～1024 MB；文件达到上限时使用已锁定的 lumberjack 轮转，最多保留 3 个备份、最长 7 天。仅在有新日志触发轮转时清理旧备份，停机期间不会自动清理。文件保护继承部署目录的访问控制，Windows 的 `0600` 不替代目录 ACL；诊断日志不是受控写入审计记录，不能作为提交结果依据。

诊断文件配置不可用时回退到标准错误并继续业务；写入失败或短写时向标准错误输出一次固定事件码告警，且本次日志器的 `Health()` 保持失败状态。告警不包含底层错误、路径或业务数据；如果标准错误本身不可用，告警也无法保证送达。

不同物理目标各自协调恢复和准入；相同目标的别名共享同一协调门，等待可响应上下文取消。启动世代改变时先停止旧准入、取消旧任务并等待退出，再恢复新世代。系统凭据库等第三方 API 本身不接受取消上下文，如果系统调用卡住，退出仍可能等待该调用返回；不能声称任意宿主系统故障下关闭都有硬实时上限。Go 核心与基础设施的依赖规则可用 `go test ./internal/architecture` 验证。
