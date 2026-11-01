import { Button, InfoDialog } from "@workspace/ui";
import "./foundation.css";
import "./prototype.css";
import {
  ChevronDown,
  ChevronRight,
  Database,
  History,
  LockKeyhole,
  MessageSquare,
  PanelLeft,
  Plus,
  Settings,
  Sparkles,
  Table2,
} from "lucide-react";
import { useState } from "react";

type ResultView = "table" | "chart" | "sql";
type Detail = "source" | "write" | null;

const rows = [
  ["2026 年 01 月", "1,284", "¥ 286,420.00", "—"],
  ["2026 年 02 月", "1,396", "¥ 312,680.00", "↗ 9.2%"],
  ["2026 年 03 月", "1,528", "¥ 348,520.00", "↗ 11.5%"],
  ["2026 年 04 月", "1,462", "¥ 331,840.00", "↘ 4.8%"],
  ["2026 年 05 月", "1,683", "¥ 389,760.00", "↗ 17.5%"],
  ["2026 年 06 月", "1,846", "¥ 425,380.00", "↗ 9.1%"],
];

const sql = `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month,
       COUNT(*) AS order_count,
       SUM(total_amount) AS order_amount
FROM orders
WHERE created_at >= ? AND created_at < ?
GROUP BY month
ORDER BY month;`;

function Sidebar({
  open,
  onSource,
  workspaceName,
  userName,
}: {
  open: boolean;
  onSource: () => void;
  workspaceName: string;
  userName: string;
}) {
  return (
    <aside className={`sidebar${open ? " open" : ""}`} aria-label="工作区导航">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </span>
        <span className="brand-name">
          AI <span>Workspace</span>
          <small>DATABASE WORKSPACE</small>
        </span>
        <span className="brand-tag">演示</span>
      </div>
      <div className="workspace-switch">
        <span className="workspace-avatar">D</span>
        <span className="workspace-copy">
          <strong>{workspaceName}</strong>
          <small>当前工作空间</small>
        </span>
      </div>
      <div className="sidebar-scroll">
        <div className="section-label">工作空间</div>
        <Button className="nav-item active" aria-current="page">
          <MessageSquare />
          AI 工作台
        </Button>
        <Button className="nav-item" onClick={onSource}>
          <Database />
          数据源<span className="nav-count">演示</span>
        </Button>
        <Button className="nav-item" disabled>
          <History />
          查询历史<span className="soon">待开发</span>
        </Button>
        <div className="section-head">
          <span className="section-label">数据结构 · 示例</span>
        </div>
        <div className="tree-root">
          <span className="db-mini">
            <Database />
          </span>
          business_db
        </div>
        <div className="tree-group">
          表<span className="tree-total">4</span>
        </div>
        {[
          ["orders", "订单"],
          ["customers", "客户"],
          ["products", "商品"],
          ["order_items", "订单明细"],
        ].map(([name, label]) => (
          <div className="tree-item" key={name}>
            <Table2 />
            {name}
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className="sidebar-bottom">
        <Button className="nav-item" disabled>
          <Settings />
          设置<span className="soon">待开发</span>
        </Button>
        <div className="profile">
          <span className="profile-avatar">示</span>
          <div>
            <strong>{userName}</strong>
            <small>已登录</small>
          </div>
        </div>
      </div>
    </aside>
  );
}

function ResultCard() {
  const [view, setView] = useState<ResultView>("table");
  const choices: { id: ResultView; title: string }[] = [
    { id: "table", title: "数据表格" },
    { id: "chart", title: "趋势图表" },
    { id: "sql", title: "查看 SQL" },
  ];
  return (
    <section className="result-card" aria-label="示例查询结果">
      <div className="result-head">
        <div>
          <div className="result-title">
            <span className="result-icon">
              <Table2 />
            </span>
            <strong>近六个月订单趋势</strong>
            <span className="done-badge">示例结果</span>
          </div>
          <div className="result-subtitle">
            数据来源 <b>business_db</b>
            <span>·</span> 2026 年 1 月 — 6 月
          </div>
        </div>
      </div>
      <section className="result-tabs" aria-label="结果展示方式">
        {choices.map((choice) => (
          <Button
            key={choice.id}
            aria-pressed={view === choice.id}
            onClick={() => setView(choice.id)}
          >
            {choice.title}
          </Button>
        ))}
      </section>
      {view === "table" && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>月份</th>
                <th className="number">订单数量</th>
                <th className="number">订单金额</th>
                <th className="number">环比变化</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([month, count, amount, change]) => (
                <tr key={month}>
                  <td>{month}</td>
                  <td className="number">{count}</td>
                  <td className="number">{amount}</td>
                  <td className="number">
                    <span className={change.startsWith("↘") ? "trend down" : "trend"}>
                      {change}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view === "chart" && (
        <div className="chart-panel">
          <div className="chart-title">
            <div>
              <strong>订单金额变化</strong>
              <small>单位：人民币元 · 演示数据</small>
            </div>
            <span className="legend">
              <i />
              订单金额
            </span>
          </div>
          <div className="bars" role="img" aria-label="示例图表：订单金额从一月到六月总体上升">
            {[57, 63, 71, 67, 80, 90].map((height, index) => (
              <div key={height}>
                <span style={{ height: `${height}%` }} />
                <small>{index + 1} 月</small>
              </div>
            ))}
          </div>
        </div>
      )}
      {view === "sql" && (
        <div className="sql-panel">
          <div className="sql-head">MySQL · 示例 SQL</div>
          <pre>{sql}</pre>
        </div>
      )}
      <div className="result-footer">
        <span>
          虚构的演示数据<i>·</i>6 行结果
        </span>
        <span>
          <LockKeyhole /> 只读展示
        </span>
      </div>
    </section>
  );
}

function ContextPanel({ onSource }: { onSource: () => void }) {
  return (
    <aside className="context-panel" aria-label="当前上下文">
      <div className="context-heading">
        <div>
          <span className="eyebrow">CONTEXT</span>
          <h2>当前上下文</h2>
        </div>
      </div>
      <div className="context-card">
        <div className="context-label">
          示例数据源<span className="status-pill">未连接</span>
        </div>
        <div className="context-source">
          <span className="mysql-mark">My</span>
          <span>
            <strong>business_db</strong>
            <small>MySQL · 示例</small>
          </span>
        </div>
        <div className="context-info-row">
          <span>访问权限</span>
          <b>
            <LockKeyhole /> 默认只读
          </b>
        </div>
        <div className="context-info-row">
          <span>结构状态</span>
          <b>示例结构</b>
        </div>
        <Button className="outline-button" onClick={onSource}>
          查看数据源 <ChevronRight />
        </Button>
      </div>
      <div className="context-section">
        <div className="context-title">
          <h3>相关数据表</h3>
          <span>示例</span>
        </div>
        <div className="context-table">
          <span className="table-icon">
            <Table2 />
          </span>
          <span>
            <strong>orders</strong>
            <small>订单信息</small>
          </span>
        </div>
        <div className="context-table">
          <span className="table-icon">
            <Table2 />
          </span>
          <span>
            <strong>order_items</strong>
            <small>订单明细</small>
          </span>
        </div>
      </div>
      <div className="tip-card">
        <span className="tip-icon">✧</span>
        <div>
          <strong>你掌控每一次查询</strong>
          <p>查看生成的 SQL 与数据来源，了解答案是如何得到的。</p>
        </div>
      </div>
    </aside>
  );
}

export function Demo({
  workspaceName,
  userName,
  onManage,
}: {
  workspaceName: string;
  userName: string;
  onManage: () => void;
}) {
  const [detail, setDetail] = useState<Detail>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="app-shell">
      <Sidebar
        workspaceName={workspaceName}
        userName={userName}
        open={sidebarOpen}
        onSource={() => {
          setDetail("source");
          setSidebarOpen(false);
        }}
      />
      <main className="main">
        <header className="topbar">
          <Button
            className="icon-button mobile-menu"
            aria-label="切换导航"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <PanelLeft />
          </Button>
          <div className="breadcrumbs">
            <button type="button" className="workspace-back" onClick={onManage}>
              {workspaceName}
            </button>
            <ChevronRight />
            <strong>AI 工作台</strong>
          </div>
          <div className="top-actions">
            <span className="demo-badge">
              <span />
              演示原型
            </span>
            <Button className="top-source" onClick={() => setDetail("source")}>
              business_db <span className="source-type">MySQL · 示例</span>
              <ChevronDown />
            </Button>
            <span className="top-avatar">示</span>
          </div>
        </header>
        <div className="prototype-bar">
          <span>✦</span> 这是界面演示，未连接数据库或模型，查询与修改功能尚未开放。
        </div>
        <div className="content-layout">
          <section className="conversation" aria-label="AI 对话工作台">
            <div className="page-heading">
              <div>
                <div className="eyebrow">
                  <span /> AI DATA WORKSPACE
                </div>
                <h1>
                  让数据，回答你的问题<span className="heading-dot">.</span>
                </h1>
                <p>用自然语言探索数据，从一个问题开始。</p>
              </div>
              <Button className="light-button" disabled>
                <Plus />
                新建对话
              </Button>
            </div>
            <div className="chat-thread">
              <div className="date-divider">示例对话</div>
              <div className="message-row user-row">
                <div className="user-message">
                  分析近六个月的订单趋势，看看每月订单金额和订单数。
                </div>
                <span className="message-avatar user-avatar">示</span>
              </div>
              <div className="message-row">
                <span className="message-avatar assistant-avatar">
                  <Sparkles />
                </span>
                <div className="assistant-content">
                  <div className="assistant-name">
                    数据助手 <span>·</span>
                    <small>演示内容</small>
                  </div>
                  <p>以下展示一组虚构的订单趋势，用于评审界面和交互。</p>
                  <p>可以切换数据表格、图表和 SQL 预览：</p>
                  <ResultCard />
                  <div className="insight">
                    <span className="insight-icon">✦</span>
                    <div>
                      <strong>发现一点趋势</strong>
                      <p>
                        6 月订单金额较 1 月增长 <b>48.5%</b>，可以进一步分析增长的主要来源。
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="composer-area">
              <div className="suggestions">
                <span>体验交互</span>
                <Button onClick={() => setDetail("source")}>查看数据源 ↗</Button>
                <Button onClick={() => setDetail("write")}>预览数据修改 ↗</Button>
              </div>
              <div className="composer">
                <label className="sr-only" htmlFor="chat-input">
                  输入你的数据问题
                </label>
                <textarea id="chat-input" disabled placeholder="AI 对话将在模型连接完成后开放" />
                <div className="composer-bottom">
                  <div>
                    <span className="composer-model">
                      <Sparkles /> 数据助手
                    </span>
                    <span className="composer-divider" />
                    <span>演示模式</span>
                  </div>
                  <Button className="send-button" disabled aria-label="发送问题（暂未开放）">
                    <Sparkles />
                  </Button>
                </div>
              </div>
              <p className="composer-note">
                <LockKeyhole /> 默认只读 · 此页面内容均为演示
              </p>
            </div>
          </section>
          <ContextPanel onSource={() => setDetail("source")} />
        </div>
      </main>
      <InfoDialog
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
        title={detail === "source" ? "数据源详情" : "预览数据修改"}
      >
        {detail === "source" ? (
          <>
            <p>这里展示数据源配置方式。当前使用虚构的示例数据，没有连接数据库。</p>
            <div className="dialog-row">
              <span>数据源</span>
              <strong>business_db · 示例</strong>
            </div>
            <div className="dialog-row">
              <span>类型</span>
              <strong>MySQL · 示例</strong>
            </div>
            <div className="dialog-row">
              <span>状态</span>
              <strong>未连接</strong>
            </div>
            <div className="dialog-note">配置、连接测试和凭证管理将在后续实现。</div>
          </>
        ) : (
          <>
            <p>数据修改需要独立授权、预览和明确确认。</p>
            <div className="dialog-row">
              <span>目标数据源</span>
              <strong>business_db · 示例</strong>
            </div>
            <div className="dialog-row">
              <span>目标数据表</span>
              <strong>orders</strong>
            </div>
            <div className="dialog-row">
              <span>预计影响</span>
              <strong>3 条虚构记录</strong>
            </div>
            <div className="dialog-note warning">
              写入功能目前未开放；此窗口仅展示未来的交互方式。
            </div>
          </>
        )}
      </InfoDialog>
    </div>
  );
}
