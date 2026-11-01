# 原生 Review 执行说明

本文说明如何真正启动 Codex 原生审查。按实际能力选择入口，不要求桌面/IDE 用户在可用 CLI 存在时重复手动操作。

## 0. 先确定范围，再选择能力

1. 检查 `git status --short` 与 `git rev-parse --verify HEAD`，对照任务开始时的记录，确定本次差异及已有修改。正常使用提交、任务分支或明确的未提交差异；基准分支不能包含无关任务，新增/未跟踪文件也不能漏审。
2. 有首次提交后直接使用正常 Git 流程；尚无首次提交仅报告当前限制，不自动建提交，不引入快照、双轨或永久特殊流程。首次提交与代码上传分别由用户任务授权。
3. 检查当前实际可调用的原生 Review 工具；只有实际启动审查的接口才算入口，打开 review 面板不等于执行。
4. 无可用工具时，若允许终端执行，检查 `codex --version` 与 `codex review --help`，选择只读 CLI；不假定安装、登录、模型调用或执行权限已经可用。帮助命令成功只证明入口存在。
5. 以上都不可用才提示对应客户端人工 `/review`。保留降级自查及未完成说明；不要每轮重复尝试同一已确认不可用的入口。

`--uncommitted` 会包含暂存、未暂存及未跟踪文件，不能用来自动区分本轮任务。同一文件混有其他修改时，先明确差异；入口支持自定义指令时可声明只审查哪些文件/变更并报告限制，但提示词限定不等同工具强制隔离。无法可靠限定时说明限制，只在确实需要用户决定是否扩大范围时询问。不得先全量调用，再过滤发现来冒充限定审查。

## 1. ChatGPT 桌面版（Codex 模式）

1. 确认当前会话打开的是本地 Git 项目。
2. 在 Codex Composer 输入 `/review`。
3. 从命令菜单选择：
   - `Review uncommitted changes`：审查暂存、未暂存及未跟踪改动。
   - `Review against a base branch`：与指定基准分支比较。
4. 查看 Review pane / 审查结果中的优先级问题。
5. 核对结果对应的范围和版本，与启动前已确认的任务差异一致。

注意：
- `/review` 是 Composer 的原生命令，不是 Shell 命令。
- `AGENTS.md` 或 Skill 里的文字指令本身不能替 Agent 点击 Composer 菜单。
- 若 Agent 没有可调用的原生工具或已验证 CLI，用户可在 Composer 执行上述步骤；Agent 不得声称已经自动执行。
- 项目必须位于 Git 仓库中，桌面端才能使用本地变更 Review。

## 2. VS Code / Cursor 中的 Codex 扩展

1. 在 Codex 扩展的 Composer 中输入 `/review`。
2. 选择审查未提交改动或与基准分支比较。
3. 检查行内评论和优先级结果。
4. 核对实际报告范围，发现范围偏差就标记限制，不把无关结果归入本任务。

注意：必须是在 Codex 扩展自己的 Composer 中执行，不是 VS Code/Cursor 的普通终端输入 `/review`。

## 3. Codex CLI 交互模式

在项目目录启动 `codex`，然后输入 `/review`，按菜单选择审查目标。

## 4. Codex CLI 非交互模式

先按第 0 节确认能力、范围与项目约束。CLI 从正确的项目目录运行，执行权限不得高于当前任务；下列命令显式采用只读模式，且不自动请求提权。先检查本机版本是否接受这些参数：

```bash
codex --sandbox read-only --ask-for-approval never review --help
```

审查所有未提交改动：

```bash
codex --sandbox read-only --ask-for-approval never review --uncommitted
```

审查相对于基准分支的改动：

```bash
codex --sandbox read-only --ask-for-approval never review --base BRANCH_NAME
```

审查指定提交：

```bash
codex --sandbox read-only --ask-for-approval never review --commit COMMIT_SHA
```

先将 `BRANCH_NAME` 或 `COMMIT_SHA` 替换为已核实的真实目标。目标选项互斥；自定义 `PROMPT` 也不能与 `--uncommitted`、`--base`、`--commit` 拼用。需要自定义审查时可在本机版本支持的情况下用 `codex --sandbox read-only --ask-for-approval never review -` 从标准输入传入指令，不再加这些目标选项；在指令中明示目标及约束，不放凭据。不要发明路径过滤参数。参数以本机 `--help` 及官方文档为准。

重要范围限制：
- `--uncommitted` 包括 staged、unstaged 和 untracked 改动，不保证只包含当前 AI 任务。
- 如果有用户原有未提交改动，先选择能准确覆盖本轮的 base/commit 或明确自定义范围；确实无法区分才请用户决定，不重复确认已经清楚的授权。
- 不要擅自 stash、reset、checkout、commit 或改写用户工作区来“清理”审查范围。
- 保持项目和当前用户约束，不传入原数据库 URL/密码，不在 reviewer 内执行数据库集成测试或服务操作；必要测试由主任务按已有隔离流程完成。
- 等待实际审查完成并收集结果；进程启动、帮助成功、面板打开或命令退出均不能单独证明“审查通过”。中断/超时应记未完成。若实质代码已改变，旧结果不能作为新版本结论。

## 5. 自动化边界

### 可以自动化的部分
- 由项目 `AGENTS.md` 要求任务交付前审查。
- 由 Skill 判断风险并选择客户端执行步骤。
- 在有已验证只读 CLI 能力的环境中，Agent 可执行 `codex review` 命令，不限定必须运行在 CLI 客户端内。
- 审查后自动核实问题、运行测试、按授权修复。

### 不能仅靠 Skill 保证的部分
- Skill/AGENTS 指令不能直接点击桌面 Composer 的 `/review` 菜单。
- 不能假设所有桌面版/IDE 会话都暴露可由 Agent 调用的 Review API。
- 不能因为 Agent 在回复中写了“已调用 `/review`”就视为命令执行成功。
- 不应在没有验证的情况下安装 Stop Hook 或启动嵌套 Codex 进程；这可能造成重复调用、递归或审查范围扩大。

只读 reviewer 不再调用本技能启动子审查；主任务负责核实发现、按授权修复与受影响路径复查。Claude Code 可读取同一技能，提供任务差异和验证记录，并按这里的实际能力调用 Codex；执行失败则保留真实状态，不把自身分析称为 Codex Review。

参考：[官方代码审查说明](https://learn.chatgpt.com/docs/code-review)、[官方命令说明](https://learn.chatgpt.com/docs/developer-commands?surface=cli)。当客户端行为与示例不符时先检查版本和入口，不通过更改用户全局配置绕过。
