import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  location: dom.window.location,
  history: dom.window.history,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const loader = await createServer({
  configFile: false,
  esbuild: { jsx: "automatic" },
  server: { middlewareMode: true, watch: null, hmr: false },
  optimizeDeps: { noDiscovery: true, entries: [], include: [] },
  appType: "custom",
});
const { App } = await loader.ssrLoadModule("/src/Product.tsx");
const { MutationPanel } = await loader.ssrLoadModule("/src/mutations/MutationPanel.tsx");
const { saveChangeRecovery } = await loader.ssrLoadModule("/src/mutations/recovery.ts");
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  dom.window.sessionStorage.clear();
  dom.window.history.replaceState(null, "", "/");
});
after(async () => {
  await loader.close();
  dom.window.close();
});
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function setup() {
  const id = crypto.randomUUID(),
    workspaceId = crypto.randomUUID(),
    sourceId = crypto.randomUUID();
  const plan = {
    operation: "update",
    table: "orders",
    changes: [{ column: "label", value: { kind: "string", value: "synthetic-canary" } }],
    where: [{ column: "id", operator: "eq", value: { kind: "integer", value: "1" } }],
  };
  const change = { requestId: id, workspaceId, sourceId, plan };
  dom.window.history.replaceState(null, "", `/?mcpChange=${id}`);
  return { id, workspaceId, sourceId, plan, change };
}
function common(path, f) {
  if (path.endsWith("/get-session")) return json({ user: { name: "管理员" } });
  if (path === "/api/mcp/capability")
    return json({ enabled: true, changeDraftsEnabled: true, changeOriginPreviewAvailable: true });
  if (path === "/api/mcp/clients") return json({ clients: [], resource: "http://localhost/mcp" });
  if (path === "/api/mcp/grants") return json({ grants: [] });
  if (path === "/api/mcp/invocations") return json({ invocations: [] });
  if (path.endsWith(`/change-drafts/${f.id}`))
    return json({
      id: f.id,
      change: f.change,
      commitment: "a".repeat(64),
      recipient: { mode: "http", clientId: "synthetic" },
    });
  return null;
}

test("handoff timeout clears the draft and does not retry or post a late receipt", async () => {
  const f = setup(),
    requests = [];
  let timeout, resolveClaim;
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === 15000) {
      timeout = fn;
      return { unref() {} };
    }
    return originalSetTimeout(fn, ms, ...args);
  };
  globalThis.fetch = async (path, init) => {
    path = String(path);
    requests.push(path);
    const known = common(path, f);
    if (known) return known;
    if (path.endsWith("/claim"))
      return new Promise((resolve) => {
        resolveClaim = resolve;
      });
    throw Error(`unexpected request ${path}`);
  };
  let view;
  await act(async () => {
    view = render(React.createElement(App));
  });
  await act(async () => {
    fireEvent.click(view.getByText("接收草稿"));
  });
  assert.equal(view.getByText("返回 MCP 管理").disabled, true);
  assert.equal(view.getByText("返回工作区").disabled, true);
  for (const label of [
    "数据源",
    "连接器",
    "账号安全",
    "模型配置",
    "外部 MCP 工具",
    "MCP 管理",
    "退出登录",
  ])
    assert.equal(view.getByLabelText(label).disabled, true);
  await act(async () => {
    timeout();
  });
  assert.match(view.container.textContent, /接收结果无法确认/);
  assert.equal(view.container.textContent.includes("synthetic-canary"), false);
  assert.equal(view.getByText("返回 MCP 管理").disabled, false);
  await act(async () => {
    resolveClaim(json({ id: f.id, change: f.change, receipt: "b".repeat(64) }));
  });
  assert.equal(requests.filter((path) => path.endsWith("/claim")).length, 1);
  assert.equal(requests.filter((path) => path.endsWith("/acknowledge")).length, 0);
});

test("acknowledgement timeout clears the received plan and ignores a late success", async () => {
  const f = setup(),
    requests = [];
  let timeout, resolveAck;
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === 15000) {
      timeout = fn;
      return { unref() {} };
    }
    return originalSetTimeout(fn, ms, ...args);
  };
  globalThis.fetch = async (raw) => {
    const path = String(raw);
    requests.push(path);
    const known = common(path, f);
    if (known) return known;
    if (path.endsWith("/claim"))
      return json({ id: f.id, change: f.change, receipt: "b".repeat(64) });
    if (path.endsWith("/acknowledge"))
      return new Promise((resolve) => {
        resolveAck = resolve;
      });
    throw Error(`unexpected request ${path}`);
  };
  let view;
  await act(async () => {
    view = render(React.createElement(App));
  });
  await act(async () => {
    fireEvent.click(view.getByText("接收草稿"));
  });
  assert.equal(typeof resolveAck, "function");
  await act(async () => {
    timeout();
  });
  assert.match(view.container.textContent, /接收结果无法确认/);
  assert.equal(view.container.textContent.includes("synthetic-canary"), false);
  await act(async () => {
    resolveAck(json({ ok: true }));
  });
  assert.equal(view.container.textContent.includes("synthetic-canary"), false);
  assert.equal(requests.filter((path) => path.endsWith("/acknowledge")).length, 1);
});

test("accepted scope remains visible and both exits stay blocked until uncertain confirmation is closed", async () => {
  const f = setup(),
    previewId = crypto.randomUUID();
  let resolveConfirm;
  globalThis.fetch = async (raw) => {
    const path = String(raw),
      known = common(path, f);
    if (known) return known;
    if (path.endsWith("/claim"))
      return json({ id: f.id, change: f.change, receipt: "b".repeat(64) });
    if (path.endsWith("/acknowledge")) return json({ ok: true });
    if (path.endsWith("/capability"))
      return json({
        enabled: true,
        available: true,
        executionEnabled: true,
        code: "ready",
        tables: ["orders"],
      });
    if (path.endsWith("/executions") || path.endsWith("/recovery"))
      return json({ items: [], nextCursor: null });
    if (path.endsWith("/previews"))
      return json({
        previewId,
        commitment: "a".repeat(43),
        revision: 1,
        operation: "update",
        table: "orders",
        rowCount: 1,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        rows: [
          {
            before: { label: { kind: "string", value: "old" } },
            after: { label: { kind: "string", value: "synthetic-canary" } },
          },
        ],
      });
    if (path.endsWith("/confirm"))
      return new Promise((resolve) => {
        resolveConfirm = resolve;
      });
    if (path.endsWith("/close")) return json({ state: "closed", execution: null });
    throw Error(`unexpected request ${path}`);
  };
  let view;
  await act(async () => {
    view = render(React.createElement(App));
  });
  await act(async () => {
    fireEvent.click(view.getByText("接收草稿"));
  });
  await waitFor(() => assert.ok(view.getByText("找回操作并封存旧预览")));
  assert.match(view.container.textContent, new RegExp(f.workspaceId));
  assert.match(view.container.textContent, new RegExp(f.sourceId));
  await act(async () => {
    fireEvent.click(view.getByText("找回操作并封存旧预览"));
  });
  await act(async () => {
    fireEvent.click(view.getByText("找回并封存旧预览"));
  });
  await waitFor(() => assert.ok(view.getByText("生成变更预览")));
  await act(async () => {
    fireEvent.click(view.getByText("生成变更预览"));
  });
  await waitFor(() => assert.ok(view.getByText("核对并确认本次变更")));
  await act(async () => {
    fireEvent.click(view.getByText("核对并确认本次变更"));
  });
  assert.match(document.body.textContent, new RegExp(f.workspaceId));
  assert.match(document.body.textContent, new RegExp(f.sourceId));
  await act(async () => {
    fireEvent.click(view.getByLabelText(/我已核对全部/));
  });
  await act(async () => {
    fireEvent.click(view.getByText("确认登记本次变更"));
  });
  const savedText = dom.window.sessionStorage.getItem("shuriva.mcp.pending-confirmation.v1");
  assert.ok(savedText);
  assert.equal(savedText.includes("synthetic-canary"), false);
  assert.equal(savedText.includes("orders"), false);
  assert.deepEqual(Object.keys(JSON.parse(savedText)).sort(), [
    "confirmation",
    "invocationId",
    "sourceId",
    "workspaceId",
  ]);
  assert.equal(view.getByText("返回 MCP 管理").disabled, true);
  assert.equal(view.getByText("返回工作区").disabled, true);
  assert.equal(view.getByLabelText("数据源").disabled, true);
  await act(async () => {
    resolveConfirm(json({ error: "unavailable" }, 503));
  });
  await waitFor(() => assert.ok(view.getByText("核对原确认")));
  assert.equal(view.getByText("返回 MCP 管理").disabled, true);
  assert.equal(view.getByText("返回工作区").disabled, true);
  await act(async () => {
    fireEvent.click(view.getByText("结束待核对确认"));
  });
  await waitFor(() => assert.equal(view.getByText("返回 MCP 管理").disabled, false));
  assert.equal(view.getByText("返回工作区").disabled, false);
});

test("expired session can leave, reauthenticate and check the original confirmation without replay", async () => {
  const f = setup(),
    previewId = crypto.randomUUID(),
    confirmationId = crypto.randomUUID();
  const saved = {
    invocationId: f.id,
    workspaceId: f.workspaceId,
    sourceId: f.sourceId,
    confirmation: { confirmationId, previewId, commitment: "a".repeat(43), revision: 1 },
  };
  dom.window.sessionStorage.setItem("shuriva.mcp.pending-confirmation.v1", JSON.stringify(saved));
  const paths = [];
  let expired = true;
  globalThis.fetch = async (raw) => {
    const path = String(raw);
    paths.push(path);
    if (path === "/api/mcp/capability")
      return json({
        enabled: true,
        changeDraftsEnabled: true,
        changeOriginPreviewAvailable: false,
      });
    if (path.includes("/change-drafts/")) throw Error("must not reclaim a draft during recovery");
    if (path.endsWith("/sign-out")) return json({ success: true });
    if (path.endsWith("/sign-in/username")) {
      expired = false;
      return json({ success: true });
    }
    if (path.startsWith("/api/workspaces?")) return json({ workspaces: [], nextCursor: null });
    if (path.endsWith(`/confirmations/${confirmationId}`))
      return expired
        ? json({ error: "UNAUTHENTICATED" }, 401)
        : json({ state: "unseen", execution: null });
    if (path.endsWith(`/confirmations/${confirmationId}/close`))
      return json({ state: "closed", execution: null });
    if (path.startsWith("/api/mutations/") && path.endsWith("/capability"))
      return json({
        enabled: true,
        available: true,
        executionEnabled: true,
        code: "ready",
        tables: ["orders"],
      });
    if (
      path.startsWith("/api/mutations/") &&
      (path.endsWith("/executions") || path.endsWith("/recovery"))
    )
      return json({ items: [], nextCursor: null });
    const known = common(path, f);
    if (known) return known;
    throw Error(`unexpected request ${path}`);
  };
  let view;
  await act(async () => {
    view = render(React.createElement(App));
  });
  assert.ok(view.getByText(confirmationId));
  await act(async () => {
    fireEvent.click(view.getByText("核对原确认"));
  });
  assert.match(view.container.textContent, /登录已过期/);
  await act(async () => {
    fireEvent.click(view.getByText("保留编号，稍后核对"));
  });
  assert.ok(view.getByText("继续核对原确认"));
  await act(async () => {
    fireEvent.click(view.getByLabelText("退出登录"));
  });
  await act(async () => {
    fireEvent.change(view.getByLabelText("用户名"), { target: { value: "admin" } });
    fireEvent.change(view.getByLabelText("密码"), { target: { value: "synthetic" } });
  });
  await act(async () => {
    fireEvent.submit(view.getByText("登录").closest("form"));
  });
  await act(async () => {
    fireEvent.click(view.getByLabelText("MCP 管理"));
  });
  await act(async () => {
    fireEvent.click(view.getByText("继续核对原确认"));
  });
  assert.ok(view.getByText(confirmationId));
  await act(async () => {
    fireEvent.click(view.getByText("核对原确认"));
  });
  assert.match(view.container.textContent, /尚未见登记/);
  assert.equal(paths.filter((path) => path.endsWith("/confirm")).length, 0);
  assert.equal(paths.filter((path) => path.includes("/change-drafts/")).length, 0);
  await act(async () => {
    fireEvent.click(view.getByText("结束待核对确认"));
  });
  assert.equal(dom.window.sessionStorage.getItem("shuriva.mcp.pending-confirmation.v1"), null);
  await waitFor(() => assert.equal(view.getByText("找回操作并封存旧预览").disabled, false));
  await act(async () => {
    fireEvent.click(view.getByText("找回操作并封存旧预览"));
  });
  await act(async () => {
    fireEvent.click(view.getByText("找回并封存旧预览"));
  });
  assert.equal(view.getByText("生成变更预览").disabled, true);
});

test("source-preview capability fails closed when unavailable", async () => {
  const f = setup();
  globalThis.fetch = async (raw) => {
    const path = String(raw);
    if (path === "/api/mcp/capability")
      return json({
        enabled: true,
        changeDraftsEnabled: true,
        changeOriginPreviewAvailable: false,
      });
    const known = common(path, f);
    if (known) return known;
    if (path.endsWith("/claim"))
      return json({ id: f.id, change: f.change, receipt: "b".repeat(64) });
    if (path.endsWith("/acknowledge")) return json({ ok: true });
    if (path.endsWith("/capability"))
      return json({
        enabled: true,
        available: true,
        executionEnabled: true,
        code: "ready",
        tables: ["orders"],
      });
    if (path.endsWith("/executions") || path.endsWith("/recovery"))
      return json({ items: [], nextCursor: null });
    throw Error(`unexpected request ${path}`);
  };
  let view;
  await act(async () => {
    view = render(React.createElement(App));
  });
  await act(async () => {
    fireEvent.click(view.getByText("接收草稿"));
  });
  assert.match(view.container.textContent, /草稿来源预览不可用或尚无法确认/);
  assert.match(view.container.textContent, /持久交接状态仍为未知/);
  assert.equal(view.getByText("找回操作并封存旧预览").disabled, false);
  await act(async () => {
    fireEvent.click(view.getByText("找回操作并封存旧预览"));
  });
  await act(async () => {
    fireEvent.click(view.getByText("找回并封存旧预览"));
  });
  assert.equal(view.getByText("生成变更预览").disabled, true);
});

test("another pending confirmation prevents receiving a different MCP draft", async () => {
  const f = setup(),
    original = {
      invocationId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      sourceId: crypto.randomUUID(),
      confirmation: {
        confirmationId: crypto.randomUUID(),
        previewId: crypto.randomUUID(),
        commitment: "a".repeat(43),
        revision: 1,
      },
    };
  dom.window.sessionStorage.setItem(
    "shuriva.mcp.pending-confirmation.v1",
    JSON.stringify(original),
  );
  const paths = [];
  globalThis.fetch = async (raw) => {
    const path = String(raw);
    paths.push(path);
    return common(path, f) ?? json({ error: "unexpected" }, 503);
  };
  let view;
  await act(async () => {
    view = render(React.createElement(App));
  });
  assert.match(view.container.textContent, /已有待核对确认/);
  assert.equal(
    paths.some((path) => path.includes(`/change-drafts/${f.id}`)),
    false,
  );
  assert.deepEqual(
    JSON.parse(dom.window.sessionStorage.getItem("shuriva.mcp.pending-confirmation.v1")),
    original,
  );
});

test("unreadable recovery storage is explicitly unknown and blocks draft disclosure", async () => {
  const f = setup(),
    storage = Object.getPrototypeOf(dom.window.sessionStorage),
    previous = storage.getItem,
    paths = [];
  storage.getItem = () => {
    throw Error("access denied");
  };
  try {
    globalThis.fetch = async (raw) => {
      const path = String(raw);
      paths.push(path);
      return common(path, f) ?? json({ error: "unexpected" }, 503);
    };
    let view;
    await act(async () => {
      view = render(React.createElement(App));
    });
    assert.match(view.container.textContent, /恢复记录，状态未知/);
    assert.equal(
      paths.some((path) => path.includes(`/change-drafts/${f.id}`)),
      false,
    );
  } finally {
    storage.getItem = previous;
  }
});

test("invalid recovery metadata is rejected before touching storage", () => {
  const f = setup();
  const value = {
    invocationId: f.id,
    workspaceId: f.workspaceId,
    sourceId: f.sourceId,
    confirmation: {
      confirmationId: crypto.randomUUID(),
      previewId: crypto.randomUUID(),
      commitment: "a".repeat(43),
      revision: 0,
    },
  };
  assert.throws(() => saveChangeRecovery(value));
  assert.equal(dom.window.sessionStorage.getItem("shuriva.mcp.pending-confirmation.v1"), null);
  const valid = { ...value, confirmation: { ...value.confirmation, revision: 1 } };
  saveChangeRecovery(valid);
  assert.throws(() =>
    saveChangeRecovery({ ...valid, confirmation: { ...valid.confirmation, revision: 0 } }),
  );
  assert.deepEqual(
    JSON.parse(dom.window.sessionStorage.getItem("shuriva.mcp.pending-confirmation.v1")),
    valid,
  );
});

test("ordinary workspace confirmation can defer through sign-out and recover only via current server authorization", async () => {
  const f = setup(),
    confirmationId = crypto.randomUUID(),
    previewId = crypto.randomUUID();
  dom.window.history.replaceState(null, "", "/");
  const saved = {
    invocationId: null,
    workspaceId: f.workspaceId,
    sourceId: f.sourceId,
    confirmation: { confirmationId, previewId, commitment: "a".repeat(43), revision: 1 },
  };
  dom.window.sessionStorage.setItem("shuriva.mcp.pending-confirmation.v1", JSON.stringify(saved));
  let permitted = false;
  const paths = [];
  globalThis.fetch = async (raw) => {
    const path = String(raw);
    paths.push(path);
    if (path.endsWith("/sign-out")) return json({ success: true });
    if (path.endsWith("/sign-in/username")) {
      permitted = true;
      return json({ success: true });
    }
    if (path.startsWith("/api/workspaces?")) return json({ workspaces: [], nextCursor: null });
    if (path.endsWith("/get-session")) return json({ user: { name: "管理员" } });
    if (path.includes("/api/mutations/") && !permitted) return json({ error: "DENIED" }, 403);
    if (path.endsWith("/capability"))
      return json({
        enabled: true,
        available: true,
        executionEnabled: true,
        code: "ready",
        tables: ["orders"],
      });
    if (path.endsWith("/executions")) return json({ items: [], nextCursor: null });
    if (path.endsWith(`/confirmations/${confirmationId}`))
      return json({ state: "unseen", execution: null });
    if (path.endsWith(`/confirmations/${confirmationId}/close`))
      return json({ state: "closed", execution: null });
    throw Error(`unexpected request ${path}`);
  };
  let view;
  await act(async () => {
    view = render(React.createElement(App));
  });
  await act(async () => {
    fireEvent.click(view.getByText("继续核对原确认"));
  });
  await waitFor(() => assert.match(view.container.textContent, /执行历史尚未加载或不可用/));
  assert.equal(view.container.textContent.includes("当前读取未见执行记录"), false);
  await act(async () => {
    fireEvent.click(view.getByText("核对原确认"));
  });
  assert.match(view.container.textContent, /没有权限/);
  await act(async () => {
    fireEvent.click(view.getByText("保留编号，稍后核对"));
  });
  assert.equal(view.getByText("返回工作区").disabled, false);
  await act(async () => {
    fireEvent.click(view.getByText("返回工作区"));
  });
  await act(async () => {
    fireEvent.click(view.getByLabelText("退出登录"));
  });
  await act(async () => {
    fireEvent.change(view.getByLabelText("用户名"), { target: { value: "admin" } });
    fireEvent.change(view.getByLabelText("密码"), { target: { value: "synthetic" } });
  });
  await act(async () => {
    fireEvent.submit(view.getByText("登录").closest("form"));
  });
  await act(async () => {
    fireEvent.click(view.getByText("继续核对原确认"));
  });
  await waitFor(() => assert.equal(view.getByText("核对原确认").disabled, false));
  await act(async () => {
    fireEvent.click(view.getByText("核对原确认"));
  });
  assert.match(view.container.textContent, /尚未见登记/);
  await act(async () => {
    fireEvent.click(view.getByText("结束待核对确认"));
  });
  await waitFor(() => assert.ok(view.getByText("找回操作并封存旧预览")));
  assert.equal(dom.window.sessionStorage.getItem("shuriva.mcp.pending-confirmation.v1"), null);
  assert.equal(
    paths.some((path) => path.endsWith("/confirm")),
    false,
  );
});

test("ordinary mutation confirmation itself saves only metadata before a lost response and can reopen", async () => {
  const f = setup(),
    previewId = crypto.randomUUID();
  let confirms = 0,
    busy = false;
  const pendingBase = `/api/mutations/${f.workspaceId}/${f.sourceId}`;
  globalThis.fetch = async (raw) => {
    const path = String(raw);
    if (path === `${pendingBase}/capability`)
      return json({
        enabled: true,
        available: true,
        executionEnabled: true,
        code: "ready",
        tables: ["orders"],
      });
    if (path === `${pendingBase}/executions` || path === `${pendingBase}/recovery`)
      return json({ items: [], nextCursor: null });
    if (path === `${pendingBase}/previews`)
      return json({
        previewId,
        commitment: "a".repeat(43),
        revision: 1,
        operation: "update",
        table: "orders",
        rowCount: 1,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        rows: [
          {
            before: { label: { kind: "string", value: "old" } },
            after: { label: { kind: "string", value: "synthetic-canary" } },
          },
        ],
      });
    if (path.endsWith("/confirm")) {
      confirms++;
      return json({ error: "UNAUTHENTICATED" }, 401);
    }
    if (path.endsWith("/close")) return json({ state: "closed", execution: null });
    throw Error(`unexpected request ${path}`);
  };
  const props = {
    workspaceId: f.workspaceId,
    sourceId: f.sourceId,
    initialPlan: f.plan,
    onBusyChange: (value) => {
      busy = value;
    },
  };
  let view;
  await act(async () => {
    view = render(React.createElement(MutationPanel, props));
  });
  await act(async () => {
    fireEvent.click(view.getByText("找回操作并封存旧预览"));
  });
  await act(async () => {
    fireEvent.click(view.getByText("找回并封存旧预览"));
  });
  await act(async () => {
    fireEvent.click(view.getByText("生成变更预览"));
  });
  await act(async () => {
    fireEvent.click(view.getByText("核对并确认本次变更"));
  });
  await act(async () => {
    fireEvent.click(view.getByLabelText(/我已核对全部/));
  });
  await act(async () => {
    fireEvent.click(view.getByText("确认登记本次变更"));
  });
  assert.equal(confirms, 1);
  assert.equal(busy, true);
  const raw = dom.window.sessionStorage.getItem("shuriva.mcp.pending-confirmation.v1");
  assert.ok(raw);
  assert.equal(JSON.parse(raw).invocationId, null);
  assert.equal(raw.includes("synthetic-canary"), false);
  assert.equal(raw.includes("orders"), false);
  await act(async () => {
    fireEvent.click(view.getByText("保留编号，稍后核对"));
  });
  assert.equal(busy, false);
  cleanup();
  await act(async () => {
    view = render(React.createElement(MutationPanel, props));
  });
  await waitFor(() => assert.equal(view.getByText("结束待核对确认").disabled, false));
  assert.equal(confirms, 1);
  await act(async () => {
    fireEvent.click(view.getByText("结束待核对确认"));
  });
  assert.equal(dom.window.sessionStorage.getItem("shuriva.mcp.pending-confirmation.v1"), null);
  assert.equal(confirms, 1);
});

test("an already registered restored execution can return to the recovery barrier", async () => {
  const f = setup(),
    previewId = crypto.randomUUID(),
    confirmationId = crypto.randomUUID(),
    executionId = crypto.randomUUID();
  dom.window.history.replaceState(null, "", "/");
  dom.window.sessionStorage.setItem(
    "shuriva.mcp.pending-confirmation.v1",
    JSON.stringify({
      invocationId: null,
      workspaceId: f.workspaceId,
      sourceId: f.sourceId,
      confirmation: { confirmationId, previewId, commitment: "a".repeat(43), revision: 1 },
    }),
  );
  const now = new Date().toISOString();
  const execution = {
    previewId,
    confirmationId,
    executionId,
    commitment: "a".repeat(43),
    revision: 1,
    operation: "update",
    table: "orders",
    rowCount: 1,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    state: "registered",
    permitIssued: false,
    cancelRequested: false,
    createdAt: now,
    updatedAt: now,
    code: null,
    reconciliationExpiresAt: null,
    affectedRows: null,
  };
  globalThis.fetch = async (raw) => {
    const path = String(raw);
    if (path.endsWith("/get-session")) return json({ user: { name: "管理员" } });
    if (path.startsWith("/api/workspaces?")) return json({ workspaces: [], nextCursor: null });
    if (path.endsWith("/capability"))
      return json({
        enabled: true,
        available: true,
        executionEnabled: true,
        code: "ready",
        tables: ["orders"],
      });
    if (path.endsWith("/executions")) return json({ items: [execution], nextCursor: null });
    if (path.endsWith(`/confirmations/${confirmationId}`))
      return json({ state: "registered", execution });
    if (path.endsWith(`/executions/${executionId}`)) return json(execution);
    throw Error(`unexpected request ${path}`);
  };
  let view;
  await act(async () => {
    view = render(React.createElement(App));
  });
  await act(async () => {
    fireEvent.click(view.getByText("继续核对原确认"));
  });
  await waitFor(() => assert.equal(view.getByText("核对原确认").disabled, false));
  await act(async () => {
    fireEvent.click(view.getByText("核对原确认"));
  });
  assert.ok(view.getByText("返回找回操作"));
  await act(async () => {
    fireEvent.click(view.getByText("返回找回操作"));
  });
  await waitFor(() => assert.ok(view.getByText("找回操作并封存旧预览")));
});

test("pending confirmation permits read-only history retry, detail snapshot and pagination", async () => {
  const f = setup(),
    previewId = crypto.randomUUID(),
    confirmationId = crypto.randomUUID(),
    firstId = crypto.randomUUID(),
    secondId = crypto.randomUUID();
  dom.window.history.replaceState(null, "", "/");
  dom.window.sessionStorage.setItem(
    "shuriva.mcp.pending-confirmation.v1",
    JSON.stringify({
      invocationId: null,
      workspaceId: f.workspaceId,
      sourceId: f.sourceId,
      confirmation: { confirmationId, previewId, commitment: "a".repeat(43), revision: 1 },
    }),
  );
  const now = new Date().toISOString();
  const make = (executionId) => ({
    previewId: crypto.randomUUID(),
    confirmationId: crypto.randomUUID(),
    executionId,
    commitment: "a".repeat(43),
    revision: 1,
    operation: "update",
    table: "orders",
    rowCount: 1,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    state: "registered",
    permitIssued: false,
    cancelRequested: false,
    createdAt: now,
    updatedAt: now,
    code: null,
    reconciliationExpiresAt: null,
    affectedRows: null,
  });
  let reads = 0;
  const paths = [];
  globalThis.fetch = async (raw) => {
    const path = String(raw);
    paths.push(path);
    if (path.endsWith("/get-session")) return json({ user: { name: "管理员" } });
    if (path.startsWith("/api/workspaces?")) return json({ workspaces: [], nextCursor: null });
    if (path.endsWith("/capability"))
      return json({
        enabled: true,
        available: true,
        executionEnabled: true,
        code: "ready",
        tables: ["orders"],
      });
    if (path.endsWith("/executions")) {
      reads++;
      return reads === 1
        ? json({ error: "unavailable" }, 503)
        : json({ items: [make(firstId)], nextCursor: "1" });
    }
    if (path.includes("/executions?after=1"))
      return json({ items: [make(secondId)], nextCursor: null });
    throw Error(`unexpected request ${path}`);
  };
  let view;
  await act(async () => {
    view = render(React.createElement(App));
  });
  await act(async () => {
    fireEvent.click(view.getByText("继续核对原确认"));
  });
  await waitFor(() => assert.equal(view.getByText("重新读取执行历史").disabled, false));
  assert.ok(view.getByText(confirmationId));
  await act(async () => {
    fireEvent.click(view.getByText("重新读取执行历史"));
  });
  await act(async () => {
    fireEvent.click(view.getByText(firstId));
  });
  assert.match(view.container.textContent, /历史记录（上次读取快照）/);
  assert.match(view.container.textContent, /上次读取的历史快照，可能已经变化/);
  assert.ok(view.getByText(confirmationId));
  await act(async () => {
    fireEvent.click(view.getByText("重新读取执行历史"));
  });
  assert.equal(view.queryByText("历史记录（上次读取快照）"), null);
  assert.ok(view.getByText(confirmationId));
  await act(async () => {
    fireEvent.click(view.getByText("查看更早记录"));
  });
  await act(async () => {
    fireEvent.click(view.getByText(secondId));
  });
  assert.ok(view.getByText(confirmationId));
  assert.equal(
    paths.some((path) => /\/(confirm|close|cancel)$/.test(path)),
    false,
  );
  assert.equal(
    paths.some((path) => path.includes(`/executions/${firstId}`)),
    false,
  );
});

test("source unavailable still allows pending history snapshot and pagination", async () => {
  const f = setup(),
    confirmationId = crypto.randomUUID(),
    executionId = crypto.randomUUID();
  const pending = {
    confirmationId,
    previewId: crypto.randomUUID(),
    commitment: "a".repeat(43),
    revision: 1,
  };
  dom.window.sessionStorage.setItem(
    "shuriva.mcp.pending-confirmation.v1",
    JSON.stringify({
      invocationId: null,
      workspaceId: f.workspaceId,
      sourceId: f.sourceId,
      confirmation: pending,
    }),
  );
  const now = new Date().toISOString();
  const execution = {
    ...pending,
    confirmationId: crypto.randomUUID(),
    executionId,
    operation: "update",
    table: "orders",
    rowCount: 1,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    state: "registered",
    permitIssued: false,
    cancelRequested: false,
    createdAt: now,
    updatedAt: now,
    code: null,
    reconciliationExpiresAt: null,
    affectedRows: null,
  };
  const paths = [];
  globalThis.fetch = async (raw) => {
    const path = String(raw);
    paths.push(path);
    if (path.endsWith("/capability"))
      return json({
        enabled: true,
        available: true,
        executionEnabled: true,
        code: "ready",
        tables: ["orders"],
      });
    if (path.endsWith("/executions")) return json({ items: [execution], nextCursor: "1" });
    if (path.includes("/executions?after=1")) return json({ items: [], nextCursor: null });
    throw Error(`unexpected request ${path}`);
  };
  let view;
  await act(async () => {
    view = render(
      React.createElement(MutationPanel, {
        workspaceId: f.workspaceId,
        sourceId: f.sourceId,
        unavailable: true,
      }),
    );
  });
  await waitFor(() => assert.equal(view.getByText(executionId).closest("button").disabled, false));
  await act(async () => {
    fireEvent.click(view.getByText(executionId));
  });
  assert.ok(view.getByText("历史记录（上次读取快照）"));
  assert.ok(view.getByText(confirmationId));
  await act(async () => {
    fireEvent.click(view.getByText("查看更早记录"));
  });
  assert.ok(view.getByText(confirmationId));
  assert.equal(
    paths.some((path) => /\/(confirm|close|cancel)$/.test(path)),
    false,
  );
});

test("missing binding migration keeps read/recovery available and all new draft actions closed", async () => {
  const f = setup(),
    paths = [];
  globalThis.fetch = async (raw) => {
    const path = String(raw);
    paths.push(path);
    if (path.endsWith("/capability"))
      return json({
        enabled: true,
        available: false,
        executionEnabled: false,
        code: "binding_identity_required",
        tables: [],
      });
    if (path.endsWith("/executions") || path.endsWith("/recovery"))
      return json({ items: [], nextCursor: null });
    throw Error(`Unexpected request ${path}`);
  };
  let view;
  await act(async () => {
    view = render(
      React.createElement(MutationPanel, {
        workspaceId: f.workspaceId,
        sourceId: f.sourceId,
        initialPlan: f.plan,
      }),
    );
  });
  assert.ok(view.getByText("需先由管理员完成绑定身份迁移"));
  assert.equal(view.getByText("找回操作并封存旧预览").disabled, false);
  await act(async () => {
    fireEvent.click(view.getByText("找回操作并封存旧预览"));
  });
  await act(async () => {
    fireEvent.click(view.getByText("找回并封存旧预览"));
  });
  assert.equal(view.getByText("生成变更预览").disabled, true);
  assert.equal(
    paths.some((path) => path.endsWith("/recovery")),
    true,
  );
  assert.equal(
    paths.some((path) => /\/(previews|confirm|claim|permit)$/.test(path)),
    false,
  );
});

for (const [status, hint] of [
  [401, /执行历史需要重新登录/],
  [403, /当前账号无权读取执行历史.*检查账号和数据源权限/],
]) {
  test(`history ${status} reports access separately and permits retry after access is restored`, async () => {
    const f = setup(),
      pending = {
        confirmationId: crypto.randomUUID(),
        previewId: crypto.randomUUID(),
        commitment: "a".repeat(43),
        revision: 1,
      };
    dom.window.sessionStorage.setItem(
      "shuriva.mcp.pending-confirmation.v1",
      JSON.stringify({
        invocationId: null,
        workspaceId: f.workspaceId,
        sourceId: f.sourceId,
        confirmation: pending,
      }),
    );
    let permitted = false;
    globalThis.fetch = async (raw) => {
      const path = String(raw);
      if (path.endsWith("/capability"))
        return json({
          enabled: true,
          available: true,
          executionEnabled: true,
          code: "ready",
          tables: ["orders"],
        });
      if (path.endsWith("/executions"))
        return permitted
          ? json({ items: [], nextCursor: null })
          : json({ error: "SECRET_FROM_SERVER" }, status);
      throw Error(`unexpected request ${path}`);
    };
    let view;
    await act(async () => {
      view = render(
        React.createElement(MutationPanel, { workspaceId: f.workspaceId, sourceId: f.sourceId }),
      );
    });
    await waitFor(() => assert.match(view.container.textContent, hint));
    assert.equal(view.container.textContent.includes("SECRET_FROM_SERVER"), false);
    assert.equal(view.getByText("重新读取执行历史").disabled, false);
    assert.ok(view.getByText(pending.confirmationId));
    permitted = true;
    await act(async () => {
      fireEvent.click(view.getByText("重新读取执行历史"));
    });
    await waitFor(() => assert.ok(view.getByText(/当前读取未见执行记录；这不能单独证明/)));
    assert.ok(view.getByText(pending.confirmationId));
  });
}
