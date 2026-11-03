> **实现说明（2026-10-31）：** 以下为产品数据库设计草稿。本地账号实现已调整为 Better Auth 用户、凭据和会话模型，并允许邮箱；实际已应用表结构见 `apps/community-api/migrations/001-auth-workspaces.sql`。旧版全量模型已移至 `archive/schema-product-draft.prisma`，仅作为设计参考，不得直接用于迁移现有开发库；当前真实表结构以 `apps/community-api/migrations` 为准。工作区目前仅按创建者隔离，多用户成员权限尚未实现。

> **第七阶段当前实现：** 005 显式迁移使用 `history_entry` 统一存储有严格内容模式的会话、保存定义、执行元数据与固定审计事件。共享不可变归属、数字序列分页、修订号和时间字段；仅会话/定义允许按修订号软删除和恢复。授权通过数据源公开事务接口校验，历史模块不读写数据源或工作区内部表。保存定义只含 SQL 与参数类型，参数值、完整结果和凭证不进入执行或审计内容；会话正文及 SQL 字面量仍可能敏感。执行终态不可覆盖，平台重启恢复为未知而不重跑。具体保留和迁移边界以 [第七阶段记录](16-第七阶段实施与审核记录.md) 为准，下文全量模型仍为未来产品参考。

> **第八阶段 G3 当前实现（2026-11-01）：** 用户已批准 [第 20 号修订](20-第八阶段核验计时与恢复修订.md) 并授权 G3 开发，正式模块及隔离回归已完成本轮实现，当前待审核；阶段 8 尚未验收，G4 未开始。平台实际新增的是 `006-controlled-writes.sql` 的七张元数据表，并非下文草稿中的 ActionProposal / ActionExecution 模型。迁移与恢复、受信目标安装及验证边界见 [第 21 号实现与审核记录](21-第八阶段G3实现与审核记录.md)。006 只在本轮随机隔离平台库验证，没有迁移或修改用户原数据库；正常平台启动和普通 Connector `Run` 仍不开启写入。

# AI Database Workspace

> **第九阶段 G4 当前模型（2026-11-02）：** `008-external-mcp.sql` 为外部 MCP Client 单独拥有六张表：owner（拥有者锁）、connection（配置/世代/工具批准和凭据引用）、call（无参数和结果的调用元数据）、schema_version（迁移及完整结构指纹）、runtime（单实例栅栏）、secret_gc（按执行主机清理凭据引用）。secret_gc 的可空 connectionId 用于凭据发布失败时保留原连接的旧凭据，候选引用不关联连接；不自动回退执行。凭据值只在系统安全存储，参数/结果仅短期内存。迁移只在独立隔离 fixture 执行，原库未更改；当前实现与边界见 [G4 记录](29-第九阶段G4实施与审核记录.md)。

## Community Edition 数据库设计说明

**文档版本：** V0.1\
**数据库：** MySQL（本地测试 26.7.0；8.0 待验证）\
**ORM：** Prisma\
**适用范围：** Community Edition\
**状态：** 初稿，必须通过 Prisma Validate、Migration
和集成测试后才能冻结。

------------------------------------------------------------------------

## 产品范围与模型状态

平台数据库和首批用户数据源使用 MySQL；用户同意使用本地 MySQL 26.7.0 进行初步测试；MySQL 8.0 兼容性和真实数据库迁移仍须独立验证。受控写入属于产品目标，默认只读；ActionProposal / ActionExecution 为设计初稿，完成独立安全设计与验收前不得开放写入。下文写操作要求为准入条件。

MySQL 的 UUID 使用 CHAR(36)，JSON 和 DATETIME(6) 采用 MySQL 类型；时间以 UTC 为应用约定，数据库连接时区与序列化行为必须验证。转换后的模型是未验证初稿，并不构成迁移文件。

MySQL 排序规则会影响字符串唯一性和大小写比较；数据库名、表名、账号及令牌标识的比较方式必须分别确定并测试，不能假设与 PostgreSQL 相同。查询记录中的 `sqlText` 目前没有在模型层防止敏感字面量保存，实现前必须明确拒绝或脱敏策略。

### G3 实际存储边界

006 显式迁移包含 `mutation_scope`、`mutation_target`、`mutation_preview`、`mutation_confirmation`、`mutation_execution`、`mutation_permit`、`mutation_outbox`。它们分别承载作用域锁、共享物理目标冻结、预览身份与承诺、确认唯一消费、执行状态和真实会话引用、固定首次许可及脱敏审计发件箱；预览消费、确认、执行和审计登记在同一平台事务提交，提交后才投递任务。许可请求中的 JSON 仅含身份、范围、世代、挑战及预算等元数据，签名不是许可私钥。这里不保存 MutationPlan、SQL、参数值、预览前后像、查询结果、Cookie、会话令牌或数据库凭证。既有 Better Auth 和历史模块的数据保留规则不因此改变。

目标数据库的回执表和执行世代门由受信 DBA 独立安装，不属于平台七表，也不由应用启动迁移。业务 DML 与原编号回执在同一目标 InnoDB 事务提交；运行及恢复账号只持所需业务权限和固定过程权限，不直接获得回执表的任意读写权。未知、孤立或冲突回执使规范目标及其已知别名保持冻结，回执不用于补造预览、确认或重试资格。API/Connector 重启后的旧任务只允许查证。

执行所需原值仅在浏览器内存、API 有界短时中转及 Connector 的加密预览/核对包中处理，不复制到平台历史或审计。Connector 使用系统凭据库中的独立包密钥与 bbolt 密文，清理先删密钥再逻辑删除负载；未知包最多保留至原预览创建起 24 小时，执行墓碑继续保留，重启和查询不续期。停机期间无法执行清理，系统凭据库没有原生 TTL，也不承诺备份删除或物理擦除。准确生命周期及未验证事项以 [21](21-第八阶段G3实现与审核记录.md) 为准。

## 1. 设计原则

Community Edition 是单实例、自托管产品，不需要 SaaS
多租户体系，但仍然需要本地 Owner 身份。

本地身份用于：

-   Web 本地访问认证
-   API Key 归属
-   MCP 授权
-   写操作确认与操作者追踪
-   审计记录

使用 `LocalAccount`，不使用 SaaS
`users`、`tenants`、`organizations`、`memberships` 等模型。

数据库凭证保存在 Connector 所在用户环境的 Secret Store。Community
平台数据库只保存非敏感连接选项和凭证引用，不保存完整连接字符串、数据库用户名或密码。

------------------------------------------------------------------------

## 2. 模块划分

  ------------------------------------------------------------------------------------------------------------------------
  模块                    核心模型                                                              作用
  ----------------------- --------------------------------------------------------------------- --------------------------
  本地身份                LocalAccount、LocalSession、ApiKey                                    本地 Owner、会话、API Key

  Connector               Connector、ConnectorPairing                                           Connector 身份、配对

  数据源                  DataSource、WorkspaceDataSource                                       数据源元信息、工作区绑定

  Schema                  SchemaSnapshot、SchemaTable、SchemaColumn、SchemaRelation             数据库结构快照

  语义层                  SemanticEntity、SemanticField、SemanticRelationship、SemanticMetric   业务实体、字段和指标

  工作区                  Workspace、Conversation、Message                                      工作区与对话

  AI Runtime              AgentRun、AgentStep、AgentRunEvent                                    AI 任务和步骤

  查询                    QueryRun                                                              SQL 执行历史

  写操作                  ActionProposal、ActionExecution                                       操作预览、确认、执行

  产物                    SavedArtifact                                                         保存查询、图表和分析定义

  MCP                     ExternalMcpServer、ExternalMcpTool、McpInvocation                     外部 MCP 配置和调用

  系统与审计              InstanceSetting、AuditLog                                             本地设置和审计
  ------------------------------------------------------------------------------------------------------------------------

------------------------------------------------------------------------

## 3. ER 关系图

``` mermaid
erDiagram
  LocalAccount ||--o{ LocalSession : has
  LocalAccount ||--o{ ApiKey : owns
  LocalAccount ||--o{ Workspace : creates

  Connector ||--o{ ConnectorPairing : pairs
  Connector ||--o{ DataSource : connects

  DataSource ||--o{ SchemaSnapshot : snapshots
  SchemaSnapshot ||--o{ SchemaTable : contains
  SchemaTable ||--o{ SchemaColumn : contains
  SchemaSnapshot ||--o{ SchemaRelation : defines

  Workspace ||--o{ WorkspaceDataSource : links
  DataSource ||--o{ WorkspaceDataSource : linked

  Workspace ||--o{ Conversation : contains
  Conversation ||--o{ Message : contains
  Conversation ||--o{ AgentRun : executes
  AgentRun ||--o{ AgentStep : contains
  AgentRun ||--o{ AgentRunEvent : emits

  DataSource ||--o{ QueryRun : executes
  AgentRun ||--o{ QueryRun : produces

  DataSource ||--o{ ActionProposal : targets
  ActionProposal ||--o| ActionExecution : executes

  Workspace ||--o{ SavedArtifact : saves
  Workspace ||--o{ SemanticEntity : defines
  SemanticEntity ||--o{ SemanticField : contains
  SemanticEntity ||--o{ SemanticRelationship : relates

  ExternalMcpServer ||--o{ ExternalMcpTool : exposes
  ExternalMcpServer ||--o{ McpInvocation : invokes
```

------------------------------------------------------------------------

## 4. 关键模型说明

### 4.1 LocalAccount

Community 本地 Owner 身份。首次启动时通过初始化流程创建，不需要 SaaS
注册。

### 4.2 Connector 与 DataSource

一个 Connector 可以管理多个 DataSource。`credentialRef` 指向 Connector
本地 Secret Store 中的凭证，不是密码本身。

Connector 应验证任务身份、数据源授权、SQL
操作类型、任务有效期、Nonce、防重放、超时和写操作授权。

### 4.3 SchemaSnapshot

每次扫描形成一个版本。SchemaTable、SchemaColumn、SchemaRelation
属于某一个快照，便于对比数据库结构变化和回溯 AI 使用的 Schema 版本。

### 4.4 Semantic Engine

把 `orders.pay_amt`
这样的技术字段映射为"支付金额"等业务含义。SemanticMetric
保存结构化指标定义，执行前仍必须经过 SQL 生成和 Policy Engine 校验。

### 4.5 AgentRun

记录一次 AI 执行。AgentStep 记录执行步骤；AgentRunEvent 记录可供 SSE
恢复或追踪的事件序列。事件 payload 应避免包含原始敏感数据。

### 4.6 QueryRun

记录
SQL、状态、耗时、行数和脱敏参数摘要。不要默认保存真实参数值或完整查询结果。

### 4.7 ActionProposal 与 ActionExecution

Proposal 是待确认的变更计划；Execution
是实际执行记录。确认时必须校验内容哈希、数据源、目标记录和过期时间。Connector
端还要重新验证权限，不能仅依赖 UI 按钮状态。

### 4.8 SavedArtifact

保存可重复执行的查询定义、可视化配置或分析定义。默认不持久化完整原始查询结果。

### 4.9 ExternalMcpServer

保存 MCP Server 的连接配置。OAuth Token、API Token 等敏感值只保存在
Secret Store，数据库保存 `credentialRef`。

------------------------------------------------------------------------

## 5. 数据安全约束

1.  禁止在 DataSource 中存储数据库密码。
2.  禁止在 ExternalMcpServer.config 中存储明文 Token。
3.  日志不得记录明文凭证和未经脱敏的敏感参数。
4.  查询结果默认仅在本次任务生命周期内处理。
5.  AI 传输前按字段敏感级别执行脱敏策略。
6.  写操作必须经过 Policy Engine 和明确确认。
7.  Action 确认绑定内容哈希并设置有效期。
8.  MCP Tool 调用必须经过授权和审计。
9.  AuditLog 只保存必要元数据，避免复制完整数据行。
10. 删除和保留策略应覆盖消息、执行事件、审计与备份。

------------------------------------------------------------------------

## 6. Prisma Schema 文件

`archive/schema-product-draft.prisma` 是历史产品模型设计草稿，不是已部署结构，也不是迁移来源。实际表结构与迁移以 `apps/community-api/migrations` 为准；未来功能实现时须通过新的受审迁移演进。

安装项目依赖后，可不连接数据库运行静态校验：

``` bash
pnpm prisma validate
```

**仅在隔离的测试 MySQL 已准备好、目标连接地址已核实后**，才配置 `DATABASE_URL` 并评审、生成迁移：

``` bash
pnpm prisma migrate dev --name init_community
```

生产部署使用：

``` bash
pnpm prisma migrate deploy
```

不要在生产环境用 `prisma db push` 代替受控迁移。

### 初始化流程

1.  检查平台 MySQL 是否可用。
2.  执行迁移。
3.  检查 LocalAccount 是否已存在。
4.  若不存在，进入首次 Owner 创建流程。
5.  创建默认 Workspace。
6.  写入默认 InstanceSetting。
7.  启动 AI Runtime。

初始化必须具备幂等性，不能重复创建 Owner 或默认工作区。

------------------------------------------------------------------------

## 第九阶段 MCP 的实际持久化

当前 MCP 的运行结构来源为 `apps/community-api/migrations/007-mcp-server.sql`，与上述产品全量 Prisma 初稿分开。认证模块拥有 SDK OAuth 表，MCP 模块拥有客户端、授权世代、令牌哈希关联和调用元数据；跨模块通过认证公开端口核对会话，不直接读写其他模块表。调用表不存 SQL、参数或结果；审批内容使用有界短期内存交接。

迁移使用独立 `mcp_schema_version` 记录校验和及结构指纹；显式执行后再启动 MCP，启动验证列、索引与外键，不自动修库。本轮只在全新独立实例做迁移、幂等与结构漂移验证，未迁移用户原平台库。具体模型边界、保留、故障恢复与验证范围见 [G3 实施与审核记录](28-第九阶段G3实施与审核记录.md)。

## 7. 当前 Schema 的验证边界

工作区默认数据源和执行记录必须引用已绑定到该工作区的数据源；当前模型仅有独立外键，尚未在数据库层保证该关系，服务实现前必须补齐事务化校验及解绑策略。SchemaRelation 的表、列与快照归属也须由约束或事务化校验保证。

ActionProposal.plan 可能含业务原值，启用写操作前必须明确最小化保存、加密、访问控制、保留期限和备份清理；哈希不能替代执行所需的真实值。

本文件中的 Prisma Schema
是工程初稿，不应在未验证前作为生产迁移直接使用。至少需要完成：

-   `prisma validate`
-   空数据库迁移
-   从上一版本升级迁移
-   关系与级联删除测试
-   唯一约束和索引测试
-   初始化流程幂等测试
-   凭证字段扫描
-   查询与审计数据保留测试

需要特别检查 `SchemaRelation.relationType`
的枚举语义是否与真实数据库外键元数据完全匹配；如果后续支持非外键推断关系，应明确区分"数据库约束关系"和"语义推断关系"。








