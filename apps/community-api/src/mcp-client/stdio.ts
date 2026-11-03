import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import { type Credentials, ExternalMcpError } from "./model.js";
import { NativeStdioTransport } from "./native-stdio.js";
import { type InstalledProgram, noLinks, privateDirectory } from "./programs.js";
import { openOwnedJob, pinExecutable } from "./windows-files.js";

export async function ownedStdio(
  program: InstalledProgram,
  credentials: Credentials,
  runRoot: string,
  guard: (
    send: (check: () => void, signal: AbortSignal, remainingMs?: () => number) => Promise<void>,
  ) => Promise<void>,
  onHandoff: (message: JSONRPCMessage) => void = () => {},
) {
  const unpin = await pinExecutable(program.host, program.hostHash);
  try {
    return await pinnedStdio(program, credentials, runRoot, guard, unpin, onHandoff);
  } catch (error) {
    unpin();
    throw error;
  }
}
async function pinnedStdio(
  program: InstalledProgram,
  credentials: Credentials,
  runRoot: string,
  guard: (
    send: (check: () => void, signal: AbortSignal, remainingMs?: () => number) => Promise<void>,
  ) => Promise<void>,
  unpin: () => void,
  onHandoff: (message: JSONRPCMessage) => void,
) {
  const secrets = credentials.environment ?? {};
  if (Object.keys(secrets).some((k) => !program.secretEnvironment.includes(k)))
    throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_ENV_REJECTED");
  await mkdir(dirname(runRoot), { recursive: true });
  await privateDirectory(runRoot, program.host);
  const run = join(runRoot, randomUUID());
  const jobName = `Local\\Shuriva-MCP-${basename(run)}`;
  await privateDirectory(run, program.host, true);
  const env: Record<string, string> = {};
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_UNSUPPORTED", 503);
  env.SYSTEMROOT = systemRoot;
  env.SHURIVA_MCP_ENV = JSON.stringify(secrets);
  let job: Awaited<ReturnType<typeof openOwnedJob>> | undefined;
  let controlFailed = false,
    startAttempted = false,
    spawnFailed = false;
  const terminate = () => {
    try {
      job?.terminate();
    } catch {
      controlFailed = true;
    }
  };
  const transport = new NativeStdioTransport(
    {
      command: program.host,
      args: [
        "--manifest",
        program.manifest,
        "--digest",
        program.manifestHash,
        "--node",
        program.node,
        "--node-digest",
        program.nodeHash,
        "--run-directory",
        run,
        "--job-name",
        jobName,
      ],
      cwd: run,
      env,
    },
    () => {
      terminate();
      try {
        job?.close();
      } catch {
        controlFailed = true;
      }
    },
  );
  let failure = "EXTERNAL_MCP_PROGRAM_START_FAILED";
  transport.stderr?.on("data", (part: Buffer) => {
    const line = part.toString("ascii").trim();
    if (
      [
        "CONFIG",
        "MANIFEST",
        "PACKAGE_INTEGRITY",
        "RUNTIME_INTEGRITY",
        "ENVIRONMENT",
        "OWNERSHIP",
        "PIPES",
        "PROCESS_CREATE",
        "PROCESS_ASSIGN",
      ].some((stage) => line === `MCP_HOST_${stage}_FAILED`)
    )
      failure = line;
  });
  const send = transport.send.bind(transport);
  let sequence = 0,
    queued = 0,
    tail = Promise.resolve();
  transport.send = async (message: JSONRPCMessage) => {
    if (queued >= 4 || sequence >= 100000)
      throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_INPUT_BUSY", 409);
    queued++;
    const previous = tail;
    let release: () => void = () => {};
    const completed = new Promise<void>((r) => {
      release = r;
    });
    tail = previous.then(() => completed);
    const nonce = randomUUID();
    let permit: string | undefined,
      ack: string | undefined,
      admitted = false;
    try {
      await guard(async (check, signal, remainingMs) => {
        admitted = true;
        const lost = () => terminate();
        signal.addEventListener("abort", lost, { once: true });
        try {
          await previous;
          check();
          signal.throwIfAborted();
          if (closed || !job) throw new ExternalMcpError("EXTERNAL_MCP_CLOSED", 503);
          const n = ++sequence;
          permit = join(run, `send-${n}.json`);
          ack = join(run, `sent-${n}`);
          const budget = Math.floor(Math.min(4500, (remainingMs?.() ?? 5000) - 200));
          if (budget < 50) throw new ExternalMcpError("EXTERNAL_MCP_AUTH_EXPIRED", 403);
          await writeFile(permit, JSON.stringify({ nonce, expiresAt: Date.now() + budget }), {
            flag: "wx",
            mode: 0o600,
          });
          check();
          signal.throwIfAborted();
          onHandoff(message);
          await send(message);
          const end = performance.now() + budget;
          while (performance.now() < end) {
            check();
            signal.throwIfAborted();
            try {
              if ((await readFile(ack, "utf8")) === nonce) return;
            } catch {}
            await new Promise((r) => setTimeout(r, 10));
          }
          throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_FORWARD_TIMEOUT", 503);
        } finally {
          signal.removeEventListener("abort", lost);
        }
      });
    } catch (error) {
      if (admitted) {
        terminate();
        await writeFile(join(run, "stop"), "stop", { flag: "wx", mode: 0o600 }).catch(() => {});
      }
      throw error;
    } finally {
      try {
        await Promise.all([
          ...(permit ? [rm(permit, { force: true })] : []),
          ...(ack ? [rm(ack, { force: true })] : []),
        ]);
      } finally {
        queued--;
        release();
      }
    }
  };
  let closed = false,
    closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      if (closed) return;
      closed = true;
      terminate();
      let acknowledged = false;
      try {
        if (!startAttempted || spawnFailed) acknowledged = true;
        await noLinks(run);
        await writeFile(join(run, "stop"), "stop", { flag: "wx", mode: 0o600 }).catch((error) => {
          if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
            throw error;
        });
        for (let i = 0; i < 80 && !acknowledged; i++) {
          if (spawnFailed) {
            acknowledged = true;
            break;
          }
          try {
            acknowledged = (await readFile(join(run, "closed"), "utf8")) === "MCP_HOST_CLEANED";
          } catch {}
          if (acknowledged) break;
          await new Promise((r) => setTimeout(r, 50));
        }
      } finally {
        env.SHURIVA_MCP_ENV = "";
        try {
          await transport.close();
        } finally {
          try {
            job?.close();
          } catch {
            controlFailed = true;
          }
          unpin();
        }
      }
      if (!acknowledged || controlFailed)
        throw new ExternalMcpError("EXTERNAL_MCP_PROCESS_CLEANUP_UNKNOWN", 503);
      const owned = await realpath(run);
      if (dirname(owned).toLowerCase() !== resolve(runRoot).toLowerCase())
        throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_CLEANUP_REJECTED");
      await rm(owned, { recursive: true, force: true });
    })();
    return closing;
  };
  const start = transport.start.bind(transport);
  transport.start = () =>
    guard(async (check, signal, remainingMs) => {
      const lost = () => terminate();
      signal.addEventListener("abort", lost, { once: true });
      try {
        check();
        if (closed) throw new ExternalMcpError("EXTERNAL_MCP_CLOSED", 503);
        startAttempted = true;
        try {
          await start();
        } catch (error) {
          if (!transport.pid && !job) spawnFailed = true;
          throw error;
        }
        const until = performance.now() + 4000;
        for (const [file, expected] of [
          ["ready", "MCP_HOST_READY"],
          ["started", "MCP_HOST_STARTED"],
        ] as const) {
          let found = false;
          while (performance.now() < until) {
            check();
            signal.throwIfAborted();
            try {
              if ((await readFile(join(run, file), "utf8")) === expected) {
                found = true;
                break;
              }
            } catch {}
            await new Promise((r) => setTimeout(r, 10));
          }
          if (!found) throw new ExternalMcpError(failure, 503);
          if (file === "ready") {
            if (closed) throw new ExternalMcpError("EXTERNAL_MCP_CLOSED", 503);
            job = await openOwnedJob(jobName);
            if (closed) {
              terminate();
              job.close();
              throw new ExternalMcpError("EXTERNAL_MCP_CLOSED", 503);
            }
            await noLinks(run);
            check();
            signal.throwIfAborted();
            const budget = Math.floor(Math.min(1000, (remainingMs?.() ?? 1200) - 200));
            if (budget < 50) throw new ExternalMcpError("EXTERNAL_MCP_AUTH_EXPIRED", 403);
            const temp = join(run, `permit-${randomUUID()}.tmp`);
            await writeFile(
              temp,
              JSON.stringify({ maxElapsedMs: budget, expiresAt: Date.now() + budget }),
              { flag: "wx", mode: 0o600 },
            );
            try {
              check();
              signal.throwIfAborted();
              await link(temp, join(run, "permit"));
            } finally {
              await rm(temp, { force: true }).catch(
                () => {},
              ); /* Nonsecret marker is also removed with the owned run directory. */
            }
          }
        }
      } catch (error) {
        terminate();
        throw error;
      } finally {
        signal.removeEventListener("abort", lost);
        env.SHURIVA_MCP_ENV = "";
      }
    });
  return { transport: transport satisfies Transport, close, run };
}
