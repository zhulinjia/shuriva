# Shuriva

当前处于分阶段开发和验收阶段。第一阶段包含登录、受控工作台描述、SQLite 只读查询和 AI 工作台生成的初步链路；PostgreSQL / MySQL 尚未完成真实数据库验收，数据库写入、文件导入和云端能力尚未实现。原有设计演示仍可从 `/workspaces` 访问，与真实服务分离。

本机隔离验收方法、具体操作和已知限制见 [第一阶段验收说明](docs/phase-1-acceptance.md)和 [AI 配置与连接测试](docs/phase-2-ai-connection-acceptance.md)。当前推进数据源结构理解，操作方法与边界见 [数据源结构验收说明](docs/phase-2-datasource-metadata-acceptance.md)。自动化测试使用真实 SQLite 和模拟 AI，不能代表真实模型已经验证；手工操作会使用所选择的模型配置。

正式服务的本地开发启动：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm server:build
pnpm admin          # 首次创建管理员；忘记密码使用 pnpm admin reset-password
pnpm server:start
```

访问 `http://127.0.0.1:3000`。应用数据和独立加密密钥默认保存在 `.shuriva`；可通过 `SHURIVA_DATA_DIR` 指定其他目录，应一同备份并限制访问。服务默认只监听本机，当前阶段不应直接暴露到公网。`pnpm dev` 可启动 Vite，开发时仍需另开终端运行 `pnpm server:dev`。

## 服务端职责

- `server/app.ts` 只负责装配认证、数据源、工作台、AI 和静态资源路由；具体业务由各目录中的服务或存储模块处理。
- `server/auth/` 负责单用户登录、会话及请求来源校验；管理员初始化和密码恢复由 `server/admin.ts` 执行。
- `server/datasources/` 分别实现 SQLite、PostgreSQL、MySQL 的只读访问；查询编译只接受已校验的描述，并将值参数化。SQLite 访问在独立工作线程中进行。
- `server/workspaces/` 负责工作台持久化、版本冲突及数据源引用检查。保存工作台与删除数据源时，在 SQLite 写事务中检查关联。
- `server/ai/` 使用 AI SDK 对应的 DeepSeek、OpenAI、Anthropic 原生 Provider，并保留自定义 OpenAI 兼容 Provider。Claude 使用 Messages 与 JSON Schema 输出，其他提供商使用 Chat Completions；服务端继续独立校验工作台 Schema 和数据源字段，并限制响应大小、超时及自动重试。
- 应用数据库和加密密钥的读取在 `server/storage.ts`、`server/secrets.ts` 中集中处理；数据库凭证和模型密钥不返回浏览器或写入普通请求日志。

AI 修改工作台时，用户输入、所选数据源结构和工作台配置会发送给所配置的模型服务；已有查询的筛选值会先以临时标记替换，并仅在同一查询、数据源、表和字段下由服务端校验和恢复。数据源结构默认包含读取到的全部表和字段，可在数据源结构页面选择限制范围；服务端按此范围筛选表、字段、业务说明和关系，并拒绝引用范围外字段的当前或生成的查询。用户自行输入到需求或配置中的信息仍会发送。当前不发送数据库记录样本，也不能把这一步等同于完整的字段或行级权限。

数据源结构页面展示只读获取的表、字段、数据库注释和已声明关系，并可在 Shuriva 中加密保存业务说明与用户确认的关系，不修改原数据库。说明优先于数据库注释供 AI 理解。`GET /api/datasources/:id/schema` 返回结构、读取警告和当前配置，`PUT /api/datasources/:id/metadata` 按版本保存配置；多源配置相互隔离。关系目前仅提供上下文，查询仍为单表。表或字段读取超出上限时会提示并阻止 AI 生成，避免把不完整的结构当作完整结构。

工作台系统提示词位于 `server/ai/workspace-prompt.md`，独立连接测试提示词位于 `server/ai/connection-test-prompt.md`，使用中文维护。服务启动时加载这些文件；修改后需重启服务，编译运行时还需重新执行 `pnpm server:build` 复制更新后的提示词。

AI 设置采用提供商列表和配置详情，预置 DeepSeek、OpenAI、Claude，并保留自定义 OpenAI 兼容服务。每家连接保存一份地址和密钥，下挂多个模型，每个模型包含显示名称、实际 API ID 和启用状态，并选择一个已启用的默认模型。DeepSeek 只预置 `deepseek-flash`，OpenAI 预置两个模型，Claude 预置三个模型；也可手动添加账号或代理提供的其他模型 ID。

编辑或保存另一家不会切换默认提供商；首次保存时自动启用，之后通过「设为当前使用」明确切换。创建页面和 AI 修改面板可临时选择任意已配置且已启用的模型，该选择不改变全局默认项，也不写入工作台业务 Schema。

`GET /api/settings/ai/providers` 返回不含密钥的全部配置与 `activeProvider`；`PUT /api/settings/ai/providers` 保存 `{ provider, baseUrl, apiKey?, models: [{ id, label, enabled }], defaultModel }`；`POST /api/settings/ai/active` 接受 `{ provider }` 切换默认提供商。服务端拒绝重复模型 ID、空列表，以及未启用或不存在的默认模型。

原有 `GET /api/settings/ai` 继续返回默认提供商与模型，`PUT /api/settings/ai` 兼容保存单个模型并设为该提供商默认，保留其他模型；`POST /api/settings/ai/test` 按表单中的 `model` 单独测试，不保存或读取业务数据。同一提供商和服务地址可省略密钥以复用该项已保存值，更换地址需要重新填写，禁止跨提供商借用密钥。

`POST /api/ai/generate` 可额外携带 `aiModel: { provider, modelId }`，服务端从保存的连接中解析密钥，并检查模型已配置且已启用；省略时使用全局默认项。浏览器不能通过该对象注入服务地址、密钥或 SDK 参数，失效选择明确报错，不会静默切换模型。

配置整体加密保存，内部版本为 3，写入使用 SQLite 事务合并，避免其他提供商的配置丢失。旧单配置和版本 2 的多提供商配置仍可读取，未包含 `provider` 时按 `custom` 处理；原模型和密钥保留，新增预置模型默认停用。首次保存或切换时升级结构，无需人工迁移。模型错误返回经过清理的中文说明和稳定的 `code`，不会返回服务商原始错误或密钥。

登录限速目前保存在单个服务进程的内存中，进程重启后会重置，也不会在多个进程之间共享；上线前需要根据实际部署方案补齐保护。本地验收使用的简单账号密码不适用于生产环境。

后端检查可运行 `pnpm typecheck`、`pnpm test` 和 `pnpm server:build`。测试包含真实临时 SQLite 和本地模拟模型服务；PostgreSQL、MySQL 与真实模型仍需在各自环境中验收。

## 原始前端模板说明

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

---

## Registry 组件安装（Windows 路径修复）

### 背景

`@shadcn/registry@0.2.1` 的 `resolveNestedFilePath()` 只按 `/` 拆分目标目录。

在 Windows 上，目标目录类似 `C:\Projects\shuriva\src\components`，按 `/` split 后无法匹配目录段，函数会退化为只取文件 basename，导致嵌套 registry 文件被拍平：

```text
components/assistant-ui/elements/thread.aui.tsx
-> src/components/thread.aui.tsx        （错误）
```

正确结果应为：

```text
src/components/assistant-ui/elements/thread.aui.tsx
```

本项目通过 pnpm patch 修复了该问题：

- 补丁文件：`patches/@shadcn__registry@0.2.1.patch`
- 配置位置：`pnpm-workspace.yaml` 的 `patchedDependencies`
- 锁文件：`pnpm-lock.yaml` 中记录了 patch hash

执行 `pnpm install` 会自动应用补丁。补丁只对**本地安装的 `shadcn` CLI** 生效。

### 安装 assistant-ui 组件

assistant-ui 自己的 CLI 会通过 dlx 下载 `shadcn@latest`，不会使用本项目的补丁，因此优先使用项目脚本：

```bash
# 安装组件及其依赖
node scripts/install-registry.mjs thread

# 直接指定 registry URL
node scripts/install-registry.mjs https://r.assistant-ui.com/base/thread.json

# 只查看文件将落到哪里，不安装、不修改文件
node scripts/install-registry.mjs thread --dry-run
```

脚本会：

1. 调用本地 `shadcn add`，保留 Base UI 转换、依赖安装和 registry 解析；
2. 按 registry 中声明的 `files[].path` 把文件归位；
3. 修正 shadcn 改写过的、指向拍平位置的 import。

也可以直接使用本地（已打补丁的）CLI：

```bash
pnpm exec shadcn add https://r.assistant-ui.com/base/thread.json
```

常用参数：

| 参数              | 作用                                |
| ----------------- | ----------------------------------- |
| `--dry-run`       | 只打印安装计划，不执行              |
| `--skip-cli`      | 不运行 shadcn，只归位已经写出的文件 |
| `--overwrite`     | 传递 `--overwrite` 给 shadcn CLI    |
| `--keep-existing` | 目标文件已存在时保留原文件          |
| `--root <dir>`    | 指定项目根目录                      |

### 升级 `@shadcn/registry` 后

补丁绑定 `@shadcn/registry@0.2.1`。如果依赖升级，需要重新生成补丁：

```bash
pnpm patch @shadcn/registry@<version>
```

然后编辑输出目录中的 `dist/chunk-*.js`。实现是压缩过的，搜索 `o.slice(l+1).join("/")` 即可找到 `resolveNestedFilePath` 对应函数，确保在拆分目标目录之前把反斜杠归一化：

```js
n = r.replace(/\\/g, "/").replace(/^\/|\/$/g, "");
```

最后提交补丁：

```bash
pnpm patch-commit <patch-dir>
```

升级后至少验证一次：

```bash
node scripts/install-registry.mjs thread --dry-run
```

### 不要删除

- `patches/@shadcn__registry@0.2.1.patch`
- `scripts/install-registry.mjs`
- `pnpm-workspace.yaml` 中的 `patchedDependencies`

否则 Windows 上安装嵌套的 assistant-ui registry 组件时，文件会再次被写入错误目录。

## React Compiler

The React Compiler is enabled on this template. See [this documentation](https://react.dev/learn/react-compiler) for more information.

Note: This will impact Vite dev & build performances.
You can also try [the experimental native React Compiler support in plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/README.md#rust-react-compiler) by using `compiler: true` in the plugin options instead of using the Babel plugin.

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
