# Better Auth 本地账号适配性验证

**重新评估（2026-10-31）：** 用户没有要求无邮箱；邮箱可以作为账号资料。接受调整早期草稿模型后，Better Auth 1.7.14 的用户名插件和 MySQL 驱动适合当前本地管理员登录，已接入项目。它默认保存会话令牌而非令牌哈希，这是明确采用的安全取舍，数据库访问需受到保护。MySQL 26.7.0 已验证登录、错误密码、退出撤销、工作区隔离和跨来源写请求拒绝；MySQL 8.0 和正式部署仍未验证。实际建表 SQL 和运行说明见 `apps/community-api`。历史产品模型 `archive/schema-product-draft.prisma` 仍是设计草稿，不能直接对当前库迁移。

以下保留第一次内存验证的记录，作为模型差异和决策背景；当时不建议直接使用旧模型，不应理解为用户要求无邮箱或 Better Auth 整体不适合。

## 验证范围

在隔离 Node.js 环境中使用 Better Auth 的内存适配器，未连接 MySQL、未使用真实账号或凭证，也未修改产品依赖、数据库模型或应用代码。测试配置使用随机密钥和仅用于测试的示例密码及 `example.test` 邮箱。

运行 `check.mjs` 的实际结果：

1. 标准注册流程只提供用户名、名称和密码，缺少邮箱时返回 400，未创建账号。
2. 补充示例邮箱后可创建账号；用户名与正确密码可以登录，错误密码被拒绝。
3. 测试中的内存适配器保存的会话 `token` 与登录接口返回的令牌相同，密码则未以明文保存在账号记录中。

以上仅验证该版本的内存适配器和所用配置；没有验证 Prisma 适配器、NestJS 集成、MySQL 8.0、令牌撤销、并发初始化或生产部署安全性，不能据此推断这些场景已通过。

## 与当前模型的差异

- 当前 `LocalAccount` 只有用户名和密码哈希，不要求邮箱；Better Auth 用户名插件建立在邮箱和密码认证之上，官方注册示例要求邮箱。无需邮箱发送服务不等于数据模型不需要邮箱字段。
- Better Auth 的用户、凭据和会话各有其模型要求；当前密码哈希直接位于 `LocalAccount.passwordHash`。字段映射不等于它可以直接使用现有结构，需要迁移或专门适配。
- 当前 `LocalSession.tokenHash` 表示会话凭据的哈希；测试中 Better Auth 默认内存适配器存储的是原令牌。官方文档也说明会话表的 `token` 与会话 Cookie 使用同一个标识。仅把 `token` 改名为 `tokenHash` 不会使令牌被哈希。Cookie 签名和具体部署配置会影响风险，不能仅凭此测试断言数据库泄漏必然导致登录被冒用。
- 官方 NestJS 集成是社区维护；具体版本、请求体处理和当前 NestJS 11 的兼容性还没有做集成验证。

本次重新评估选择真实邮箱及调整账号和会话模型，不使用占位邮箱或自定义认证适配器。

## 复现

此目录是独立的临时验证项目，不属于应用工作区，不会启动服务或连接真实数据库。在此目录运行：

```bash
pnpm install --ignore-workspace --frozen-lockfile --ignore-scripts
node check.mjs
```

`pnpm-lock.yaml` 固定验证时的依赖；运行安装需要访问已配置的包源。不要把测试适配器或示例凭证用于实际认证。

参考：[用户名插件](https://better-auth.com/docs/plugins/username)、[邮箱模型](https://better-auth.com/docs/concepts/email)、[会话管理](https://better-auth.com/docs/concepts/session-management)、[数据库结构](https://better-auth.com/docs/concepts/database)、[NestJS 集成](https://better-auth.com/docs/integrations/nestjs)。
