/** Test-only real HTTP process. Initialization and fault barriers use private IPC. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { createAuth, authMutationIdentity, authSessionReferenceActive } from "../../src/auth.js";
import { ConnectorRegistry } from "../../src/connectors/registry.js";
import { mountConnectorRoutes } from "../../src/connectors/routes.js";
import { DataSourceStore } from "../../src/datasources/store.js";
import { ScopeCoordinator } from "../../src/datasources/scope-coordinator.js";
import { mountDataSourceRoutes } from "../../src/datasources/routes.js";
import { mountHistoryRoutes } from "../../src/history/routes.js";
import { HistoryStore } from "../../src/history/store.js";
import { mountProductRoutes } from "../../src/product-routes.js";
import {
  ConnectorMutationTransport,
  mountMutationAgentRoutes,
} from "../../src/mutations/connector-transport.js";
import { MutationService } from "../../src/mutations/service.js";
import { MutationStore } from "../../src/mutations/store.js";
import { mountMutationRoutes } from "../../src/mutations/routes.js";
import { isolatedMysql } from "../isolated-mysql.js";

export interface RuntimeConfig {
  database: string;
  directory: string;
  secret: string;
  origin: string;
  port: number;
  ownerId: string;
  workspaceId: string;
  sourceId: string;
}
type Command = { id: number; action: string; data?: unknown };
if (process.env.STAGE8_G4_ACCEPTANCE !== "1" || !process.send)
  throw Error("explicit isolated acceptance IPC required");
const send = (value: unknown) => process.send?.(value);
const [message] = await once(process, "message");
const config = message as RuntimeConfig;
assert.match(config.database, /^g3_mut_api_[0-9a-f]{16}$/);
assert.equal(config.origin, "http://127.0.0.2:5193");
assert.equal(config.port, 43129);
const isolated = await isolatedMysql();
const pool = isolated.pool(config.database);
const registry = await ConnectorRegistry.open(`${config.directory}/registry.json`, config.secret);
const auth = createAuth(
  {
    databaseUrl: "mysql://unused:unused@127.0.0.1:13308/unused",
    secret: config.secret,
    origin: config.origin,
  },
  pool,
);
const sources = new DataSourceStore(pool);
const history = new HistoryStore(pool, sources);
const coordinator = new ScopeCoordinator(sources, registry);
const access = {
  authenticate: authMutationIdentity(auth),
  withScope: coordinator.withScope.bind(coordinator),
};
const store = new MutationStore(
  pool,
  sources,
  randomBytes(32).toString("hex"),
  authSessionReferenceActive,
);
const channel = new ConnectorMutationTransport(registry, access);
const service = new MutationService(
  store,
  access,
  channel,
  { sign: async (payload) => registry.signMutationPermit(payload) },
  { enabled: true, executionEnabled: true },
);
channel.onExecutionResult((binding, execution, outcome) =>
  service.result(binding, execution.executionId, outcome).then(() => {}),
);
let fault = "";
let release: (() => void) | undefined;
const app = express();
app.use(async (req, res, next) => {
  if (fault === "heartbeat-drop" && req.path === "/api/connector-agent/heartbeat") {
    fault = "";
    send({ barrier: "heartbeat-drop" });
    res.socket?.destroy();
    return;
  }
  if (fault === "confirm-drop" && /\/previews\/[^/]+\/confirm$/.test(req.path)) {
    fault = "";
    res.json = (() => {
      send({ barrier: "confirm-drop" });
      res.socket?.destroy();
      return res;
    }) as typeof res.json;
  }
  const point = fault === "permit-hold" ? "/permit" : fault === "result-hold" ? "/result" : "";
  if (point && req.path === `/api/connector-agent/mutations${point}`) {
    const barrier = fault;
    fault = "";
    await new Promise<void>((resolve) => {
      release = resolve;
      send({ barrier });
    });
    release = undefined;
  }
  next();
});
mountProductRoutes(app, auth, pool, config.origin);
mountMutationAgentRoutes(app, registry, channel, service);
const owner = async (headers: Parameters<typeof access.authenticate>[0]) =>
  (await access.authenticate(headers))?.ownerId;
mountConnectorRoutes(app, registry, config.origin, owner);
mountDataSourceRoutes(app, sources, registry, config.origin, owner, coordinator);
mountHistoryRoutes(app, owner, config.origin, history, undefined);
mountMutationRoutes(app, config.origin, access, service);
const server = app.listen(config.port, "127.0.0.1");
await once(server, "listening");
send({ ready: true });
process.on("message", (command: Command) => {
  void (async () => {
    let result: unknown;
    if (command.action === "pair") result = await registry.createPairing(config.ownerId);
    else if (command.action === "signup")
      result = await auth.api.signUpEmail({
        body: command.data as { name: string; username: string; email: string; password: string },
      });
    else if (command.action === "arm") {
      assert.ok(
        ["confirm-drop", "permit-hold", "result-hold", "heartbeat-drop"].includes(
          String(command.data),
        ),
      );
      fault = String(command.data);
    } else if (command.action === "release") release?.();
    else if (command.action === "flush-audit") {
      await store.flushAudit({
        append: (scope, id, event, executionId) =>
          history.appendAudit(scope.ownerId, scope, { event, executionId, outcome: "success" }, id),
      });
    } else if (command.action === "offline") {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } else if (command.action === "online") {
      server.listen(config.port, "127.0.0.1");
      await once(server, "listening");
    } else throw Error("unknown acceptance command");
    send({ id: command.id, result });
  })().catch(() => send({ id: command.id, error: "G4_COMMAND_FAILED" }));
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  process.stderr.write("G4_CLOSE_BEGIN\n");
  release?.();
  channel.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.stderr.write("G4_CLOSE_HTTP_DONE\n");
  await registry.close();
  process.stderr.write("G4_CLOSE_REGISTRY_DONE\n");
  await pool.end();
  process.stderr.write("G4_CLOSE_POOL_DONE\n");
  process.exit(0);
}
process.once("disconnect", () => {
  void close();
});
