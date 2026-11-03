import { declareRequestAudit, declareRequestAuditContext } from "../history/public.js";
import { type SchemaResult, type SchemaTask, schemaResultBodyFields } from "./schema-protocol.js";
import { signedMessageBodyFields } from "./identity-protocol.js";
import { createHash } from "node:crypto";
import { diagnostics } from "../logging/public.js";
import { fromNodeHeaders } from "better-auth/node";
import express, { type ErrorRequestHandler, type Express, type Response } from "express";
import type { Auth } from "../auth.js";
import { type ReadResult, readResultBodyFields } from "../protocol/read-task.js";
import type { ConnectorRead } from "../queries/public.js";
import { ConnectorError } from "./errors.js";
import { installHttpResponseLease } from "../http-response-lease.js";
import type {
  ConnectorRegistry,
  HeartbeatInput,
  PairInput,
  ResultInput,
  RotateInput,
} from "./registry.js";

type ObjectBody = Record<string, unknown>;
async function publishReadResponse(
  res: Response,
  body: unknown,
  assertActive: () => void,
  signal?: AbortSignal,
) {
  signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5000)]);
  const dispose = installHttpResponseLease(res, assertActive, signal);
  const serialized = JSON.stringify(body);
  const finished = new Promise<void>((resolve) => {
    res.once("finish", resolve);
    res.once("close", resolve);
  });
  const abort = () => res.destroy();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (res.destroyed) throw new ConnectorError("DENIED");
    signal?.throwIfAborted();
    assertActive();
    res.type("application/json").send(serialized);
    await finished;
  } finally {
    dispose();
    signal?.removeEventListener("abort", abort);
  }
}
function object(value: unknown): value is ObjectBody {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function strings(body: ObjectBody, fields: readonly string[]): boolean {
  return fields.every((key) => typeof body[key] === "string");
}
const signedFields = signedMessageBodyFields;
function exact(body: ObjectBody, fields: readonly string[]): boolean {
  return (
    Object.keys(body).length === fields.length && fields.every((key) => Object.hasOwn(body, key))
  );
}
function signed(body: unknown, rotating = false): body is ObjectBody & HeartbeatInput {
  return (
    object(body) &&
    exact(body, rotating ? [...signedFields, "newPublicKey"] : signedFields) &&
    strings(body, ["connectorId", "agentVersion", "nonce", "signature"]) &&
    typeof body.protocol === "number" &&
    typeof body.timestamp === "number"
  );
}
function pair(body: unknown): body is ObjectBody & PairInput {
  const fields = [
    "pairingId",
    "proof",
    "connectorId",
    "name",
    "publicKey",
    "agentVersion",
    "signature",
  ];
  return (
    object(body) &&
    exact(body, [...fields, "protocol"]) &&
    strings(body, fields) &&
    typeof body.protocol === "number"
  );
}
function rotate(body: unknown): body is ObjectBody & RotateInput {
  return signed(body, true) && typeof body.newPublicKey === "string";
}

function result(body: unknown): body is ObjectBody & ResultInput {
  return (
    object(body) &&
    exact(body, [...signedFields, "taskId", "outcome"]) &&
    strings(body, ["connectorId", "agentVersion", "nonce", "signature", "taskId", "outcome"]) &&
    typeof body.protocol === "number" &&
    typeof body.timestamp === "number" &&
    body.outcome === "ok"
  );
}
function schemaResult(body: unknown): body is ObjectBody & SchemaResult {
  return (
    object(body) &&
    exact(body, schemaResultBodyFields) &&
    strings(
      body,
      schemaResultBodyFields.filter((field) => field !== "protocol" && field !== "timestamp"),
    ) &&
    typeof body.protocol === "number" &&
    typeof body.timestamp === "number" &&
    (body.outcome === "ok" || body.outcome === "failed")
  );
}

function readResult(body: unknown): body is ObjectBody & ReadResult {
  const fields = readResultBodyFields;
  return (
    object(body) &&
    exact(body, fields) &&
    strings(
      body,
      fields.filter((field) => field !== "timestamp"),
    ) &&
    typeof body.timestamp === "number" &&
    (body.outcome === "ok" || body.outcome === "failed")
  );
}

// Only identical credentials/signatures share a bucket. A forged connector ID
// cannot exhaust an authenticated connector's future (fresh nonce) requests.
function duplicateLimiter() {
  const buckets = new Map<string, { count: number; expiresAt: number }>();
  return (operation: string, fingerprint: string): boolean => {
    const now = Date.now();
    const key = createHash("sha256")
      .update(operation)
      .update("\0")
      .update(fingerprint)
      .digest("hex");
    let bucket = buckets.get(key);
    if (bucket && bucket.expiresAt <= now) {
      buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket) {
      // The cache is deliberately bounded: eviction never blocks new identities.
      if (buckets.size >= 4096) {
        const oldest = buckets.keys().next().value;
        if (oldest !== undefined) buckets.delete(oldest);
      }
      bucket = { count: 0, expiresAt: now + 60_000 };
      buckets.set(key, bucket);
    }
    return ++bucket.count <= 30;
  };
}

export type AuthenticateOwner = (
  headers: import("node:http").IncomingHttpHeaders,
) => Promise<string | undefined>;
export interface ScanHooks {
  next(connectorId: string): Promise<SchemaTask | null>;
  result(input: SchemaResult): Promise<string>;
}
export function mountConnectorRoutes(
  server: Express,
  registry: ConnectorRegistry,
  origin: string,
  owner: AuthenticateOwner,
  scan?: ScanHooks,
  read?: ConnectorRead,
  audit?: (
    ownerId: string,
    event: "connection.paired" | "connection.rotated" | "connection.checked",
    connectorId: string,
  ) => void | Promise<void>,
): void {
  const recordAgentAudit = async (
    connectorId: string,
    event: "connection.paired" | "connection.rotated" | "connection.checked",
  ) => {
    if (!audit) return;
    try {
      const actor = await registry.auditOwner(connectorId);
      if (actor) await audit(actor, event, connectorId);
    } catch (error) {
      diagnostics.error("connector.audit_unavailable", { connectorId }, error);
    }
  };
  const api = express.Router();
  api.use("/:id", (req, res, next) => {
    declareRequestAuditContext(res, { connectorId: req.params.id });
    next();
  });
  api.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET" && req.headers.origin !== origin) {
      res.status(403).json({ error: "请求来源无效" });
      return;
    }
    next();
  });
  api.use(express.json({ limit: "8kb" }));
  api.get("/", async (req, res) => {
    const id = await owner(req.headers);
    if (!id) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    res.json({ connectors: await registry.list(id) });
  });
  api.post("/pairings", async (req, res) => {
    declareRequestAudit(res, "connection.pairing_created");
    const id = await owner(req.headers);
    if (!id) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    res.status(201).json(await registry.createPairing(id));
  });
  api.post("/:id/diagnostics", async (req, res) => {
    declareRequestAudit(res, "connection.check_requested", { connectorId: req.params.id });
    const id = await owner(req.headers);
    if (!id) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    await registry.createDiagnostic(id, req.params.id);
    res.status(201).json({ ok: true });
  });
  api.post("/:id/revoke", async (req, res) => {
    declareRequestAudit(res, "connection.revoked", { connectorId: req.params.id });
    const id = await owner(req.headers);
    if (!id) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    await registry.revoke(id, req.params.id);
    read?.invalidateConnector(id, req.params.id);
    read?.jobs.revokeConnector(id, req.params.id);
    res.json({ ok: true });
  });
  const agent = express.Router();
  const allowDuplicate = duplicateLimiter();
  agent.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  const smallJson = express.json({ limit: "8kb" });
  const scanJson = express.json({ limit: "1500kb" });
  agent.use((req, res, next) =>
    ((req.path === "/scan-result" && scan) || (req.path === "/read-result" && read)
      ? scanJson
      : smallJson)(req, res, next),
  );
  agent.post("/pair", async (req, res) => {
    if (!pair(req.body)) throw new ConnectorError("INVALID");
    if (!allowDuplicate("pair", req.body.proof)) {
      res.status(429).json({ error: "请求过于频繁" });
      return;
    }
    await registry.pair(req.body);
    await recordAgentAudit(req.body.connectorId, "connection.paired");
    res.json({ ok: true, protocol: 2, signature: registry.pairAcknowledgement(req.body) });
  });
  agent.post("/probe", async (req, res) => {
    if (!signed(req.body)) throw new ConnectorError("INVALID");
    if (!allowDuplicate("probe", req.body.signature)) {
      res.status(429).json({ error: "请求过于频繁" });
      return;
    }
    await registry.probe(req.body);
    res.json({ ok: true, protocol: 1, signature: registry.acknowledgement("probe", req.body) });
  });
  agent.post("/heartbeat", async (req, res) => {
    if (!signed(req.body)) throw new ConnectorError("INVALID");
    if (!allowDuplicate("heartbeat", req.body.signature)) {
      res.status(429).json({ error: "请求过于频繁" });
      return;
    }
    const diagnostic = await registry.heartbeat(req.body);
    const readTask = read
      ? await read.next(req.body.connectorId, async (task, assertActive, signal) => {
          await publishReadResponse(
            res,
            {
              ok: true,
              protocol: 1,
              signature: registry.acknowledgement("heartbeat", req.body),
              task,
            },
            assertActive,
            signal,
          );
        })
      : null;
    if (res.headersSent || res.destroyed) return;
    const task =
      readTask ??
      (read?.jobs.busy(req.body.connectorId)
        ? null
        : (diagnostic ?? (scan ? await scan.next(req.body.connectorId) : null)));
    res.json({
      ok: true,
      protocol: 1,
      signature: registry.acknowledgement("heartbeat", req.body),
      task,
    });
  });
  agent.post("/rotate", async (req, res) => {
    if (!rotate(req.body)) throw new ConnectorError("INVALID");
    if (!allowDuplicate("rotate", req.body.signature)) {
      res.status(429).json({ error: "请求过于频繁" });
      return;
    }
    await registry.rotate(req.body);
    await recordAgentAudit(req.body.connectorId, "connection.rotated");
    res.json({ ok: true, protocol: 1, signature: registry.acknowledgement("rotate", req.body) });
  });
  agent.post("/result", async (req, res) => {
    if (!result(req.body)) throw new ConnectorError("INVALID");
    if (!allowDuplicate("result", req.body.signature)) {
      res.status(429).json({ error: "请求过于频繁" });
      return;
    }
    await registry.completeDiagnostic(req.body);
    await recordAgentAudit(req.body.connectorId, "connection.checked");
    res.json({ ok: true, protocol: 1, signature: registry.resultAcknowledgement(req.body) });
  });
  agent.post("/scan-result", async (req, res) => {
    if (!scan) {
      res.sendStatus(404);
      return;
    }
    if (!schemaResult(req.body)) throw new ConnectorError("INVALID");
    if (!allowDuplicate("scan-result", req.body.signature)) {
      res.status(429).json({ error: "请求过于频繁" });
      return;
    }
    const signature = await scan.result(req.body);
    res.json({ ok: true, protocol: 2, signature });
  });
  agent.post("/read-result", async (req, res) => {
    if (!read) {
      res.sendStatus(404);
      return;
    }
    if (!readResult(req.body)) throw new ConnectorError("INVALID");
    if (!allowDuplicate("read-result", req.body.signature)) {
      res.status(429).json({ error: "请求过于频繁" });
      return;
    }
    const signature = await read.result(req.body);
    res.json({ ok: true, protocol: 1, signature });
  });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof ConnectorError) {
      const status =
        error.code === "INVALID"
          ? 400
          : error.code === "TASK_GONE"
            ? 409
            : error.code === "NOT_FOUND"
              ? 404
              : error.code === "CAPACITY"
                ? 503
                : error.code === "INCOMPATIBLE"
                  ? 426
                  : 403;
      res.status(status).json({ error: error.code });
      return;
    }
    const kind = error && typeof error === "object" && "type" in error ? error.type : undefined;
    if (kind === "entity.parse.failed" || kind === "entity.too.large") {
      res.status(kind === "entity.too.large" ? 413 : 400).json({ error: "INVALID" });
      return;
    }
    diagnostics.error("connector.request_failed", {}, error);
    res.status(500).json({ error: "UNAVAILABLE" });
  };
  api.use(errors);
  agent.use(errors);
  server.use("/api/connectors", api);
  server.use("/api/connector-agent", agent);
}
export function authOwner(auth: Auth): AuthenticateOwner {
  return async (headers) =>
    (await auth.api.getSession({ headers: fromNodeHeaders(headers) }))?.user.id;
}
