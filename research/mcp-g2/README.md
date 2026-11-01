# 第九阶段 G2 独立技术验证

本目录验证官方 MCP SDK、OAuth、授权快照、网络限制和本机执行宿主的技术可行性，不是产品 MCP 入口。平台应用和 Connector 未引用此目录，正常写入门禁未改变。结果与限制见 [G2 记录](../../docs/27-第九阶段G2隔离技术验证与审核记录.md)。

## 模块

| 路径 | 职责 |
| --- | --- |
| `src/grant-authority.ts` | 独立于 SDK/ORM 的授权判定；存储端口提供事务内会话与授权快照。 |
| `src/resource-verifier.ts` | Better Auth 公开只读校验 API 的伴随插件；补充签发者、资源、权限及应用授权。测试端点未挂到产品。 |
| `src/callback.ts` | 绑定真实管理员会话、连接、签发者、资源及回调地址；状态一次性消费。 |
| `src/authorization-work.ts` | 授权等待截止、取消及尚未结束工作的独立容量；不释放仍在运行的 SDK 工作配额。 |
| `src/retained-permit.ts` | 响应与真实工具工作共同持有原配额，断线不能释放尚未结束的执行。 |
| `src/limits.ts`、`src/stdio-boundary.ts` | 实际字节、结构、帧及时间边界；MCP 协议仍由官方 SDK 实现。 |
| `src/loopback-listener.ts` | 在动态端口范围内直接绑定自有测试监听器；占用时有限重试，不探测、替换或停止其他服务。 |
| `src/network.ts` | 精确目标 URL、私网地址批准、固定 DNS 连接、凭据目标、重定向和响应边界。 |
| `src/http-fixture.ts` | 自有回环 SDK Server 与合成工具；不执行 SQL。 |
| `test/fixtures` | 使用现有应用的真实认证工厂、会话事务校验和隔离数据库 guard；测试凭据随机生成。 |
| `windows` | 固定测试程序的 Windows Job 拥有关系与回收证明；使用测试选择的 Node，不提供外部命令配置。 |
| `bridge` | 仅用 Go 标准库验证 Go→Node 私有管道、上下文取消与帧边界；不运行产品 Connector。 |
| `schema` | SDK 实测生成的 OAuth DDL 与最小应用授权草稿，未注册为产品迁移，不代表完整 MCP 产品模型。 |
| `tools` | Windows/amd64 桥接构建及实际依赖许可证清单。 |

## 复现约束

当前范围：Windows/x64、Node 24.19.0、pnpm 12.14.0、MySQL 26.7.0。Go 工具链实测为 1.26.0/windows/386，构建脚本明确生成并验证 Windows/amd64 的桥接程序；其他平台未准入。

从仓库根目录执行现有 `scripts/start-stage8-isolated-mysql.ps1`，它只创建新的随机数据目录和回环 13308 实例，端口占用时拒绝。将**本次输出的新清单**赋给当前终端的 `STAGE8_G3_MANIFEST`，不复制密码，不重用旧运行清单，不从 `.env` 或默认数据库连接回退。

先在仓库根目录构建应用测试所用的当前认证代码：

```powershell
pnpm --filter @workspace/community-api build
```

然后在本目录执行：

```powershell
pnpm install --frozen-lockfile --ignore-scripts --strict-peer-dependencies
pnpm test
node tools/dependency-ledger.mjs
```

本目录有自己的 `pnpm-workspace.yaml` 和锁文件。安装必须读取它们才能应用项目已有的 Kysely/mysql2 补丁；不要加 `--ignore-workspace`。父项目锁文件未参与本轮安装。

没有隔离清单时数据库用例直接失败。每次连接核验固定端口、数据目录、实例 UUID、PID 文件与拥有 PID；只创建本次随机测试 schema，并在退出时清理。创建、清理失败保留错误，不能将失败写成成功。运行结束后，由本机操作方在同一 guard 核验后关闭**本轮**实例；不得按进程名称批量结束服务或操作默认端口。

## 选型边界

- MCP 使用官方 server/client/core 2.4.0 与 Node 适配器 2.1.2。2025-11-25、2026-07-28 的实测路径均由 SDK 提供；本地 stdio 明确选择协议，避免自动探测额外启动程序。实际第三方客户端兼容性仍待后续验收。
- 认证使用 Better Auth/MCP/OAuth Provider 1.7.14 与实际依赖要求一致的 utils 0.5.1。只配置公共原生客户端和 S256，不启用匿名 DCR、机器授权或刷新。CIMD 包仅作候选检查，未启用或验证，不宣称完整 CIMD 授权配置通过。
- opaque token 使用哈希，不创建 JWT 私钥或机密客户端。SDK 可空会话关联在删除会话后可变为 NULL；应用独立保留审批会话引用，通过认证模块只读的 `authSessionReferenceDeadline` 公开端口拒绝孤立令牌。
- 同一授权事务连接对本模块授权和真实审批会话取共享锁；持锁期间通过 SDK 公开端口完成最后的令牌核验，并在事务结束后检查授权、会话及令牌期限。SDK 和授权观察使用独立的有界 guarded pool，防止等待自身池容量。产品集成仍须在派发与披露边界重新判定。
- 授权代码和缓存同意绑定真正批准时的世代。世代变化后需显式重新同意，旧批准不能通过读“当前世代”获得新令牌权限。过期代码绑定先清理再检查容量。
- 审批通过本模块授权行锁后才调用 SDK 同意端口，失效尝试不能更改当前同意缓存。该边界必须应用于未来的产品路由，不能独立开放原始 SDK 同意入口。
- 网络批准保留查询参数；私网批准必须逐地址匹配。除公共协议头外，输入头只允许发往精确声明的凭据目标；配置密钥时须保留其凭据角色，不能将密钥放入公共协议头。
- OAuth Client 算法用真实 SDK 与进程内 Request 桥验证，TCP/解析/重定向另有真实回环测试；它们不提供公网 HTTPS、浏览器跨站 Cookie 或第三方客户端保证。
- Windows Job 与私有管道均不提供恶意同用户程序之间的权限隔离。安全库用例只读写随机合成条目，证明同用户进程可共享读取并在最后删除该条目。

产品路由、管理界面、完整工作区/数据源/字段约束、签名 Connector 契约、真实人类查询/结果审批、外部工具执行状态和生产日志审计组合继续在 G3/G4/G5 实现与审核。
