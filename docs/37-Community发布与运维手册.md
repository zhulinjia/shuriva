# Community 发布与运维手册

## 交付边界

当前是上线前工程版本，桌面软件已按用户要求取消。交付包括本机浏览器界面、平台 API 和 Connector 命令行程序，不安装桌面工具链。Community 只承诺已经实际验证的 Windows/amd64、本机回环监听和 MySQL 26.7.0；MySQL 8.0、Linux/macOS、外网部署、多实例及无人值守系统服务尚不能据本记录宣称通过。Cloud 从独立私有仓库发布，不能进入本包。

第八阶段正常产品入口的写入开关仍关闭；隔离执行测试通过不等于普通平台与 Connector 已开放写入。MCP 外部工具由用户信任的独立服务执行，不能用平台的只读设置推断外部服务没有副作用。

## 从源码构建

需要 Node.js 24.19.0 或较新 24.x、pnpm 12.14.0、Go 1.24 或较新版本以及 PowerShell 7。在专用构建目录取得审核的源码及锁文件；不得复制开发机 `.env`、`.runtime`、`.cache`、系统凭据或私有 Cloud 仓库。

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm check:boundaries
pnpm test
pnpm test:release
pwsh -NoProfile -File scripts/build-release.ps1
```

正式构建要求 Git 工作区干净。当前连续开发的未提交代码可以用 `-Candidate` 生成本地审核产物；清单明确标记为候选版，HEAD 仅是基准提交，不能冒充完整源码版本标识。构建不会自动提交、上传或部署。

项目对锁定的 `koffi@3.3.6` 显式禁止安装脚本，Windows/amd64 直接使用其锁定的原生可选包。pnpm 12 对尚未作决定的依赖构建仍可能拒绝安装，即使传入 `--ignore-scripts`；本项目记录精确拒绝而不开放脚本权限或降低全局检查。此行为已用锁定安装和实际原生模块加载核对，移动产物验证还会拒绝从源码工作区回退加载。配置含义见 [pnpm 构建设置](https://github.com/pnpm/pnpm/blob/main/pnpm/docs/settings/build.md)。

脚本先核验输出目录的全部已有祖先，再创建新候选目录；固定白名单清理 API、Web 与公共契约的编译输出，并强制重新构建，避免已删除源文件留下旧模块。它使用 pnpm 自带的 `deploy --node-linker hoisted --prod` 生成平铺生产依赖树，拒绝包内任何链接或 junction，不能把绝对链接的目标换算成相对清单就当作可移动。保留失败产物供排查，不自动覆盖或清除其他候选目录。参考 [pnpm deploy](https://pnpm.io/cli/deploy)，行为以锁定版本的实际执行结果为准。

许可证清单从已经部署的纯生产平台目录的真实包目录及元数据收集，包含实际分发的原生可选包。锁定的 pnpm 12 在 hoisted 模式下的 license JSON 仍给出不存在的虚拟路径，故不将那些路径当成实物；这一步只做已安装文件清单，不重新解析或安装依赖。网页生产依赖继续使用 pnpm 报告，另单独纳入已嵌入 CSS 的 Tailwind，不将全部开发工具当作运行时组件。Go 清单补充实际工具链的 runtime/标准库许可，以及编译闭包中 vendored 模块的精确模块元数据、LICENSE 和 PATENTS。支持 `LICENSE.third-party.md` 等真实文件名。三个上游包缺少独立 LICENSE 时，使用 `docs/third-party/supplements.json` 绑定的精确版本、许可声明、官方提交来源与 SHA-256 原文；不按名称推测许可。正式发布存在缺失许可材料时失败，不写可发布清单。

```powershell
node scripts/verify-release.mjs ABSOLUTE_RELEASE_DIRECTORY
```

产物内携带相同校验工具，部署后可使用 `node tools/verify-release.mjs ABSOLUTE_RELEASE_DIRECTORY`；诊断工具同样位于 `tools/`。

校验可发现相对清单的文件、内容和依赖链接变化；清单与内容一同被恶意替换仍可能通过，所以它不是发布者签名。未配置签名密钥，不宣称可信发布签名或位级可复现二进制。依赖声明和许可证文本随包提供；许可证缺失需补充审查，不能据软件名称猜许可。

候选构建后运行 `node scripts/verify-portability.mjs ABSOLUTE_NEW_CANDIDATE_DIRECTORY`，该工具只接受 `.cache/releases/shuriva-community-*` 新建产物，并实际将其移动到另一目录。它重新执行包内校验，在独立 Node 进程禁止向包外解析依赖，加载平台及原生可选依赖，并运行移动后的 `connector.exe help/version`；成功后报告新的产物路径。该验证不连接数据库、不读取真实系统凭据，不能代替干净电脑安装或完整运行验收。

## 本机安装与启动

在独立安装目录准备审核的产物，另建只有运行账号可访问的数据目录。Windows 需要实际设置目录 ACL；文件名或 `0600` 不能代替 ACL。升级时数据目录应保持在产物目录之外。

在受保护文件 `C:\ShurivaData\platform.env` 中填写配置。数据库连接与认证秘密没有默认值，应由部署管理员提供；不要将秘密复制到命令、截图、问题单、仓库或日志。现有数据库不得为试用而迁移或修复。

```dotenv
API_HOST=127.0.0.1
API_PORT=3000
APP_ORIGIN=http://127.0.0.1:3000
WEB_ASSETS_DIR=C:\Shuriva\web
CONNECTOR_STATE_PATH=C:\ShurivaData\platform\connectors.json
LOG_DIR=C:\ShurivaData\logs
LOG_LEVEL=info
LOG_STDOUT_ONLY=0
DATABASE_URL=
BETTER_AUTH_SECRET=
ENABLE_STAGE3_DATASOURCES=0
ENABLE_STAGE4_READS=0
ENABLE_STAGE6_SEMANTICS=0
ENABLE_STAGE7_HISTORY=0
ENABLE_STAGE9_MCP=0
ENABLE_STAGE9_MCP_CLIENT=0
```

路径只是安装示例，须填为真实绝对路径。网页服务只装载 `index.html` 和有限的构建资源，不提供源码、源映射、任意目录或单页路由回退；资源按启动时快照提供，更新构建后需重启。启动时使用现成 parse5 HTML 解析器核对入口脚本、样式及 modulepreload 引用实际存在，拒绝原型属性类型名、链接逃逸、读取期间替换或增长；按实际读取字节限制单文件与总内存。请求主机名须与配置的本机 APP_ORIGIN 一致。当前 HTTP 仅用于回环本机环境，不能据此对外开放。

```powershell
node --env-file=C:\ShurivaData\platform.env C:\Shuriva\platform\dist\src\main.js
```

启动不会迁移数据库。新建的专用平台库先按 API 模块文档显式初始化 001–006，再按所需能力显式运行 007、008、009 对应迁移入口。发布产物内使用 `node --env-file=... platform/dist/src/migrations.js` 及相应阶段参数；绑定身份使用 `binding-migrate.js`、MCP Server 使用 `mcp-migrate.js`、MCP Client 使用 `mcp-client-migrate.js`。逐项查验迁移记录后再开启对应开关，不能手工重复运行建表 SQL。MySQL DDL 不能保证整批原子回滚，部分失败必须保留结构并走文档中的检查/前向恢复。

上方示例默认关闭数据源模块。需要登记 Connector 数据源时，先停止平台，在完成 001、002 的专用平台库执行 `migrations.js --stage3` 并核验，再将受保护配置中的 `ENABLE_STAGE3_DATASOURCES=1` 后重启，才可打开数据源页面取得工作区 ID 和登记绑定。只读查询另需 `ENABLE_STAGE4_READS=1` 并重启；不要仅设置 Connector 本机允许范围就认为平台模块已启用。具体发布包命令和顺序见 `CONNECTOR.md`。

管理员初始化与终端密码恢复对应 `create-admin.js`、`reset-admin.js`；均从受保护环境配置启动，并在终端交互输入密码。不要把密码放进命令行。Connector 的首次配对、本机范围配置、日志和系统凭据存储见同包 `CONNECTOR.md`，直接使用 `connector.exe`，不要求用户安装 Go 或从源码启动。平台密钥和 Connector 的数据库密钥属于不同安全边界，不能因打包而集中存进平台库。

## 健康检查和排障

`GET /api/health` 只表示平台进程能够响应，不能证明数据库、模型或 Connector 可用。管理员登录后还应核验工作区、Connector 在线情况、数据源绑定、模型配置和脱敏诊断状态。查询或外部调用结果不明时使用原编号核对，禁止自动补发以“验证是否成功”。

日志使用已有结构化诊断模块：平台按 `LOG_MAX_BYTES`、`LOG_MAX_FILES` 轮转，Connector 按其专属配置轮转。平台诊断不是审计，审计不是数据库提交凭证。使用请求、任务或执行编号关联日志；日志不应包含 SQL、参数、结果、完整元数据、口令和访问令牌。

```powershell
node tools/read-diagnostics.mjs --dir ABSOLUTE_LOG_DIRECTORY --id REQUEST_OR_TASK_UUID
```

监控应至少关注：启动失败、关闭失败、日志不可写/丢弃、审计暂存队列不可持久化、Connector 离线、签名与范围拒绝、确认过期、连接清理不明和执行结果不明。故障时保留现场，不清空审计 outbox、写入墓碑或恢复材料来消除告警。服务结束后核实相关子进程已经退出；不要终止本机其他项目的数据库或进程。

## 备份、更新与恢复

先在空的独立恢复库演练，再考虑业务环境。备份至少涵盖：平台库、平台受保护状态及系统凭据、本机 Connector 策略/受保护日志/凭据；受控写入还须关联备份目标业务数据与目标回执。仅复制平台数据库不构成完整恢复方案。备份含账号哈希、会话令牌和业务信息，需要限制访问、加密存储并制定保留周期；具体密钥管理与备份介质由部署管理员确定。

平台 MySQL 使用 DBA 审核的逻辑或物理备份方案。InnoDB 逻辑备份需要一致性视图并禁止并发 DDL；工具版本和账号权限需与实际实例匹配。密码通过工具的受保护凭据机制提供，不填进示例命令或进程参数。恢复只向**新建空库**导入，不对已有库执行带 DROP 的转储；核验迁移记录、外键/约束、管理员、工作区、绑定、审计和必要计数。

**恢复后的平台和 MCP 监听必须保持关闭，先吊销从备份恢复的会话。** 旧备份可能包含后来已撤销、但尚未过期的会话；恢复相同认证秘密后，旧 Cookie 可能重新有效。管理员再次登录本身不能吊销它们。使用只指向新恢复库的受保护配置，在终端执行现有单管理员密码重置流程：

```powershell
node --env-file=C:\ShurivaData\restore.env C:\Shuriva\platform\dist\src\reset-admin.js
```

该流程在同一事务内更新唯一管理员的凭据并删除其全部平台会话；终端交互输入新密码，不从命令行传入。必须确认恢复库确实只有一个管理员及一条正确的本地凭据，否则保持关闭并检查结构，不绕过校验或手工清空数据。核验旧 Cookie 不再通过认证、新密码可用之后，才允许切换数据库配置和重新启动。MCP 的应用授权仍须核验其真实批准会话，恢复的旧授权不能据一份旧会话继续使用；管理员需重新认证并明确批准所需范围。外部调用和数据库执行则重新建立运行世代、按原编号核对未知结果，不重放旧请求。系统凭据及 Connector 恢复另遵守相应材料和准入约束。

更新采用停服务、备份、隔离演练、显式迁移、核验后切换目录的顺序。尚未上线，不维护假设中的旧协议双写或兼容分支；保留已有开发数据和恢复材料仍是必须遵守的数据保护要求。出现数据库结构变化时，回退二进制不等于回退数据；先保持停写，按迁移的前向修复方案处理，禁止自动重置。

真实断电、实机休眠/恢复和物理磁盘故障按用户决定不测试，不作为当前 G4 阻断项，也不记为已通过。安全的进程、网络和存储错误测试不构成硬件保证。

## 当前验收证据

发布工具、静态服务和许可清单的实际执行状态另记在阶段验收记录。干净机器安装、MySQL 8.0、发布签名、公网 TLS/可信代理/共享限流、跨机系统凭据迁移和真实支付均不能用本机候选包构建代替。未完成项目保持“未验证/未配置”，不得填成通过。
