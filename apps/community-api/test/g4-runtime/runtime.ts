import assert from "node:assert/strict";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { RowDataPacket } from "mysql2/promise";
import { mutationFixture } from "../mutation-fixture.js";
import type { RuntimeConfig } from "./api-child.js";
import { resetOnlyAdminPassword } from "../../src/reset-password.js";

function completion(child: ChildProcess) {
  let finished = false;
  const done = new Promise<number | null>((resolve) => {
    const finish = (code: number | null) => {
      finished = true;
      resolve(code);
    };
    // exit proves termination even if the test runner retains an IPC/stdio
    // handle. A failed spawn has no PID and never emits exit.
    child.once("exit", finish);
    child.once("error", () => {
      if (!child.pid) finish(-1);
    });
  });
  return {
    done,
    get finished() {
      return finished;
    },
  };
}
async function boundedCompletion(done: Promise<number | null>, label: string) {
  const code = await Promise.race([done, delay(12_000, undefined, { ref: false })]);
  if (code === undefined) throw Error(`G4 ${label} did not close`);
  return code;
}

export const origin = "http://127.0.0.2:5193";
export const base = "http://127.0.0.1:43129";
export async function until<T>(
  read: () => Promise<T | undefined>,
  milliseconds = 15_000,
): Promise<T> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error("G4 observation deadline exceeded");
}
/** Owns only children, directories and schemas allocated by this isolated fixture. */
export async function g4Runtime(
  options: {
    directoryUnavailable?: boolean;
    probeUnavailable?: boolean;
    mcp?: boolean;
    mcpChangeDrafts?: boolean;
  } = {},
) {
  assert.equal(process.env.STAGE8_G4_ACCEPTANCE, "1");
  const fixture = await mutationFixture({ completeSchema: true });
  let runRoot: string, directory: string;
  try {
    runRoot = await realpath(dirname(process.env.STAGE8_G3_MANIFEST ?? ""));
    directory = await mkdtemp(
      options.directoryUnavailable
        ? join(runRoot, `absent-${randomUUID()}`, "g4-runtime-")
        : join(runRoot, "g4-runtime-"),
    );
  } catch (error) {
    await fixture.close();
    throw error;
  }
  const config: RuntimeConfig = {
    database: fixture.database,
    directory,
    secret: randomBytes(32).toString("hex"),
    origin,
    port: 43129,
    ...fixture.binding,
    mcp: options.mcp,
    mcpChangeDrafts: options.mcpChangeDrafts,
  };
  let child: ChildProcess | undefined;
  let probe: ReturnType<typeof spawn> | undefined;
  let apiLife: ReturnType<typeof completion> | undefined,
    probeLife: ReturnType<typeof completion> | undefined;
  let apiFailed = false,
    probeFailed = false;
  let apiCloseStage = "not_started";
  let commandId = 0;
  const replies = new Map<number, { result?: unknown; error?: string }>();
  const barriers: string[] = [];
  const probeEvents: Array<Record<string, unknown>> = [];
  let catalog = "";
  let probeDiagnostic = "";
  let cookie = "";
  let snapshotAuthority: { cookie: string; password: string } | undefined;
  const username = `g4${randomBytes(6).toString("hex")}`;
  let password = `G4-disposable-${randomBytes(16).toString("hex")}`;
  async function stopApi(mode: "kill" | "disconnect") {
    const owned = child,
      life = apiLife;
    if (!owned || !life) return;
    if (!life.finished) {
      if (mode === "disconnect" && owned.connected) owned.disconnect();
      else if (owned.pid) owned.kill();
    }
    try {
      const code = await boundedCompletion(life.done, `API (${apiCloseStage})`);
      if (mode === "disconnect") assert.equal(code, 0, "G4 API failed graceful cleanup");
    } catch (error) {
      if (!life.finished && owned.pid) owned.kill();
      await boundedCompletion(life.done, "terminated API");
      throw error;
    } finally {
      if (life.finished) owned.stderr?.destroy();
    }
  }
  async function start() {
    let ready = false;
    child = fork(fileURLToPath(new URL("./api-child.js", import.meta.url)), [], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      execArgv: [],
    });
    apiLife = completion(child);
    apiFailed = false;
    child.stderr?.on("data", (chunk) => {
      const fatal = String(chunk).match(/G4_FATAL_[A-Z0-9_]+/g);
      if (fatal?.length) apiCloseStage = fatal[fatal.length - 1] ?? "unknown";
      const stages = String(chunk).match(/G4_CLOSE_[A-Z_]+/g);
      if (stages?.length) apiCloseStage = stages[stages.length - 1] ?? "unknown";
    });
    child.on(
      "message",
      (message: {
        ready?: boolean;
        configurationReady?: boolean;
        id?: number;
        barrier?: string;
        error?: string;
        result?: unknown;
      }) => {
        if (message.configurationReady) {
          child?.send(config);
          return;
        }
        if (message.ready) ready = true;
        if (message.id !== undefined) replies.set(message.id, message);
        if (message.barrier) barriers.push(message.barrier);
      },
    );
    child.on("error", () => {
      apiFailed = true;
    });
    await until(async () => {
      assert.equal(
        apiFailed || apiLife?.finished,
        false,
        `isolated API failed to start or exited: ${apiCloseStage}`,
      );
      return ready || undefined;
    });
  }
  async function command(action: string, data?: unknown) {
    assert.ok(child?.connected);
    const id = ++commandId;
    child.send({ id, action, data });
    const reply = await until(async () => replies.get(id));
    replies.delete(id);
    assert.equal(reply.error, undefined);
    return reply.result;
  }
  async function login() {
    const response = await fetch(`${base}/api/auth/sign-in/username`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    assert.ok(cookie);
  }
  async function request(path: string, body?: unknown) {
    return fetch(
      `${base}/api/mutations/${fixture.binding.workspaceId}/${fixture.binding.sourceId}${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(35_000),
      },
    );
  }
  async function json(path: string, body?: unknown): Promise<Record<string, unknown>> {
    if (probe) assert.equal(probe.exitCode, null, `isolated Connector exited: ${probeDiagnostic}`);
    const response = await request(path, body);
    const result = (await response.json()) as Record<string, unknown>;
    assert.ok(response.ok, `G4 HTTP ${response.status}: ${JSON.stringify(result)}`);
    return result;
  }
  async function observe() {
    assert.match(catalog, /^stage8_g2_[0-9a-f]{12}$/);
    const [rows] = await fixture.pool.query<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) id,label,CAST(amount AS CHAR) amount FROM \`${catalog}\`.orders ORDER BY id`,
    );
    return rows;
  }
  let closing: Promise<void> | undefined;
  function close() {
    if (!closing) closing = dispose();
    return closing;
  }
  async function dispose() {
    const failures: unknown[] = [];
    const labels: string[] = [];
    const cleanup = async (label: string, action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        labels.push(label);
        failures.push(error);
      }
    };
    await cleanup("probe", async () => {
      if (!probe || !probeLife) return;
      if (probeFailed && !probe.pid) {
        await boundedCompletion(probeLife.done, "unstarted probe");
        throw Error("G4_PROBE_START_FAILED");
      }
      if (!probeLife.finished && !probeFailed) probe.stdin?.write('{"stop":true}\n');
      const code = await Promise.race([probeLife.done, delay(12_000, undefined, { ref: false })]);
      if (code === undefined) {
        if (probe.pid) probe.kill();
        await boundedCompletion(probeLife.done, "probe");
        throw Error("isolated probe required termination");
      }
      assert.equal(code, 0, `isolated probe failed: ${probeDiagnostic}`);
    });
    await cleanup("API", () => stopApi("disconnect"));
    await cleanup("database", fixture.close);
    await cleanup("directory", async () => {
      const owned = await realpath(directory);
      assert.equal(dirname(owned), runRoot);
      assert.ok(owned.startsWith(resolve(runRoot, "g4-runtime-")));
      await rm(owned, { recursive: true, force: true });
    });
    if (failures.length)
      throw new AggregateError(failures, `G4 owned resource cleanup failed: ${labels.join(",")}`);
  }
  try {
    await start();
    const user = (await command("signup", {
      name: "G4 隔离验收管理员",
      username,
      email: `${username}@example.invalid`,
      password,
    })) as { user: { id: string } };
    const initialOwner = fixture.binding.ownerId;
    fixture.binding.ownerId = user.user.id;
    config.ownerId = user.user.id;
    await fixture.pool.execute(
      "UPDATE workspace SET createdByAccountId=?, name='G4 独立验收工作区' WHERE id=?",
      [user.user.id, fixture.binding.workspaceId],
    );
    await fixture.pool.execute(
      "UPDATE data_source SET ownerId=?,name='G4 隔离 orders' WHERE id=?",
      [user.user.id, fixture.binding.sourceId],
    );
    await fixture.pool.execute("DELETE FROM session WHERE userId=?", [initialOwner]);
    await fixture.pool.execute("DELETE FROM user WHERE id=?", [initialOwner]);
    // Reopen so the process composition's pairing owner agrees with the real SDK identity.
    await stopApi("disconnect");
    await start();
    await login();
    const offer = (await command("pair")) as {
      pairingId: string;
      secret: string;
      platformPublicKey: string;
    };
    const executable = resolve(
      runRoot,
      options.probeUnavailable ? `absent-${randomUUID()}.exe` : "mutation-probe.exe",
    );
    probe = spawn(executable, [], {
      cwd: fileURLToPath(new URL("../../../../../connector/go/", import.meta.url)),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    probeLife = completion(probe);
    probe.stderr?.on("data", (chunk) => {
      probeDiagnostic = (probeDiagnostic + String(chunk)).slice(-4000);
    });
    probe.on("error", () => {
      probeFailed = true;
    });
    probe.stdin?.on("error", () => {});
    assert.ok(probe.stdout);
    const lines = createInterface({ input: probe.stdout });
    lines.on("line", (line) => {
      try {
        probeEvents.push(JSON.parse(line));
      } catch {
        /* Only JSON fixture events are observations. */
      }
    });
    probe.stdin?.write(
      `${JSON.stringify({ server: base, code: `${offer.pairingId}.${offer.secret}.${offer.platformPublicKey}`, ownerId: config.ownerId, workspaceId: config.workspaceId, sourceId: config.sourceId, reconnect: true })}\n`,
    );
    const ready = await until(async () => {
      assert.equal(
        probeFailed || probeLife?.finished,
        false,
        "isolated probe failed to start or exited",
      );
      return probeEvents.find((event) => event.ready === true);
    }, 45_000);
    assert.equal(typeof ready.connectorId, "string");
    assert.equal(typeof ready.catalog, "string");
    catalog = ready.catalog as string;
    fixture.binding.connectorId = ready.connectorId as string;
    await fixture.pool.execute("UPDATE data_source SET connectorId=? WHERE id=?", [
      fixture.binding.connectorId,
      fixture.binding.sourceId,
    ]);
    probe.stdin?.write('{"run":true}\n');
    await until(async () => {
      const value = await json("/capability");
      return value.available === true ? true : undefined;
    }, 35_000);
    return {
      fixture,
      directory,
      username,
      password,
      json,
      request,
      cookie: () => cookie,
      catalog: () => catalog,
      command,
      observe,
      probeEvents,
      barriers,
      async restart() {
        await stopApi("kill");
        await start();
      },
      captureSnapshotAuthority() {
        snapshotAuthority = { cookie, password };
      },
      async useRestoredDatabase(database: string, restoredPassword: string) {
        assert.match(database, /^g3_mut_api_[0-9a-f]{16}$/);
        assert.ok(snapshotAuthority);
        await stopApi("disconnect");
        config.database = database;
        await start();
        // Recovery procedure removes restored sessions before exposing HTTP.
        const snapshotRequest = await fetch(
          `${base}/api/mutations/${fixture.binding.workspaceId}/${fixture.binding.sourceId}/capability`,
          { headers: { origin, cookie: snapshotAuthority.cookie } },
        );
        assert.equal(snapshotRequest.status, 401, "snapshot-era session regained authority");
        assert.equal((await request("/capability")).status, 401);
        for (const oldPassword of [snapshotAuthority.password, password]) {
          const oldLogin = await fetch(`${base}/api/auth/sign-in/username`, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({ username, password: oldPassword }),
          });
          assert.equal(oldLogin.status, 401, "snapshot-era password regained authority");
        }
        password = restoredPassword;
        await login();
      },
      async rotatePassword() {
        password = `G4-disposable-${randomBytes(16).toString("hex")}`;
        await resetOnlyAdminPassword(fixture.pool, password);
        await login();
      },
      async barrier(name: string) {
        await until(async () => barriers.includes(name) || undefined);
        barriers.splice(barriers.indexOf(name), 1);
      },
      async preview(label: string) {
        return json("/previews", {
          plan: {
            operation: "update",
            table: "orders",
            changes: [{ column: "label", value: { kind: "string", value: label } }],
            where: [{ column: "id", operator: "eq", value: { kind: "integer", value: "1" } }],
          },
        });
      },
      confirmation(preview: Record<string, unknown>) {
        return {
          confirmationId: randomUUID(),
          previewId: preview.previewId,
          commitment: preview.commitment,
          revision: preview.revision,
        };
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "G4 initialization and owned cleanup failed");
    }
    throw error;
  }
}
