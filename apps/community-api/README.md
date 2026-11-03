# Community API

Connector 配对、身份和诊断使用单进程本地状态文件及操作系统凭据管理器；状态文件位置可由 `CONNECTOR_STATE_PATH` 指定。第三阶段增加 MySQL 数据源绑定与结构快照；第四阶段提供受严格限制的只读查询。协议和验证范围见 [Connector 协议](../../connector/PROTOCOL.md) 和 [第四阶段记录](../../docs/13-第四阶段实施与审核记录.md)。写入和未验证 SQL 语法保持关闭。

第五阶段支持在“模型配置”中填写 OpenAI 兼容的 Chat Completions 接口、模型名称及密钥；密钥和配置保存在平台服务所在机器的系统凭据库。公开 HTTPS 地址或明确的本机回环 HTTP 可以配置，私网地址、跳转及不安全目的地址被拒绝。点击检查连接只发送虚构示例。AI 工作台先向 Connector 请求有效期内的本机授权结构，展示发送目标和内容，由用户点击发送；模型输出仅作为候选计划，经程序校验后生成 SQL，仍须用户手动发起、Connector 再次独立校验。不自动发送查询结果或数据库密码；第七阶段启用后对话按用户确认的规则本地保存。兼容接口和 MySQL 版本的测试边界见 [第五阶段记录](../../docs/14-第五阶段实施与审核记录.md)。

第六阶段已完成隔离环境测试，等待用户审核。语义表通过 `pnpm --filter @workspace/community-api db:migrate:stage6` 显式迁移；开启管理界面 API 需设置 `ENABLE_STAGE6_SEMANTICS=1`，并同时启用第三、第四阶段。只要平台库已有有效 004 迁移，所有模型规划始终读取敏感策略，即使管理开关关闭也不能绕过；语义表和迁移历史不一致时停止启动。迁移不会由启动自动运行；未经用户授权不得在已有数据库执行。实时 Connector 结构指纹与语义快照不一致时拒绝模型发送，提示重新扫描并核对语义。敏感标记只约束模型发送，不替代 Connector 的查询授权；业务说明本身可能包含隐私信息，标为非敏感前应检查。当前关系和指标不开放多表或聚合执行。

第七阶段须先对已授权的目标平台库显式执行 `pnpm --filter @workspace/community-api db:migrate:stage7`，再设置 `ENABLE_STAGE7_HISTORY=1`（要求第三、第四、第六阶段均已启用）。005 新增 `history_entry`，启动只核验结构，不自动迁移。未记录的部分 DDL 拒绝启用，保留现场；不得用此命令修复或升级用户原数据库。当前仅对核验过的专用隔离库完成迁移和验证。

第七阶段将对话和保存定义保存在本机；定义包含 SQL、参数类型和图表字段，不包含参数值或结果。内容操作按管理员/工作区/当前数据源绑定授权，采用版本冲突检查和可恢复删除。执行与审计只读，解绑后当前管理员仍能查看必要元数据；未设置自动过期。查询提交/终态及保存/删除审计在数据库事务中提交；重启将旧未确认任务标为结果未知，不自动重跑。

第八阶段 G3 已提供受控写入的应用用例、持久登记、Connector 签名传输和恢复编排，供显式装配的隔离测试验证；这不表示产品写入已开放。正常 `src/main.ts` 始终将 `stage8Enabled` 设为 `false`；`ENABLE_STAGE8_WRITES` 未设置或为 `0` 时保持关闭，其他值会在启动时被拒绝。正常 Connector `run` 也尚未挂接受控写入处理器。没有通过环境变量启用生产写入的操作流程，G4 前不得绕过这些门禁。

G3 平台表来自 [006-controlled-writes.sql](migrations/006-controlled-writes.sql)，必须先在明确授权、已有 001–005 的**独立平台测试库**中验证，再进行相应隔离测试。确认 `DATABASE_URL` 指向该独立库、完成备份及核对后，显式执行：

```powershell
pnpm --filter @workspace/community-api db:migrate:stage8
```

该命令会修改选定的平台库，不会由 API 启动或普通 `db:migrate` 自动补装 006，也不会安装用户数据源的控制对象。检测到部分受控写入表而无完整迁移时停止并保留现场；MySQL DDL 不能承诺整体回滚。不得对用户原数据库执行上述命令来试验、修复或恢复；存在 006 也不等于允许执行写入。

目标数据源使用另一套离线 DBA 安装及本机核验流程：`connector write plan-install --spec ... --out ...` 只生成固定 SQL 和 `.spec.json`；DBA 审核并在授权的独立环境安装后，`write capture-configure` 通过终端读取独立账号密码，只读核验安装并保存本机配置，不执行安装 DDL。完整参数和策略示例见 [Connector G3 操作说明](../../connector/go/README.md#第八阶段-g3受控写入的安装与本机配置)。writer、恢复身份、包密钥及目标根密钥在 Connector 所在机器的系统凭据库，策略和清单在 MAC 认证的本机 bundle；平台不接收这些数据库密码。平台持久数据以公开承诺、范围、执行身份、脱敏摘要和恢复事实为主，不持久保存完整预览行值；AI 草稿发送仍需独立的内容展示和用户确认，不能将模型输出视为执行授权。

平台登记、Connector 日志及目标回执之间不承诺跨系统原子提交或自动重跑。两端重启产生新的内存运行世代，旧执行只查询原记录和回执；启动恢复先经目标门排空，再分页查证，不能用空列表证明从未提交。应关联规划平台、目标业务及回执、本机受保护文件与凭据的备份；目标数据与回执一并恢复到旧备份时需停写并重新建立目标 incarnation，不能恢复旧确认资格或手工改成成功。

敏感预览包使用独立加密密钥；正常清理先删系统凭据库中的包密钥，再逻辑删除本机负载。未知结果的核对包最多保留到首次预览确定的 24 小时截止，不随重启延长；不删除永久执行墓碑。显式装配的管理器按受保护命名空间索引做启动和后台清理，不依赖日志成功打开；普通 Connector `run` 尚未装配。系统凭据库无原生 TTL，进程停机或凭据库故障时不能保证按时清理，更不承诺物理擦除或删除备份。错误时关闭准入并保留现场，不以清空日志、队列或凭据消除未知状态。

当前 G3 数据库和跨组件证据限定于 Windows/amd64、MySQL 26.7.0 的新独立实例、虚构数据及隔离测试装配；未改变用户原数据库。MySQL 8.0、其他操作系统与架构、真实电源转换、断电/磁盘故障及完整 G4 安全矩阵尚未验收。测试中的开关注入不构成产品启用方式。

其他固定审计事件使用 `CONNECTOR_STATE_PATH` 所在目录的 `audit-outbox.json`，先同步写临时文件、刷新并原子替换，再幂等写入数据库。部署需保护该目录；Windows 文件权限继承目录 ACL，`0600` 不替代 Windows ACL。坏文件拒绝启动并保留，磁盘失败暂停后续界面写操作。认证接口 `GET /api/history/audit-health` 返回 `available/durable/pending`；连接器文件、外部模型和审计库之间不承诺跨系统原子提交。不要清空队列来消除告警，先排查磁盘/数据库和日志。完整限制及验证见 [第七阶段记录](../../docs/16-第七阶段实施与审核记录.md)。

第三阶段默认不启用，也不会在启动时自动修改数据库。针对**已备份并确认的目标平台库**，先执行 `pnpm --filter @workspace/community-api db:migrate:stage3`，再设置 `ENABLE_STAGE3_DATASOURCES=1` 启动 API。该迁移只增加数据源、绑定、扫描和快照表；MySQL DDL 不能整体回滚，若检测到无迁移记录的部分表则停止并要求人工检查，不自动清除或修复。当前用户已有开发库尚未应用这项迁移，不能在该库启用第三阶段，除非用户明确要求对其执行变更。

第四阶段只读查询默认关闭；在已具备第三阶段表结构的隔离开发环境，可同时设置 `ENABLE_STAGE3_DATASOURCES=1` 和 `ENABLE_STAGE4_READS=1` 启动 API。启动不会自动迁移数据库。数据源必须绑定工作区、Connector 本机还要明确授权表和字段，并使用受限只读数据库账号；查询结果只保留在内存中。当前执行器仅接受经过隔离测试的 MySQL 26.7.0 和固定 SQL 模式，MySQL 8.0 未验证；解析器要求 64 位 Connector，其他架构返回不可用。该功能仍需按阶段记录审核，不能据此宣称生产可用。

Community 当前为单个本地管理员：Better Auth 1.7.14 管理用户名登录、密码和会话；不开放注册。支持初始化、登录、退出、修改密码、查看和撤销会话、通过本机终端重设密码。工作区由创建者隔离，支持创建、列表、重命名、归档和恢复。成员、邀请、删除、邮箱找回和 Cloud 身份尚未实现。`GET /api/health` 只表示 API 进程响应，不代表用户数据源或模型可用。

## 数据库和迁移

实际表结构以 `migrations/*.sql` 和 `_workspace_migrations` 的版本与校验和为准。项目未上线，尚未用于现有开发数据的迁移可随当前设计调整；对已应用于需保留数据的数据库，不能直接改写其迁移历史或绕过校验，须先制定保留数据的变更方案。`.gitattributes` 保证 SQL 文件跨系统保留相同字节。`archive/schema-product-draft.prisma` 是完整产品设计参考，并非运行时数据库结构或迁移来源；禁止将其应用到开发库。`prisma.config.ts` 对写入型 Prisma 迁移保持阻止。

项目提供 `pnpm --filter @workspace/community-api db:migrate`：在空库建立基础表，或在核对过的旧版表结构上建立基线，再应用已知增量；有迁移锁、校验和和数据库结构核对。MySQL DDL 会隐式提交，脚本不能承诺全部自动回滚；中断后会检查已完成状态，无法识别的部分状态必须停止并人工排查，不能直接清空数据库。API 启动只校验迁移状态，不自动修改表。

本机 `ai_workspace_dev` 已应用 `001`、`002`；不得手动重复运行建表 SQL。升级前应停止写入、在受控位置备份，然后先在隔离库演练。已有账号、密码哈希、工作区和会话不得因升级删除。若需恢复，应先恢复到**新建的空隔离库**，核对表结构与必要记录，再决定如何切换；不要把含 `DROP TABLE` 的数据库转储直接导入现有开发库。备份包含密码哈希、会话令牌和其他敏感数据，要限制访问并按需要删除。对于只包含测试数据的隔离库，使用对应 MySQL 客户端执行示例：

```powershell
# 以下命令会提示数据库密码；不要把密码写在命令参数里。
& 'C:\Program Files\MySQL\MySQL Server 26.7\bin\mysqldump.exe' --host=127.0.0.1 --user=root --password --single-transaction --set-gtid-purged=OFF --no-tablespaces --result-file='C:\safe-location\isolated-backup.sql' source_test_database
# 手工创建独立空目标库后，进入 mysql 命令行并选择该空库：
# source C:/safe-location/isolated-backup.sql
```

以上路径和库名仅为示例；当前本机迁移前的实际备份不在仓库中。曾用**虚构测试账号、凭据及工作区**在 MySQL 26.7.0 的独立空库中演练导出和恢复；不表示已验证生产备份策略。

## 本地启动与管理员

需要 Node 24、pnpm、MySQL 和正确配置的进程环境变量：`DATABASE_URL`（MySQL URL，特殊字符需 URL 编码）、`BETTER_AUTH_SECRET`（至少 32 字符，使用高熵随机值并安全保存）、`APP_ORIGIN`（浏览器访问前端的完整 origin，如 `http://127.0.0.1:5173`）。API 不自动读取 `.env`；开发前端把 `/api` 代理至 `127.0.0.1:3000`，可通过 `API_PROXY_TARGET` 为独立测试环境指定代理。浏览器地址须与 `APP_ORIGIN` 一致。

`API_HOST` 和 `API_PORT` 可调整监听，当前只允许回环地址，默认 `127.0.0.1:3000`。以下 PowerShell 示例会安全读取数据库密码并为本次本地运行生成随机会话密钥；重新生成密钥会使已有会话失效。当前用户提供的 root 账号仅用于本机开发；对外部署前必须建立最小权限数据库账号及对应部署安全方案。

```powershell
$dbPasswordSecure = Read-Host '数据库密码' -AsSecureString
$dbPasswordText = [System.Net.NetworkCredential]::new('', $dbPasswordSecure).Password
$env:DATABASE_URL = 'mysql://root:' + [uri]::EscapeDataString($dbPasswordText) + '@127.0.0.1:3306/ai_workspace_dev'
Remove-Variable dbPasswordText, dbPasswordSecure
$env:APP_ORIGIN = 'http://127.0.0.1:5173'
$env:BETTER_AUTH_SECRET = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
pnpm --filter @workspace/community-api db:migrate
# 仅首次且没有管理员时执行；已创建账号请跳过：
pnpm --filter @workspace/community-api admin:create
pnpm --filter @workspace/community-api dev
```

另开终端运行 `pnpm --filter @workspace/community-web dev`。首次初始化在终端输入用户名、邮箱、显示名称和至少 12 位的密码，密码不回显。已有管理员时禁止重复初始化。页面的“账号安全”可修改密码、查看或撤销会话；修改密码会撤销其他会话。

如果忘记密码，在配置了上述环境变量并完成构建的本机终端运行 `pnpm --filter @workspace/community-api admin:reset-password`，新密码输入两次且不回显；只有数据库中恰有一个本地账号且凭据结构正常时可重设，成功后撤销该账号的全部会话。不要通过聊天、命令参数或普通文件传递新密码。邮箱目前仅为账号资料，不会发送验证或重置邮件。

## 本机诊断日志

G4 当前隔离验证及真实认证链路见 [本机验证记录](../../docs/23-第八阶段G4本机隔离验证记录.md)。用户已排除真实断电、实机休眠和物理磁盘故障实测，不再为这三项等待专用设备；其余准入与安全约束不变。Better Auth 内部日志也通过受控适配器记录固定事件和错误分类，SDK 消息、附加参数和 Cookie 不原样输出；诊断不构成写入准入依据。

主程序使用 Pino 10.4.0 和 rotating-file-stream 3.2.10（均为 MIT 许可）记录结构化诊断日志。默认同时输出到标准输出和本包根目录的 `.runtime/logs/community-api.jsonl`；单个文件按 10 MiB 轮转，保留 7 个归档及当前活动文件。日志为故障排查使用，独立于业务审计，不承诺持久保存。

以下环境变量需设置到 API 进程中；API 不会自动读取 `.env`：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | 可选 `debug`、`info`、`warn`、`error`。 |
| `LOG_DIR` | 本包的 `.runtime/logs` | 日志目录；覆盖时必须使用绝对路径。 |
| `LOG_MAX_BYTES` | `10485760` | 活动文件轮转大小，范围 1024 至 104857600 字节。 |
| `LOG_MAX_FILES` | `7` | 保留归档数，范围 1 至 30，不含活动文件。 |
| `LOG_STDOUT_ONLY` | `0` | 设为 `1` 时只输出标准输出，不创建日志文件。 |

HTTP 请求使用 `X-Request-Id` 关联日志。请求、查询任务和受控写入执行可分别通过请求 ID、任务 ID 和执行 ID 排查；Connector 和 API 中的相同任务或执行 ID 可用于关联两端记录。从仓库根目录运行以下命令，目录和 ID 均需替换为实际值；两个组件使用不同目录时分别查询。工具支持安全命名的 `.log`、`.jsonl` 文件及轮转文件，最多检查 64 个文件；Connector 使用默认标准错误输出时，需在对应输出中另行查找：

```powershell
node scripts/read-diagnostics.mjs --dir 'C:\path\to\logs' --id '00000000-0000-4000-8000-000000000001'
```

`GET /api/diagnostics/logging` 需要管理员登录，返回日志是否可用、是否启用文件、丢弃数量和关闭状态，不返回路径或秘密。事件名和字段均受固定白名单约束；错误只记录分类及受控代码调用位置，不读取传入错误对象的堆栈或记录原始错误消息。诊断日志不记录请求正文、SQL、参数、查询结果、Cookie、凭据或模型问题。

启用文件输出时，如果目录或日志文件在启动时无法打开，API 拒绝启动。运行中发生文件输出故障时，继续尝试标准输出并将日志健康状态标为不可用；输出缓冲有上限，超限会丢弃记录。关闭时对文件和待处理的标准输出分别限时约 2 秒尽力冲刷，因此不能将诊断日志当作可保证送达的审计记录。标准输出本身故障时也无法保证诊断记录送达。

应限制日志目录和文件的访问权限；Windows 需通过目录 ACL 保护，`0600` 不能替代 ACL。日志目录中的 `community-api.lock` 防止多个进程使用同一日志目录；进程异常退出后锁可能遗留，应先核验锁的拥有进程已经退出，再人工处理锁文件，不要自动清空原目录。

## 安全取舍与测试

第九阶段 G4 外部 MCP Client 的配置与验证见 [G4 记录](../../docs/29-第九阶段G4实施与审核记录.md)。它与对外 MCP Server 是两个独立开关；默认 `ENABLE_STAGE9_MCP_CLIENT=0`。数据库迁移、程序安装与启用都需要明确选定环境，不自动触及已有数据库。外部工具可能产生副作用，逐次确认不能证明其业务结果；超时、取消和断线后不自动重试。

第九阶段 G3 MCP Server、授权与撤销和管理界面的运行步骤、当前验证组合与测试证据统一见 [MCP G3 记录](../../docs/28-第九阶段G3实施与审核记录.md)。默认 `ENABLE_STAGE9_MCP=0`。启用前须在获准的平台库完成绑定身份迁移和 MCP Server 迁移。MCP 授权记录绑定代次，升级前缺少该代次的授权需重新发放。启动只校验结构。MySQL 集成测试先构建再运行编译后测试，且必须使用文档中的独立实例和 manifest。本机 stdio 通过系统凭据引用和受信 TLS 通道使用 bearer。

生产依赖审计在 2026-10-31 报告 MySQL2 与 Multer 共 3 项漏洞；按用户要求暂不升级。具体受影响条件、版本和公告链接见 `../../docs/10-第一阶段实施与审核记录.md`。这项审计未通过，不能据此将项目视为生产就绪。

Better Auth 默认在数据库保存会话令牌而不是令牌哈希；用户已同意第一阶段采用此方案。会话 Cookie 经签名，设置了过期及撤销；数据库和备份仍属于敏感数据。认证限流目前是单进程内存限流，当前无法识别客户端 IP 时同一路径共享计数。API 限制为本机监听；反向代理可信 IP、多实例共享限流、TLS、生产密钥和最小权限账号尚未验收，不可宣称可安全对外部署。Cookie 签名和这些控制不等于消除数据库泄漏风险。

`pnpm --filter @workspace/community-api test` 在未设置 `TEST_DATABASE_URL` 时运行离线测试并明确跳过 MySQL 集成测试。集成测试只允许 `127.0.0.1` 的 `ai_workspace_stage1_test`，必须先在该隔离库运行迁移；测试使用临时账号和工作区并按各自 ID 清理。不要指向开发库或生产库。已在 MySQL 26.7.0 完成相关验证；MySQL 8.0 尚需独立验证。
