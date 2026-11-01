/** Explicit, temporary G3 browser composition. Never imported by main or normal tests. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import { ConnectorRegistry } from "../src/connectors/registry.js";
import { mountConnectorRoutes } from "../src/connectors/routes.js";
import {
  ConnectorMutationTransport,
  mountMutationAgentRoutes,
} from "../src/mutations/connector-transport.js";
import { MutationError } from "../src/mutations/model.js";
import type { MutationAccess } from "../src/mutations/ports.js";
import { mountMutationRoutes } from "../src/mutations/routes.js";
import { MutationService } from "../src/mutations/service.js";
import { mutationFixture } from "./mutation-fixture.js";

if (process.env.STAGE8_G3_REVIEW !== "1" || process.env.STAGE8_G3_TEST !== "1")
  throw Error("explicit isolated review flags required");
const fixture = await mutationFixture();
const directory = await mkdtemp(join(tmpdir(), "g3-mutation-browser-"));
const registry = await ConnectorRegistry.open(
  join(directory, "registry.json"),
  randomBytes(32).toString("hex"),
);
const cookie = `g3-review=${randomBytes(32).toString("hex")}`;
const apiPort = Number(process.env.G3_REVIEW_API_PORT ?? "43128");
const webPort = Number(process.env.G3_REVIEW_WEB_PORT ?? "5192");
if (
  ![apiPort, webPort].every((value) => Number.isInteger(value) && value >= 1024 && value <= 65535)
)
  throw Error("invalid isolated review ports");
const origin = `http://127.0.0.1:${webPort}`;
const access: MutationAccess = {
  async authenticate(headers) {
    return headers.cookie
      ?.split(";")
      .map((value) => value.trim())
      .includes(cookie)
      ? { ownerId: fixture.binding.ownerId, sessionId: fixture.sessionId }
      : undefined;
  },
  async withScope(scope, action) {
    if (
      scope.ownerId !== fixture.binding.ownerId ||
      scope.workspaceId !== fixture.binding.workspaceId ||
      scope.sourceId !== fixture.binding.sourceId
    )
      throw new MutationError("NOT_FOUND");
    const result = await registry.withActiveOwner(
      scope.ownerId,
      fixture.binding.connectorId,
      async () => ({ value: await action(fixture.binding) }),
    );
    if (!result) throw new MutationError("NOT_FOUND");
    return result.value;
  },
};
const channel = new ConnectorMutationTransport(registry, access);
const service = new MutationService(
  fixture.store,
  access,
  channel,
  { sign: async (payload) => registry.signMutationPermit(payload) },
  { enabled: true, executionEnabled: false },
);
const application = express();
application.get("/api/g3-review/context", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Set-Cookie", `${cookie}; HttpOnly; SameSite=Strict; Path=/`);
  res.json({
    workspaceId: fixture.binding.workspaceId,
    sourceId: fixture.binding.sourceId,
    sourceName: "G3 独立测试库 · orders",
  });
});
mountMutationAgentRoutes(application, registry, channel, service);
mountConnectorRoutes(application, registry, origin, async () => fixture.binding.ownerId);
mountMutationRoutes(application, origin, access, service);
const server = application.listen(apiPort, "127.0.0.1");
await once(server, "listening");
const offer = await registry.createPairing(fixture.binding.ownerId);
const child = spawn("go", ["run", "./testdata/mutation-probe"], {
  cwd: fileURLToPath(new URL("../../../../connector/go/", import.meta.url)),
  env: { ...process.env, GOARCH: "amd64" },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let diagnostic = "";
child.stderr.on("data", (chunk) => {
  diagnostic += String(chunk);
});
child.stdin.on("error", () => {});
const lines = createInterface({ input: child.stdout });
const exited = new Promise<number | null>((done) => child.once("exit", done));
let ready!: (id: string) => void;
const readiness = new Promise<string>((yes, no) => {
  ready = yes;
  child.once("error", no);
  child.once("exit", () => no(Error(`isolated review probe exited: ${diagnostic}`)));
});
lines.on("line", (line) => {
  try {
    const event: unknown = JSON.parse(line);
    if (
      event &&
      typeof event === "object" &&
      "ready" in event &&
      event.ready === true &&
      "connectorId" in event &&
      typeof event.connectorId === "string"
    )
      ready(event.connectorId);
  } catch {}
});
child.stdin.write(
  `${JSON.stringify({ server: `http://127.0.0.1:${apiPort}`, code: `${offer.pairingId}.${offer.secret}.${offer.platformPublicKey}`, ownerId: fixture.binding.ownerId, workspaceId: fixture.binding.workspaceId, sourceId: fixture.binding.sourceId })}\n`,
);
try {
  fixture.binding.connectorId = await Promise.race([
    readiness,
    delay(45_000, undefined, { ref: false }).then(() => {
      throw Error("isolated review readiness timed out");
    }),
  ]);
  await fixture.pool.execute("UPDATE data_source SET connectorId=? WHERE id=?", [
    fixture.binding.connectorId,
    fixture.binding.sourceId,
  ]);
  child.stdin.write('{"run":true}\n');
  process.stdout.write(
    `G3 isolated component review ready: API ${apiPort}; web ${webPort}; execution disabled. Send stop to finish.\n`,
  );
  const input = createInterface({ input: process.stdin });
  await Promise.race([
    once(input, "line"),
    once(process, "SIGINT"),
    exited.then(() => {
      throw Error(`isolated review Connector exited: ${diagnostic}`);
    }),
    delay(15 * 60_000, undefined, { ref: false }),
  ]);
  input.close();
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
  await new Promise<void>((done) => server.close(() => done()));
  await registry.close();
  await fixture.close();
  const owned = resolve(directory);
  assert.ok(
    (await realpath(owned)) === owned &&
      dirname(owned) === (await realpath(tmpdir())) &&
      basename(owned).startsWith("g3-mutation-browser-"),
    "review cleanup ownership mismatch",
  );
  await rm(owned, { recursive: true, force: true });
  assert.equal(status, 0, diagnostic);
  process.stdout.write("G3 isolated review fixture cleaned.\n");
}
