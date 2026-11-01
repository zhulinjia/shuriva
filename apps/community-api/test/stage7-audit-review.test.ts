import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { request as httpRequest } from "node:http";
import express from "express";
import type { ConnectorRegistry } from "../src/connectors/registry.js";
import { mountConnectorRoutes } from "../src/connectors/routes.js";
import { AuditTrail } from "../src/history/audit.js";
import type { AuditEntry } from "../src/history/model.js";
import type { HistoryStore } from "../src/history/store.js";
import { declareRequestAudit } from "../src/history/public.js";

test("audit queue retries DB failures with fixed scoped events and classifies model check and GET denial accurately", async () => {
  const entries: Array<{ owner: string; scope: unknown; entry: AuditEntry }> = [];
  let unavailable = true;
  const trail = new AuditTrail({
    appendAudit: async (owner: string, scope: unknown, entry: AuditEntry) => {
      if (unavailable) throw new Error("fixture database outage");
      entries.push({ owner, scope, entry });
    },
  } as unknown as HistoryStore);
  const app = express();
  trail.install(app, async () => "owner");
  const workspace = randomUUID(),
    source = randomUUID();
  app.post("/api/model/check", (_req, res) => {
    declareRequestAudit(res, "model.checked");
    res.json({ available: true });
  });
  app.get("/api/data-sources/workspaces/:workspace/:source/private-business-path", (req, res) => {
    declareRequestAudit(res, "security.denied", {
      workspaceId: req.params.workspace,
      sourceId: req.params.source,
    });
    res.status(403).end();
  });
  const server = app.listen(0, "127.0.0.1");
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/api/model/check`, { method: "POST" })).status, 200);
    assert.equal(
      (
        await fetch(
          `${base}/api/data-sources/workspaces/${workspace}/${source}/private-business-path?secret=business`,
        )
      ).status,
      403,
    );
    await trail.flush();
    assert.equal(entries.length, 0);
    unavailable = false;
    await trail.flush();
    assert.deepEqual(
      entries.map((item) => item.entry),
      [
        { event: "model.checked", outcome: "success" },
        {
          event: "security.denied",
          outcome: "denied",
          attemptedWorkspaceId: workspace,
          attemptedSourceId: source,
        },
      ],
    );
    assert.equal(entries[1]?.scope, null);
    assert.doesNotMatch(
      JSON.stringify(entries),
      /private-business-path|secret|business|headers|path/,
    );
  } finally {
    trail.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("committed pair, rotation and diagnostic operations retain protocol acknowledgements when audit hook fails", async () => {
  const operations: string[] = [];
  const registry = {
    pair: async () => {
      operations.push("pair");
    },
    rotate: async () => {
      operations.push("rotate");
    },
    completeDiagnostic: async () => {
      operations.push("result");
    },
    auditOwner: async () => "owner",
    pairAcknowledgement: () => "pair-ack",
    acknowledgement: () => "rotation-ack",
    resultAcknowledgement: () => "result-ack",
  } as unknown as ConnectorRegistry;
  const app = express();
  mountConnectorRoutes(
    app,
    registry,
    "http://localhost:5177",
    async () => undefined,
    undefined,
    undefined,
    async () => {
      throw new Error("fixture audit outage");
    },
  );
  const server = app.listen(0, "127.0.0.1");
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/connector-agent`;
    const signed = {
      connectorId: randomUUID(),
      agentVersion: "fixture",
      nonce: "nonce",
      signature: "signature",
      protocol: 1,
      timestamp: 1,
    };
    const requests = [
      {
        path: "pair",
        body: {
          pairingId: randomUUID(),
          proof: "proof",
          connectorId: signed.connectorId,
          name: "fixture",
          publicKey: "key",
          agentVersion: "fixture",
          signature: "pair-signature",
          protocol: 2,
        },
        ack: "pair-ack",
      },
      { path: "rotate", body: { ...signed, newPublicKey: "next-key" }, ack: "rotation-ack" },
      {
        path: "result",
        body: { ...signed, taskId: randomUUID(), outcome: "ok" },
        ack: "result-ack",
      },
    ];
    for (const request of requests) {
      // A connector uses HTTP, not the browser Fetch API's forbidden-port
      // list; an ephemeral listener may legitimately receive one of those ports.
      const response = await new Promise<{ status?: number; body: unknown }>((resolve, reject) => {
        const outgoing = httpRequest(
          `${base}/${request.path}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
            incoming.on("error", reject);
            incoming.on("end", () => {
              try {
                resolve({
                  status: incoming.statusCode,
                  body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
                });
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        outgoing.setTimeout(5000, () => outgoing.destroy(new Error("synthetic peer timeout")));
        outgoing.on("error", reject);
        outgoing.end(JSON.stringify(request.body));
      });
      assert.equal(response.status, 200);
      assert.equal((response.body as { signature: string }).signature, request.ack);
    }
    assert.deepEqual(operations, ["pair", "rotate", "result"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
