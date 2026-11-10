# Shuriva Design System

> 版本：v0.4（Token 层已实施）
>
> 状态：**Token 层已落地；页面级视觉收敛仍在进行。**
>
> 实施位置：`src/index.css` 的 `:root` 与 `@theme inline`。
>
> 基线：[`DESIGN-BASELINE.md`](./DESIGN-BASELINE.md)
>
> 审查：[`DESIGN-AUDIT.md`](./DESIGN-AUDIT.md)
>
> 信息架构：[`APP-IA.md`](./APP-IA.md)
>
> 技术栈：React 19 + React Compiler + TypeScript + Vite 8 + Tailwind CSS 4 + shadcn/ui + Base UI。

## 0. 实施状态（2026-11-09）

已实施：

- 浅色颜色系统：canvas `#F8FAFB`、surface `#FFFFFF`、sidebar `#F4F7F8`、正文 `#233641`、次级正文 `#556976`、muted `#61727F`。
- 品牌主色 `#0F766E`，悬停 `#0B655E`，当前选择 `#E7F2EF` / `#0B655E`，焦点环 `#15958A`。
- shadcn 语义变量已映射到上述色板；新增 `--primary-hover`，避免主按钮悬停时降低文字对比度。
- 语义状态 Token：success / warning / info / destructive 的正文、浅底和边框色。
- 图表色板与侧栏色板。
- 阴影统一为带前景色相的低透明度投影；圆角统一为 6 / 8 / 10 / 12。
- `Notice`、数据源状态徽标、数据源标识与来源 Chip 已改用语义 Token。

尚未完成：

- 部分页面仍在直接使用 Tailwind 的 emerald / amber / sky 色阶，需逐步迁移到语义 Token。
- 页面级字号、间距、留白和装饰细节的收敛。
- 深色主题未纳入当前产品范围；`.dark` 仍为 shadcn 默认值，应用未启用主题切换。

---

## 1. 设计系统目标

Shuriva 不是通用低代码平台，也不是营销站点。设计系统服务于一件事：

> **让用户连接数据库后，快速生成并长期使用一个可信、清晰、可操作的业务工作台。**

因此设计系统优先级固定为：

1. 真实业务问题优先于视觉表现。
2. 数据可读性优先于装饰。
3. 状态可信优先于动效。
4. 一致性和可维护性优先于局部精致。
5. 明确的安全边界优先于"看起来强大"。

### 1.1 与 UI v0.2 的关系

保留：

- 青绿色主色 `#0F766E`。
- 现有字体家族方向。
- 侧栏 + 顶栏 + 内容区的应用外壳。
- 工作台主 / 右双栏、编辑器左配置 / 右预览。
- 高信息密度、数据优先、克制专业。
- shadcn/ui + Base UI，不引入第二套组件库。
- Community / Cloud 的功能边界表达。

治理：

- 8–28px 的失控字号。
- 280 个一次性颜色。
- 3–13px 的随机圆角。
- 1–35px 的随机间距。
- 低对比度文字与边框。
- 缺少 ARIA 状态、焦点管理和字段级错误。
- 原型与 React 脚手架之间的字体 / Token 分裂。

不改变：

- 页面信息架构。
- 主要交互流程。
- AI 只生成受控配置、不执行任意 HTML / JS / SQL 的约束。
- Mock 与真实能力的区分。

---

## 2. 设计原则

### 2.1 数据优先

- 表格、指标、筛选是主体；装饰性元素让位。
- 数字使用等宽数字（`tabular-nums`），金额右对齐。
- 一屏内优先回答"发生了什么、影响多少、下一步做什么"。
- 不用大色块、插画或渐变抢占数据注意力。

### 2.2 克制

- 主色只用于主操作、当前状态、关键数据。
- 不用发光、玻璃拟态、装饰性渐变。
- 阴影只用于层级，不用于装饰。
- 动效只解释状态变化，不制造表演。

### 2.3 高密度但可读

- 密度通过布局、列宽、渐进披露实现，不通过 8–10px 文字。
- 表格正文 13px，正文 14px，元信息 11px 下限。
- 一屏信息量可以高，但每一条必须可读、可点、可聚焦。

### 2.4 状态诚实

- 加载、空、错误、离线、权限拒绝、部分失败必须分别表达。
- 刷新、保存、导出不能只靠 Toast。
- Mock 必须标注 Mock；模拟成功不能写成真实成功。
- 不允许用前端隐藏字段代替权限控制。

### 2.5 可访问是默认

- 对比度、键盘、焦点、标签、触控目标不是"优化项"。
- 状态不能只靠颜色。
- 动态结果要可播报。
- 表单错误要贴近字段。

---

## 3. 颜色系统

### 3.1 核心色

> 主色保持不变：`#0F766E`。以下为建议 Token，需在实施阶段落地。

| Token | 建议值 | 用途 | 对比度备注 |
| --- | --- | --- | --- |
| `--color-canvas` | `#F8FAFB` | 页面背景 | — |
| `--color-sidebar` | `#F4F7F8` | 左侧栏 | — |
| `--color-surface` | `#FFFFFF` | 卡片、输入、弹窗 | — |
| `--color-surface-subtle` | `#F9FBFC` | 表头、只读区块 | — |
| `--color-surface-hover` | `#F1F6F4` | 行 / 卡片 hover | — |
| `--color-text` | `#233641` | 主文字 | 12.53:1 on white |
| `--color-text-secondary` | `#556976` | 次级正文、按钮文字 | 5.72:1 on white |
| `--color-text-muted` | `#61727F` | 说明、元信息 | 4.97:1 on white / 4.75:1 on canvas |
| `--color-text-placeholder` | `#647684` | 占位符 | 4.70:1 on white |
| `--color-text-disabled` | `#8A99A4` | 禁用文字 | 禁用态可豁免，但不低于此值 |
| `--color-border-subtle` | `#E3E9ED` | 装饰性卡片边界、分隔线 | 1.22:1，仅装饰 |
| `--color-border-control` | `#80929F` | 输入、选择、复选框边界 | 3.22:1 on white / 3.07:1 on canvas |
| `--color-border-strong` | `#6F818E` | 强边界、表头下边 | 4.03:1 on white / 3.85:1 on canvas |
| `--color-primary` | `#0F766E` | 主色、主按钮、当前状态 | 5.47:1 on white |
| `--color-primary-hover` | `#0B655E` | 主按钮 hover | 6.91:1 on white |
| `--color-primary-active` | `#095B55` | 主按钮 pressed | 更高 |
| `--color-primary-soft` | `#E7F2EF` | 选中背景、主色浅底 | 主文字仍用 `#0F766E` |
| `--color-on-primary` | `#FFFFFF` | 主按钮文字 | 5.47:1 on primary |
| `--color-focus` | `#15958A` | 焦点轮廓 | 3.69:1 on white，满足非文字 3:1 |

### 3.2 语义色

| Token | 前景 | 背景 | 边界 | 用途 |
| --- | --- | --- | --- | --- |
| `success` | `#237E67` | `#EDF7F1` | `#CFE7DA` | 已连接、已保存、成功 |
| `warning` | `#84601F` | `#FFF8EB` | `#F0E0BE` | 未保存、待核查、注意 |
| `danger` | `#A84A48` | `#FFF2F0` | `#F2D7D4` | 离线、失败、删除 |
| `info` | `#466F8D` | `#EEF5FA` | `#D8E6F1` | 生产环境、说明 |
| `purple` | `#7A56A5` | `#F5F0FC` | `#E4D8F5` | 状态不一致、权限预览 |
| `neutral` | `#556976` | `#F3F6F8` | `#E3E9ED` | 普通徽标、未激活 |

对比度：`warning` 5.41:1、`danger` 5.14:1、`purple` 5.07:1、`info` 4.87:1、`success` 4.51:1（各自背景上）。徽标文字达到 AA 正文要求。

### 3.3 图表色

| Token | 值 | 说明 |
| --- | --- | --- |
| `--chart-1` | `#0F766E` | 主系列，延续品牌 |
| `--chart-2` | `#4177A3` | 第二系列 |
| `--chart-3` | `#7A56A5` | 第三系列 |
| `--chart-4` | `#84601F` | 第四系列 |
| `--chart-5` | `#A84A48` | 第五系列 |

规则：

- 不使用 `#81B4A8` / `#B4D3CA` 这类低对比浅绿作为数据填充。
- 颜色不能是唯一编码；同时使用直接标注、图例、形状或纹理。
- 图表必须提供可展开的数据表或等价文本摘要。
- 图表文字使用 `--color-text-secondary` 或更深，不使用 8px。

### 3.4 颜色使用规则

1. 组件中禁止写 raw hex，只使用语义 Token。
2. 主色面积克制：主按钮、当前导航、当前标签、关键状态。
3. 危险色只用于危险操作与失败，不用于普通强调。
4. 状态圆点必须配文字或可访问名称。
5. 装饰性边框可以使用 `border-subtle`；**输入框、复选框、焦点边界必须使用 `border-control` 或更深**。

---

## 4. 字体系统

### 4.1 字体家族

```css
--font-sans:
  Inter, -apple-system, BlinkMacSystemFont, "Segoe UI",
  "PingFang SC", "Microsoft YaHei", sans-serif;
--font-mono:
  ui-monospace, SFMono-Regular, Consolas, monospace;
```

**待确认决策：**

- 原型声明 `Inter`，但没有加载 webfont，实际依赖本机。
- React 脚手架使用 Geist Variable。
- 两者必须统一。

可选方案：

| 方案 | 说明 | 影响 |
| --- | --- | --- |
| A. 保留系统字体栈 | 去掉对 Inter 的隐式依赖，明确使用 `-apple-system / Segoe UI / PingFang SC / Microsoft YaHei` | 跨平台字宽仍有差异，但无新增依赖 |
| B. 显式加载 Inter | 统一个平台视觉，接近原型声明 | 需要新增字体依赖；需确认授权与体积 |
| C. 改用 Geist | 与 React 脚手架一致 | 会改变原型视觉基线，不推荐在未确认时采用 |

在确认前，设计文档保留现有字体家族，不擅自替换。

### 4.2 字号与行高

| Token | 字号 / 行高 | 字重 | 用途 |
| --- | --- | --- | --- |
| `text-display` | 28 / 36 | 650 | 首页主标题 |
| `text-h1` | 24 / 34 | 650 | 页面 H1 |
| `text-h2` | 18 / 26 | 600 | 分区标题 |
| `text-h3` | 15 / 22 | 600 | 卡片 / 模块标题 |
| `text-body` | 14 / 22 | 400 | 正文、描述 |
| `text-table` | 13 / 20 | 400 | 表格正文 |
| `text-label` | 12 / 18 | 500 | 表单标签、按钮、导航 |
| `text-caption` | 11 / 16 | 400 | 元信息、辅助说明 |
| `text-number` | 27 / 34 | 650 | 指标数字，`tabular-nums` |

规则：

- 功能性文字不低于 12px；表格正文 13px；元信息 11px 为绝对下限。
- 8–10px 只允许用于纯装饰或非必要标记，不能承载业务信息。
- 中文正文行高 1.55–1.65；表格 1.5。
- 标题字距：大标题 `-0.3px` 至 `-0.5px`，正文 0。
- 数字使用 `font-variant-numeric: tabular-nums`。
- 文本最大宽度约 72ch，避免超长行。

### 4.3 字体加载

- 若保留 Inter，必须显式加载并设置 `font-display: swap`，不能依赖本机安装。
- 中文 fallback 需要固定顺序，避免 Windows / macOS 字体差异导致表格列宽跳动。
- 字体确认后，将 `--font-sans` 写入 Tailwind `@theme` 与 shadcn 基础层，确保原型和 React 同源。

---

## 5. 间距、尺寸与布局

### 5.1 间距尺度

采用 4px 基础：

| Token | 值 | 用途 |
| --- | --- | --- |
| `space-1` | 4px | 图标与文字、紧凑内间距 |
| `space-2` | 8px | 控件内间距、按钮组 |
| `space-3` | 12px | 表格单元格、卡片内间距 |
| `space-4` | 16px | 卡片 padding、表单间距 |
| `space-5` | 20px | 模块间距、页面区块 |
| `space-6` | 24px | 页面内边距、弹窗 body |
| `space-8` | 32px | 页面外边距、大区块 |
| `space-10` | 40px | 首页顶部留白 |
| `space-12` | 48px | 大分区 |
| `space-16` | 64px | 保留，不常用 |

现有 1–35px 的零散值在迁移时映射到最近尺度；确有视觉必要的例外要命名并注明原因。

### 5.2 布局

| 项目 | 规范 |
| --- | --- |
| 侧栏 | 220px；编辑器 72px；移动端抽屉 220px |
| 顶栏 | 56px；移动端 52px |
| 内容最大宽度 | 1480px，居中 |
| 页面内边距 | 32px；≤1250px 24px；≤980px 20px；≤700px 16px |
| 工作台主 / 右列 | `minmax(0, 1fr) 260px`；≤1250px 225px；≤980px 单列 |
| 编辑器分栏 | 320px + 1fr；≤1250px 290px；≤980px 270px；≤700px 单栏切换 |
| 弹窗 | 560px；宽 690px；抽屉 485px |
| 表格行高 | 44px 最小；密集模式 40px |
| 表格分页 | 6 / 12 / 24 可选，默认 12 |
| 焦点偏移 | 2px 轮廓，3px offset |

### 5.3 断点

保留 v0.2 断点，避免结构突变：

| Token | 值 | 行为 |
| --- | --- | --- |
| `bp-wide` | 1750px | 宽屏内容上限、右列加宽 |
| `bp-lg` | 1250px | 工具栏换行、右列收窄 |
| `bp-md` | 980px | 侧栏收窄、工作台单列、编辑器缩窄 |
| `bp-sm` | 700px | 移动布局、侧栏抽屉、编辑器标签切换 |

移动端不是"隐藏内容"，而是重排：

- 指标：1×3 或 2+1，不删除。
- 表格：横向滚动 + 首列 sticky + 滚动提示；关键列优先。
- 数据源：表头折叠，改为两行卡片，但保留状态与使用情况摘要。
- 权限：策略表可横向滚动或改为字段卡片，不能压到 8px。
- 编辑器：对话 / 预览标签切换，保留当前草稿状态。

---

## 6. 圆角、边框与阴影

| Token | 值 | 用途 |
| --- | --- | --- |
| `radius-xs` | 4px | 徽标、小标签 |
| `radius-sm` | 6px | 按钮、输入、选择 |
| `radius-md` | 8px | 卡片、提示条、数据源行 |
| `radius-lg` | 10px | 主卡片、指标条 |
| `radius-xl` | 12px | 弹窗、抽屉 |
| `radius-full` | 999px | 头像、圆点 |

边框：

- 默认 1px。
- 装饰边界 `border-subtle`。
- 控件边界 `border-control`。
- 聚焦：2px `color-focus`，offset 3px；不要只改边框颜色。
- 输入错误：1px `danger` + 字段错误文本，不只用红色边框。

阴影：

| Token | 值 | 用途 |
| --- | --- | --- |
| `shadow-raised` | `0 1px 2px rgba(16,42,52,.06), 0 2px 8px rgba(16,42,52,.04)` | 首页创建区、浮层 |
| `shadow-dialog` | `0 16px 48px rgba(16,42,52,.18), 0 2px 8px rgba(16,42,52,.08)` | 弹窗、抽屉 |
| `shadow-toast` | `0 4px 20px rgba(16,42,52,.12)` | Toast |

不使用彩色阴影、发光阴影或大范围模糊。

---

## 7. 动效

| Token | 值 | 用途 |
| --- | --- | --- |
| `duration-fast` | 120ms | hover、focus、颜色 |
| `duration-base` | 160ms | 按钮、卡片、展开 |
| `duration-slow` | 220ms | 弹窗、抽屉 |
| `ease-standard` | `cubic-bezier(.2, 0, 0, 1)` | 标准 |
| `ease-out` | `cubic-bezier(0, 0, .2, 1)` | 进入 |

规则：

- 动效只解释状态变化，不做装饰性循环。
- 不动画 `width` / `height` 除非必要；优先 transform / opacity。
- 尊重 `prefers-reduced-motion: reduce`，关闭非必要动画。
- 生成中 spinner 可以旋转；其他元素不持续动画。

---

## 8. 组件规范

### 8.1 按钮

| 类型 | 用途 | 规范 |
| --- | --- | --- |
| Primary | 页面主操作 | 青绿底、白字；一屏尽量一个 |
| Secondary | 次要操作 | 白底、边框、深色文字 |
| Ghost | 工具栏、低权重 | 透明底，hover 浅底 |
| Text | 模块内动作 | 无边框，主色或次级色 |
| Danger | 删除、断开 | 红色文字 / 边界；必须确认 |
| Icon | 关闭、更多、行操作 | 必须有 `aria-label` 和 tooltip |

尺寸：

- 桌面默认 36px 高，紧凑 32px，超紧凑 28px。
- 移动端所有可点击按钮最小 44×44px。
- 图标按钮桌面 32×32，移动 44×44。
- 按钮组间距 ≥8px。

状态：

- hover、active、focus-visible、disabled、loading。
- loading 时保留宽度，显示 spinner + 文案，禁用重复提交。
- disabled 必须提供可见原因或 `aria-disabled` 解释，不能只靠 `title`。

### 8.2 输入框 / 选择 / 搜索

- 高度 36px；移动端 44px。
- 13px 文字，标签 12px。
- 必须有可见标签或视觉隐藏 `<label>`；placeholder 只作示例。
- 必填标记 + 说明。
- 错误：字段下文本 + `aria-invalid` + `aria-describedby`；提交后聚焦第一个错误。
- 选择框：保留原生 select 的可访问性，或使用 Base UI Select 并完整实现键盘 / ARIA。
- 搜索：有值时显示清除按钮；`/` 或 `Ctrl+K` 可作为可选快捷键。
- 搜索 / 筛选结果数量使用 `aria-live="polite"` 防抖播报。

### 8.3 徽标与状态

- 徽标 11px，4px 圆角，1px 边框。
- 状态 = 圆点 + 文案；圆点只作为辅助，不作为唯一编码。
- 连接状态：`连接可用` / `连接离线` / `连接中` / `权限不足`。
- 草稿状态：`未保存草稿` / `草稿已保存` / `保存中` / `保存失败`。
- 不使用纯色点表示数据源状态；至少提供 `aria-label` 或可见文字。

### 8.4 标签页与分段控件

- 使用 `role="tablist"` / `role="tab"` / `role="tabpanel"`。
- `aria-selected`、`aria-controls`、方向键切换。
- 分段筛选使用 `aria-pressed`，或使用 radio group。
- 选中态同时有背景、文字色和边框变化，不能只靠颜色。
- 移动端标签可横向滚动，但不能隐藏必要标签。

### 8.5 表格

**结构**

- 保留原生 `<table>` / `<thead>` / `<tbody>` / `<tr>` / `<th>` / `<td>`。
- 表头 `<th scope="col">`；数字列右对齐，`tabular-nums`。
- 最后一列放真实"查看"按钮，不把整行 `role` 改成 button。
- 若保留整行点击，作为鼠标增强，支持 Enter / Space，不破坏表格语义。

**密度**

- 表格正文 13px，表头 12px，辅助 11px。
- 行高最小 44px；密集模式 40px。
- 表头 sticky；横向滚动时首列 sticky。
- 移动端 `min-width` + 横向滚动，显示滚动渐隐提示。

**状态**

- loading：骨架行或保留旧数据 + `aria-busy`。
- empty：说明 + 清除筛选操作。
- error：模块内错误 + 重试。
- offline：来源离线说明 + 恢复入口。
- denied：权限说明，不显示空数据伪装。
- 结果数量变化：live region 播报。

**排序 / 分页**

- 表头可排序时显示方向图标和 `aria-sort`。
- 分页提供上一页 / 下一页 / 页码；可选 page size。
- 固定 6 条只作为原型基线，不作为设计规范。

### 8.6 弹窗与抽屉

- 使用原生 `<dialog>` 或 Base UI Dialog。
- `aria-labelledby` 指向标题；必要时 `aria-describedby`。
- 打开时聚焦标题或第一个可操作项；关闭后焦点返回触发元素。
- 背景点击关闭：仅用于短确认；长表单禁止背景关闭。
- Escape 与关闭按钮行为一致。
- 未保存表单关闭前确认。
- 弹窗宽度 560 / 690px；抽屉 485px。
- 移动端全宽，底部按钮保持可达。

### 8.7 Toast 与模块内反馈

- Toast 用于轻量、可消失的确认；不能作为唯一反馈。
- 容器 `aria-live="polite"`；错误可用 `assertive`。
- 成功 3–4s，错误 6s 或手动关闭。
- 刷新、保存、导出必须有模块内持久状态（按钮 busy、状态徽标、结果区域）。
- 部分失败必须说明哪个来源失败，不能一条"完成"覆盖。

### 8.8 空状态、错误状态、加载状态

| 状态 | 表达 | 操作 |
| --- | --- | --- |
| Loading | 骨架 / spinner + "正在读取…" | 可取消时提供停止 |
| Empty | 图标 + 标题 + 说明 | 清除筛选 / 创建 |
| Error | 错误图标 + 原因 + 影响范围 | 重试 |
| Offline | 来源离线说明 | 恢复连接 / 查看其他模块 |
| Denied | 锁图标 + 权限说明 | 联系管理员 / 返回 |
| Partial | 模块级提示 + 其他模块继续可用 | 重试失败模块 |

不允许：

- 用空状态伪装权限拒绝。
- 用 Toast 代替模块错误。
- 用旧数据冒充已刷新。
- 把 Mock 成功描述为真实连接成功。

### 8.9 AI 编辑器

保留 v0.2 的成熟交互：

- 明确"模拟响应"。
- 草稿 / 已保存状态。
- 修改先进入草稿，保存后才影响正式界面。
- 放弃修改确认。
- 生成中可以停止。
- 保存中禁用重复提交。
- `Ctrl/Cmd + Enter` 发送，避免中文输入法误发。
- 变更清单说明影响模块。
- AI 不改变数据权限、不执行数据库写入。

补充：

- 生成失败、空结果、超时要有独立状态。
- 预览区标注"草稿预览"，不伪装成正式版本。
- 保存失败保留草稿，提供重试。
- 生成中的变更清单不能提前显示为已完成。

### 8.10 数据源管理

- 每个来源独立状态、独立错误、独立使用情况。
- 添加向导三步保持不变：类型 → 连接 → 访问范围。
- 测试连接成功后，只有连接参数变化才重置结果；其他字段变化显示"配置已变更，需要重新测试"。
- 密码字段：仅演示；不写入本地存储；正式版由后端保存。
- 只读标识、环境标签、模拟状态必须保留。
- 删除 / 编辑被工作台引用的来源时，说明影响范围与阻断原因。

### 8.11 权限控件

- 字段权限：原文可见 / 脱敏可见 / 不可访问。
- 记录范围：全部授权 / 本人负责 / 所属门店。
- 操作权限：查询 / 导出 / 创建工作台 / 编辑 / 分享 / 写入。
- AI 敏感字段授权独立开关。
- 所有权限说明必须强调：前端不是安全边界，正式权限由可信后端执行。
- 权限变更未保存时，切换角色 / 页面要确认。
- 预览结果必须标注"模拟成员视角"。

---

## 9. 状态模型

所有数据界面使用同一套状态枚举：

```ts
type ViewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success' }
  | { status: 'empty'; reason: 'no-data' | 'no-match' }
  | { status: 'error'; message: string; retryable: boolean }
  | { status: 'offline'; sourceId: string }
  | { status: 'denied'; reason: string }
  | { status: 'partial'; failedSourceIds: string[] }
```

| 界面 | 必须覆盖 |
| --- | --- |
| 页面 | loading、empty、error、offline、denied |
| 表格 | loading、empty、error、offline、denied、partial |
| 指标 | loading、partial、offline、denied |
| 表单 | idle、validating、invalid、submitting、success、error |
| AI 编辑器 | idle、generating、stopped、error、saved、unsaved |
| 导出 | idle、preparing、success、denied、error |
| 数据源 | connected、connecting、offline、error、denied |
| 权限 | saved、dirty、saving、error、preview |

规则：

- 状态不能只靠颜色或 Toast。
- 权限拒绝与空数据必须视觉和文案区分。
- 部分失败保留可用模块。
- 任何"完成"提示都必须对应当前请求，不能被旧请求覆盖。

---

## 10. 可访问性规范

### 10.1 对比度

- 正文 4.5:1。
- 大字（≥18.66px 粗体或 ≥24px）3:1。
- 图标、输入边界、焦点、图表 3:1。
- 禁用态可豁免，但不低于可用性底线。
- 不使用低对比浅绿作为图表唯一填充。

### 10.2 键盘与焦点

- 所有交互可用键盘完成。
- 焦点顺序符合视觉顺序。
- 焦点轮廓 2px，offset 3px，不能被 `overflow:hidden` 裁掉。
- 弹窗焦点约束并在关闭后返回触发元素。
- 移动导航打开时约束焦点，关闭后返回。
- 表格行操作使用真实按钮，不用 `role=button` 覆盖行。

### 10.3 标签与 ARIA

- 每个输入 / 选择 / 搜索都有可访问名称。
- 导航当前项 `aria-current="page"`。
- 标签页 `aria-selected`；分段 `aria-pressed`；步骤 `aria-current="step"`。
- 展开 / 收起 `aria-expanded` + `aria-controls`。
- 状态圆点配文字或 `aria-label`。
- 动态结果 `aria-live`，但避免每次按键都播报。
- 图表提供文本摘要或数据表。

### 10.4 触控与响应式

- 移动端点击目标 ≥44×44px。
- 相邻目标间距 ≥8px。
- 支持 200% 缩放和 320px 宽重排，不出现不可操作的横向裁切。
- 表格允许横向滚动，但关键操作始终可达。
- 不隐藏核心指标；移动端重排而非删除。

### 10.5 动效

- 尊重 `prefers-reduced-motion`。
- 不使用闪烁、快速循环或自动播放装饰。
- 加载动画不阻塞阅读。

---

## 11. 内容与命名

### 11.1 产品命名

- 品牌：待产品确认 **Shuriva** 或 **Stackoryn**；确认后全局统一。
- 代码、页面标题、可访问名称、CSV 前缀、存储键必须一致。
- 存储键变更需要迁移或明确重置。

### 11.2 术语

| 概念 | 推荐用词 | 避免 |
| --- | --- | --- |
| 工作台 | 工作台 | dashboard、看板混用 |
| 数据源 | 数据源 / 连接 | 来源（单独出现时含义模糊） |
| 模块绑定 | 模块来源 / 绑定 | 来源、关联混用 |
| 记录范围 | 记录范围 | 数据范围（易与数据源权限混淆） |
| 字段权限 | 字段访问 | 列权限（只描述表格） |
| Community | 开源版 / Community | 免费版（暗示商业分级） |
| Cloud | 团队版 / Cloud | 云版（连接方案未定，避免暗示架构） |

### 11.3 文案规则

- 操作命名 = 动词 + 对象，例如"查看数据来源""管理数据源""重置筛选"。
- 错误说明 = 发生了什么 + 影响什么 + 下一步。
- Mock 文案必须保留"模拟 / 示例 / 预览"。
- 不把"前端隐藏"描述为"权限控制"。
- 不把"模拟连接成功"描述为"数据库连接成功"。
- 不把"模拟 AI"描述为"模型执行"。

---

## 12. Community 与 Cloud 的边界

### 12.1 Community

- 单用户、单工作区、自部署。
- 支持多个数据库连接、多种数据库类型。
- 后端直连数据库，无需额外 Connector。
- 默认只读。
- 从不同设备访问同一部署实例。
- 导航不显示团队权限入口。
- 权限页显示独立介绍，不伪装成已启用。

### 12.2 Cloud

- 多组织、多成员、多工作区。
- 成员角色、用户组、字段权限、行级权限、审计。
- 数据源连接方案 **未最终确定**。
- UI 不得预设"必须使用独立 Connector""必须浏览器直连""必须托管密码"。
- 团队权限页是设计预览，必须标注"不是生产鉴权"。
- 共享工作台不自动授予数据源读取权。

### 12.3 共享组件

Community 与 Cloud 共用：

- 工作台渲染器。
- 查询描述协议。
- 数据源适配接口。
- 表格、筛选、指标、图表组件。
- 设计 Token。
- AI 编辑器。

差异只放在：

- 身份认证。
- 成员管理。
- 权限策略执行。
- 数据源连接实现。
- 部署配置。

不得复制两套核心业务 UI。

---

## 13. React / Tailwind / shadcn 落地映射

### 13.1 Token 层

在 `src/index.css` 中：

- 保留 Tailwind 4 `@theme`。
- 用 `@theme inline` 将语义变量映射为 `--color-*`。
- 将 shadcn 变量（`--background`、`--foreground`、`--primary`、`--border`、`--ring` 等）指向同一语义 Token。
- 清除当前默认灰阶 / 紫色 accent 残留。
- 字体变量统一。

示意（不是实施代码）：

```css
:root {
  --background: #f8fafb;
  --foreground: #233641;
  --primary: #0f766e;
  --primary-foreground: #ffffff;
  --border: #e3e9ed;
  --input: #80929f;
  --ring: #15958a;
  --muted-foreground: #61727f;
  --radius: 8px;
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-primary: var(--primary);
  --color-border: var(--border);
  --color-ring: var(--ring);
  /* ... */
}
```

### 13.2 组件层

| 原型 | React / shadcn | 备注 |
| --- | --- | --- |
| `.btn` | `Button` + CVA variants | 补齐 loading / aria-disabled |
| `input` / `select` | `Input` / `Select` | 使用 Label、FormMessage |
| 表格 | `Table` + TanStack Table | 保留语义；不要行 role=button |
| 弹窗 | `Dialog` / `Drawer` | 焦点返回、未保存确认 |
| 标签页 | `Tabs` | aria-selected / 键盘 |
| 徽标 | `Badge` | 语义色变体 |
| Toast | `sonner` | 仍保留模块内状态 |
| 空状态 | 业务组件 | 统一 EmptyState |
| 图表 | Recharts | 直接标签、数据表、可访问摘要 |
| 图标 | Lucide React | 统一尺寸与 `aria-hidden` |

### 13.3 工程约束

- React Compiler 已启用，不手动添加无意义 `useMemo` / `useCallback`。
- 业务逻辑与 UI 分离；查询、权限、状态不塞进展示组件。
- Mock 与真实服务分离，不在组件内写死真实数据。
- 不新增第二套 UI 库。
- 新增依赖前确认必要性；字体依赖需单独批准。
- 所有权限、SQL、数据访问仍由服务端执行；前端只表达状态。

---

## 14. 迁移计划

### 阶段 0：确认

- 品牌：Shuriva / Stackoryn。
- 字体：系统栈 / Inter / Geist。
- 移动指标：堆叠方案。
- 内容最大宽度：1480px。
- 是否本轮处理深色模式：建议不处理。

### 阶段 1：P0

- 品牌统一。
- 移动指标不隐藏。
- 数据源向导测试状态与字段错误。
- 刷新 busy / single-flight / aria-busy。

### 阶段 2：Token 与可读性

- 颜色、字体、字号、间距、圆角、阴影 Token。
- 替换 raw hex。
- 对比度修复。
- 字体来源统一。

### 阶段 3：组件与可访问性

- Button / Input / Select / Badge / Table / Dialog / Tabs。
- 字段级错误。
- 焦点返回。
- 44px 触控。
- ARIA 状态。
- 表格语义。

### 阶段 4：页面

- 首页。
- 工作台目录。
- 工作台。
- 编辑器。
- 数据源。
- 权限。
- 设置。

每页只做规范落地，不改变信息架构。

### 阶段 5：验收

- Oxlint。
- TypeScript typecheck。
- Vite build。
- 单元测试（如已有）。
- Playwright 回归。
- 键盘 / 屏幕阅读器抽查。
- 对比度抽查。
- 200% 缩放 / 320px 重排。
- Mock 与真实能力文案复核。

---

## 15. 验收清单

### 视觉

- [ ] 主色仍为 `#0F766E`，没有渐变 / 发光。
- [ ] 同类组件字号、圆角、间距来自 Token。
- [ ] 页面最大宽度一致。
- [ ] 表格 13px，正文 14px，元信息 ≥11px。
- [ ] 文字、图标、边框对比度达标。

### 交互

- [ ] 刷新有 busy / disabled / aria-busy。
- [ ] 数据源测试状态不会被静默清空。
- [ ] 表单错误在字段旁并有 aria 关联。
- [ ] 弹窗关闭后焦点返回。
- [ ] 标签页 / 导航 / 分段有 ARIA 状态。
- [ ] 表格保留语义，行操作是真实按钮。
- [ ] 移动端指标不丢失。
- [ ] 触控目标 ≥44px。

### 状态

- [ ] loading / empty / error / offline / denied / partial 均有表达。
- [ ] 权限拒绝不伪装成空数据。
- [ ] 部分失败保留其他模块。
- [ ] Toast 不是唯一反馈。
- [ ] Mock 标识保留。

### 安全与产品边界

- [ ] 不把前端隐藏当权限。
- [ ] 不把 Mock 当真实连接 / 模型。
- [ ] Community 单用户、多数据源、后端直连表达不变。
- [ ] Cloud 连接方案仍标注"待定"。
- [ ] AI 不执行任意 HTML / JS / SQL。
- [ ] 数据库凭证不进入浏览器存储 / 日志。

---

## 16. 待确认决策

| 编号 | 决策 | 当前建议 | 影响 |
| --- | --- | --- | --- |
| D-01 | 品牌名 Stackoryn / Shuriva | 由产品确认；确认后全局统一 | P0 |
| D-02 | 字体系统栈 / Inter / Geist | 保留现有方向，先统一来源；不擅自换家族 | P1 |
| D-03 | 移动端指标 | 1×3 或 2+1，不隐藏 | P0 |
| D-04 | 内容最大宽度 | 统一 1480px | P2 |
| D-05 | 深色模式 | 本轮不做，预留 Token | P2 |
| D-06 | Cloud 连接方案 | 继续待定，不预设 Connector / 直连 / 托管密码 | 产品边界 |
| D-07 | 优化阶段范围 | 先 P0 + Token + 可访问性，不做整站重绘 | 计划 |

---

## 17. 结论

Shuriva 的设计系统不需要另起一套视觉语言。它需要把 v0.2 已经成立的方向**收敛成可执行、可访问、可维护的规则**：

- 青绿色继续作为品牌锚点。
- 高密度继续保留，但用 13–14px 正文和 44px 行高支撑。
- 表格、筛选、指标、编辑器继续是产品主体。
- 状态、权限、Mock 边界必须比现在更清楚。
- Token、字体、组件、React 实现必须有单一来源。

在品牌、字体和移动指标三个决策确认前，不进入页面优化实施。
