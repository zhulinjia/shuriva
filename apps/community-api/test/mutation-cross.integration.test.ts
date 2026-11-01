import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import { authMutationIdentity, createAuth } from "../src/auth.js";
import { mountProductRoutes } from "../src/product-routes.js";
import { createDiagnosticLogger, withDiagnostics } from "../src/logging/public.js";
import { ConnectorRegistry } from "../src/connectors/registry.js";
import { mountConnectorRoutes } from "../src/connectors/routes.js";
import {
  ConnectorMutationTransport,
  mountMutationAgentRoutes,
} from "../src/mutations/connector-transport.js";
import { MutationError, type PublicMutationExecution } from "../src/mutations/model.js";
import type { MutationAccess } from "../src/mutations/ports.js";
import { mountMutationRoutes } from "../src/mutations/routes.js";
import { MutationService } from "../src/mutations/service.js";
import { ScopeCoordinator } from "../src/datasources/public.js";
import { mutationFixture } from "./mutation-fixture.js";

test("G4 real Better Auth login, signed Go Connector and isolated MySQL complete three controlled operations", {
  skip: process.env.STAGE8_G3_TEST !== "1",
  timeout: 100_000,
}, async () => {
  const fixture = await mutationFixture();
  const directory = await mkdtemp(join(tmpdir(), "g3-mutation-wire-"));
  const registry = await ConnectorRegistry.open(
    join(directory, "registry.json"),
    randomBytes(32).toString("hex"),
  );
  const origin = "http://127.0.0.1:5173";
  const auth = createAuth(
    {
      databaseUrl: "mysql://unused:unused@127.0.0.1:13308/not-used",
      secret: randomBytes(32).toString("hex"),
      origin,
    },
    fixture.pool,
  );
  const username = `g4${randomBytes(8).toString("hex")}`;
  const password = randomBytes(24).toString("base64url");
  const registeredUser = await auth.api.signUpEmail({
    body: {
      name: "G4 isolated administrator",
      username,
      email: `${username}@example.invalid`,
      password,
    },
  });
  const authContext = await auth.$context;
  const diagnosticLines: string[] = [];
  const diagnosticLogger = createDiagnosticLogger({ write: (line) => diagnosticLines.push(line) });
  const requestId = randomUUID();
  withDiagnostics(diagnosticLogger, { requestId }, () => {
    authContext.logger.error("G4_AUTH_PRIVATE_MESSAGE", new Error("G4_AUTH_PRIVATE_SQL"), {
      cookie: "G4_AUTH_PRIVATE_COOKIE",
    });
    authContext.logger.warn("G4_AUTH_PRIVATE_WARNING");
  });
  assert.equal(diagnosticLines.length, 2);
  assert.equal(diagnosticLines.join("").includes("G4_AUTH_PRIVATE"), false);
  assert.ok(diagnosticLines.every((line) => JSON.parse(line).requestId === requestId));
  assert.equal(JSON.parse(diagnosticLines[0]).event, "auth.failure");
  fixture.binding.ownerId = registeredUser.user.id;
  await fixture.pool.execute("UPDATE workspace SET createdByAccountId=? WHERE id=?", [
    fixture.binding.ownerId,
    fixture.binding.workspaceId,
  ]);
  await fixture.pool.execute("UPDATE data_source SET ownerId=? WHERE id=?", [
    fixture.binding.ownerId,
    fixture.binding.sourceId,
  ]);
  const coordinator = new ScopeCoordinator(fixture.sources, registry);
  const access: MutationAccess = {
    authenticate: authMutationIdentity(auth),
    async withScope(scope, action) {
      if (
        scope.ownerId !== fixture.binding.ownerId ||
        scope.workspaceId !== fixture.binding.workspaceId ||
        scope.sourceId !== fixture.binding.sourceId
      )
        throw new MutationError("NOT_FOUND");
      // Retain the same workspace and withActiveOwner identity locks as the
      // production composition until the claim/permit SQL transaction settles.
      return coordinator.withScope(scope, action);
    },
  };
  const channel = new ConnectorMutationTransport(registry, access);
  // Explicit isolated composition, never the production bootstrap switch.
  const service = new MutationService(
    fixture.store,
    access,
    channel,
    { sign: async (payload) => registry.signMutationPermit(payload) },
    { enabled: true, executionEnabled: true },
  );
  channel.onExecutionResult((binding, execution, outcome) =>
    service.result(binding, execution.executionId, outcome).then(() => {}),
  );
  const application = express();
  mountProductRoutes(application, auth, fixture.pool, origin);
  mountMutationAgentRoutes(application, registry, channel, service);
  mountConnectorRoutes(application, registry, origin, async () => fixture.binding.ownerId);
  mountMutationRoutes(application, origin, access, service);
  const server = application.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const signedIn = await fetch(`${base}/api/auth/sign-in/username`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  assert.match(signedIn.headers.get("set-cookie") ?? "", /HttpOnly/i);
  const offer = await registry.createPairing(fixture.binding.ownerId);
  const child = spawn("go", ["run", "./testdata/mutation-probe"], {
    cwd: fileURLToPath(new URL("../../../../connector/go/", import.meta.url)),
    env: { ...process.env, GOARCH: "amd64" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let error = "";
  child.stderr.on("data", (chunk) => {
    error += String(chunk);
  });
  child.stdin.on("error", () => {
    /* Exited fixture; readiness/exit carries the failure. */
  });
  const lines = createInterface({ input: child.stdout });
  const events: unknown[] = [];
  let readiness: ((value: { ready: boolean; connectorId: string }) => void) | undefined;
  const ready = new Promise<{ ready: boolean; connectorId: string }>((resolve, reject) => {
    readiness = resolve;
    child.once("error", reject);
    child.once("exit", () =>
      reject(new Error(`isolated Go probe exited before readiness: ${error}`)),
    );
  });
  lines.on("line", (line) => {
    try {
      const value: unknown = JSON.parse(line);
      events.push(value);
      if (
        value &&
        typeof value === "object" &&
        "ready" in value &&
        value.ready === true &&
        "connectorId" in value &&
        typeof value.connectorId === "string"
      )
        readiness?.({ ready: true, connectorId: value.connectorId });
    } catch {
      /* Non-JSON compiler diagnostics are not protocol messages. */
    }
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  child.stdin.write(
    `${JSON.stringify({ server: base, code: `${offer.pairingId}.${offer.secret}.${offer.platformPublicKey}`, ownerId: fixture.binding.ownerId, workspaceId: fixture.binding.workspaceId, sourceId: fixture.binding.sourceId })}\n`,
  );
  const scopeBase = `${base}/api/mutations/${fixture.binding.workspaceId}/${fixture.binding.sourceId}`;
  const headers = {
    origin,
    cookie,
    "content-type": "application/json",
  };
  async function request(path: string, body?: unknown) {
    return fetch(`${scopeBase}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const executions: PublicMutationExecution[] = [];
  try {
    const connected = await Promise.race([
      ready,
      delay(45_000, undefined, { ref: false }).then(() => {
        throw new Error(`Go fixture setup timed out: ${error}`);
      }),
    ]);
    fixture.binding.connectorId = connected.connectorId;
    await fixture.pool.execute("UPDATE data_source SET connectorId=? WHERE id=?", [
      connected.connectorId,
      fixture.binding.sourceId,
    ]);
    child.stdin.write('{"run":true}\n');
    assert.equal((await fetch(`${scopeBase}/capability`)).status, 401);
    assert.equal(
      (
        await fetch(`${scopeBase}/capability`, {
          headers: { cookie: "better-auth.session_token=forged" },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${scopeBase}/recovery`, {
          method: "POST",
          headers: { ...headers, origin: "http://evil.invalid" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(
          `${base}/api/mutations/${randomUUID()}/${fixture.binding.sourceId}/capability`,
          { headers },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(
          `${base}/api/mutations/${fixture.binding.workspaceId}/${randomUUID()}/capability`,
          { headers },
        )
      ).status,
      404,
    );
    assert.equal((await request("/previews", { plan: { sql: "DELETE FROM orders" } })).status, 400);
    assert.equal(
      (await fetch(`${base}/api/auth/sign-up/email`, { method: "POST", headers, body: "{}" }))
        .status,
      404,
    );
    const outsiderName = `other${randomBytes(6).toString("hex")}`;
    await auth.api.signUpEmail({
      body: {
        username: outsiderName,
        name: "G4 negative identity fixture",
        email: `${outsiderName}@example.invalid`,
        password,
      },
    });
    const outsiderLogin = await fetch(`${base}/api/auth/sign-in/username`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ username: outsiderName, password }),
    });
    assert.equal(outsiderLogin.status, 200);
    const outsiderCookie = outsiderLogin.headers.get("set-cookie")?.split(";")[0];
    assert.ok(outsiderCookie);
    assert.equal(
      (await fetch(`${scopeBase}/capability`, { headers: { cookie: outsiderCookie } })).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${scopeBase}/recovery`, {
          method: "POST",
          headers: { ...headers, cookie: outsiderCookie },
          body: "{}",
        })
      ).status,
      404,
    );
    const capabilityResponse = await request("/capability");
    assert.equal(capabilityResponse.status, 200);
    const capability = (await capabilityResponse.json()) as {
      available: boolean;
      executionEnabled: boolean;
    };
    assert.equal(capability.available, true);
    assert.equal(capability.executionEnabled, true);
    const recovered = await request("/recovery", {});
    assert.equal(recovered.status, 200);
    assert.deepEqual(
      ((await recovered.json()) as { recoveredReceipts: unknown[] }).recoveredReceipts,
      [],
    );
    for (const plan of [
      {
        operation: "update",
        table: "orders",
        changes: [{ column: "label", value: { kind: "string", value: "changed" } }],
        where: [{ column: "id", operator: "eq", value: { kind: "integer", value: "1" } }],
      },
      {
        operation: "insert",
        table: "orders",
        rows: [
          [
            { column: "label", value: { kind: "string", value: "new" } },
            { column: "amount", value: { kind: "decimal", value: "25.10" } },
          ],
        ],
      },
      {
        operation: "delete",
        table: "orders",
        where: [{ column: "id", operator: "eq", value: { kind: "integer", value: "1" } }],
      },
    ]) {
      const response = await request("/previews", { plan });
      assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
      const preview = (await response.json()) as {
        previewId: string;
        commitment: string;
        revision: number;
        rowCount: number;
        rows: Array<{ generatedColumns?: string[]; defaultColumns?: string[] }>;
      };
      assert.equal(preview.rowCount, 1);
      assert.equal(preview.rows.length, 1);
      if (plan.operation === "insert") {
        assert.ok(preview.rows[0]?.generatedColumns?.includes("id"));
        assert.ok(preview.rows[0]?.defaultColumns?.includes("tenant"));
      }
      const confirmation = {
        confirmationId: randomUUID(),
        previewId: preview.previewId,
        commitment: preview.commitment,
        revision: preview.revision,
      };
      const registered = await request(`/previews/${preview.previewId}/confirm`, confirmation);
      assert.equal(registered.status, 202);
      let execution = (await registered.json()) as PublicMutationExecution;
      assert.ok(execution.executionId);
      for (
        let count = 0;
        count < 100 &&
        !["committed", "rolled_back", "rejected", "outcome_unknown"].includes(execution.state);
        count++
      ) {
        await delay(60);
        const status = await request(`/executions/${execution.executionId}`);
        assert.equal(status.status, 200);
        execution = (await status.json()) as PublicMutationExecution;
      }
      assert.equal(execution.state, "committed", JSON.stringify(execution));
      assert.equal(execution.affectedRows, 1);
      assert.equal("sessionId" in execution, false);
      const duplicate = await request(`/previews/${preview.previewId}/confirm`, confirmation);
      assert.equal(duplicate.status, 202);
      assert.equal(
        ((await duplicate.json()) as PublicMutationExecution).executionId,
        execution.executionId,
      );
      executions.push(execution);
    }
    const recovery = await request("/recovery", {});
    assert.equal(recovery.status, 200);
    const result = (await recovery.json()) as {
      items: PublicMutationExecution[];
      recoveredReceipts: unknown[];
    };
    assert.equal(result.items.length, 3);
    assert.ok(result.items.every((item) => item.state === "committed"));
    assert.deepEqual(result.recoveredReceipts, []);
    assert.deepEqual(
      new Set(result.items.map((item) => item.executionId)),
      new Set(executions.map((item) => item.executionId)),
    );
    const signedOut = await fetch(`${base}/api/auth/sign-out`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(signedOut.status, 200);
    assert.equal((await request("/capability")).status, 401);
  } finally {
    child.stdin.write('{"stop":true}\n');
    const status = await Promise.race([
      exited,
      delay(10_000, undefined, { ref: false }).then(() => {
        child.kill();
        return -1;
      }),
    ]);
    channel.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await registry.close();
    await fixture.close();
    const owned = resolve(directory);
    assert.ok(
      (await realpath(owned)) === owned &&
        dirname(owned) === (await realpath(tmpdir())) &&
        basename(owned).startsWith("g3-mutation-wire-"),
      "fixture cleanup ownership mismatch",
    );
    await rm(owned, { recursive: true, force: true });
    assert.equal(status, 0, error);
    assert.ok(
      events.some(
        (value) =>
          value &&
          typeof value === "object" &&
          "done" in value &&
          value.done === true &&
          "rows" in value &&
          value.rows === 1,
      ),
    );
  }
});
