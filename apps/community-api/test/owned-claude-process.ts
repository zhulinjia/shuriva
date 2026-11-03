import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isJSONRPCResultResponse } from "@modelcontextprotocol/client";
import { z } from "zod";
import { ownedStdio } from "../src/mcp-client/stdio.js";
import { noLinks } from "../src/mcp-client/program-files.js";
import { packageFixture } from "./external-program-fixture.js";

// The production host owns this Node root atomically; ordinary descendants
// inherit its non-breakaway Job. This wrapper implements no MCP protocol.
const wrapper = String.raw`
import {spawn} from 'node:child_process';
import {appendFileSync,existsSync,readFileSync} from 'node:fs';
const p=JSON.parse(process.env.MCP_TEST_KEY);
const child=spawn(p.executable,p.args,{cwd:p.cwd,env:p.env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
appendFileSync(p.trace,JSON.stringify({event:'claude_started',pid:child.pid,wrapperPid:process.pid})+'\n');
let stdout='',stderr='';
child.stdout.on('data',part=>{stdout+=part.toString('utf8');if(Buffer.byteLength(stdout)>65536)process.exit(93);});
child.stderr.on('data',part=>{stderr+=part.toString('utf8');if(Buffer.byteLength(stderr)>65536)process.exit(94);});
child.once('error',()=>process.exit(95));
const control=setInterval(()=>{if(existsSync(p.control)&&readFileSync(p.control,'utf8')==='fault'){clearInterval(control);appendFileSync(p.trace,JSON.stringify({event:'wrapper_fault_consumed',code:91,wrapperPid:process.pid})+'\n');process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32091,message:'OWNED_CLAUDE_INJECTED_FAULT'}})+'\n',()=>process.exit(91));}},10);
child.once('close',(code)=>{clearInterval(control);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{code,stdout,stderr}})+'\n');});
`;

const exitSchema = z.strictObject({
  code: z.number().int(),
  stdout: z.string().max(65536),
  stderr: z.string().max(65536),
});
export type ClaudeExit = z.infer<typeof exitSchema>;

/** Teardown must never replace the operation's original failure evidence. */
export async function finishClaudeOperation<T>(
  operation: Promise<T>,
  cleanup: () => Promise<void>,
) {
  let primary: { error: unknown } | undefined;
  let value: T | undefined;
  try {
    value = await operation;
  } catch (error) {
    primary = { error };
  }
  try {
    await cleanup();
  } catch (error) {
    if (primary)
      throw new AggregateError([primary.error, error], "Claude operation and cleanup failed", {
        cause: primary.error,
      });
    throw error;
  }
  if (primary) throw primary.error;
  return value as T;
}

/** Observe the assertion immediately, including when writing the trigger fails. */
export async function expectClaudeFailure(
  run: { finished: Promise<unknown>; close(): Promise<void> },
  expected: RegExp,
  trigger: () => void | Promise<void>,
) {
  const assertion = assert.rejects(run.finished, expected);
  void assertion.catch(() => {});
  try {
    await trigger();
  } catch (error) {
    return finishClaudeOperation<never>(Promise.reject(error), async () => {
      const results = await Promise.allSettled([run.close(), assertion]);
      const failures = results.flatMap((result, index) =>
        result.status === "rejected"
          ? [
              new Error(
                index === 0 ? "Claude failed-trigger Job cleanup" : "Claude failure assertion",
                { cause: result.reason },
              ),
            ]
          : [],
      );
      if (failures.length) throw new AggregateError(failures, "Claude trigger recovery incomplete");
    });
  }
  await assertion;
}

const traceEvent = z.object({
  event: z.string(),
  versions: z.array(z.string()).optional(),
  ok: z.boolean().optional(),
  pid: z.number().int().positive().optional(),
  wrapperPid: z.number().int().positive().optional(),
  relayPid: z.number().int().positive().optional(),
  code: z.number().int().optional(),
  tool: z.enum(["workspaces_list", "other"]).optional(),
});
export async function claudeTrace(path: string) {
  const events = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => traceEvent.parse(JSON.parse(line)));
  if (events.some((event) => event.event === "trace_overflow"))
    throw Error("G5_CLAUDE_TRACE_OVERFLOW");
  return events;
}

/** Fixed ABI, read-only query handle for a host-created random Job, not PID inference. */
async function jobQueries() {
  if (process.platform !== "win32" || process.arch !== "x64" || !process.env.SystemRoot)
    throw Error("owned Claude fixture requires Windows/amd64");
  const koffi = await import("koffi");
  const kernel = koffi.load(await noLinks(join(process.env.SystemRoot, "System32/kernel32.dll")));
  try {
    const open = kernel.func(
      "void * __stdcall OpenJobObjectW(uint32_t access, bool inherit, str16 name)",
    );
    const query = kernel.func(
      "bool __stdcall QueryInformationJobObject(void * job, int kind, void * buffer, uint32_t length, void * returned)",
    );
    const close = kernel.func("bool __stdcall CloseHandle(void * handle)");
    return {
      open(name: string) {
        if (!/^Local\\Shuriva-MCP-[a-f0-9-]{36}$/.test(name))
          throw Error("fixture Job name rejected");
        const handle: unknown = open(4, false, name); // JOB_OBJECT_QUERY only.
        if (typeof handle !== "bigint" || handle === 0n) return undefined;
        return {
          members() {
            const buffer = Buffer.alloc(8 + 8 * 8);
            if (!query(handle, 3, buffer, buffer.length, null))
              throw Error("fixture Job membership query failed");
            const assigned = buffer.readUInt32LE(0),
              count = buffer.readUInt32LE(4);
            if (assigned !== count || count > 8) throw Error("fixture Job membership incomplete");
            return Array.from({ length: count }, (_v, i) =>
              Number(buffer.readBigUInt64LE(8 + i * 8)),
            );
          },
          accounting() {
            const buffer = Buffer.alloc(48);
            if (!query(handle, 1, buffer, buffer.length, null))
              throw Error("fixture Job accounting query failed");
            return {
              total: buffer.readUInt32LE(36),
              active: buffer.readUInt32LE(40),
              terminated: buffer.readUInt32LE(44),
            };
          },
          close() {
            if (!close(handle)) throw Error("fixture Job query handle close failed");
          },
        };
      },
      close() {
        kernel.unload();
      },
    };
  } catch (error) {
    return finishClaudeOperation<never>(Promise.reject(error), async () => {
      kernel.unload();
    });
  }
}

/** Also used by setup-failure tests with an already-owned packaged fixture. */
export async function prepareClaudeProgram(
  program: Awaited<ReturnType<typeof packageFixture>>,
  makeQueries = jobQueries,
) {
  let queries: Awaited<ReturnType<typeof jobQueries>> | undefined;
  try {
    queries = await makeQueries();
    const installed = await program.catalog.inspect(program.id);
    return { program, queries, installed };
  } catch (error) {
    return finishClaudeOperation<never>(Promise.reject(error), async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => queries?.close()),
        program.close(),
      ]);
      const failures = results.flatMap((result, index) =>
        result.status === "rejected"
          ? [
              new Error(
                index === 0 ? "Claude query library cleanup" : "Claude packaged fixture cleanup",
                { cause: result.reason },
              ),
            ]
          : [],
      );
      if (failures.length) throw new AggregateError(failures, "Claude setup cleanup incomplete");
    });
  }
}

export async function ownedClaudeProgram() {
  const { program, queries, installed } = await prepareClaudeProgram(await packageFixture(wrapper));
  const runs = new Set<{ close(): Promise<void> }>();
  return {
    async start(input: {
      executable: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
      trace: string;
      timeoutMs: number;
      signal?: AbortSignal;
    }) {
      const control = join(input.cwd, `fault-${randomUUID()}`);
      let observer: ReturnType<typeof queries.open>;
      let owned: Awaited<ReturnType<typeof ownedStdio>> | undefined;
      let beforeResume: number[] | undefined;
      let cleaned = false;
      let finalAccounting: { total: number; active: number; terminated: number } | undefined;
      let closing: Promise<void> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectOutput: (error: Error) => void = () => {};
      let resolveOutput: (value: ClaudeExit) => void = () => {};
      const completion = new Promise<ClaudeExit>((resolve, reject) => {
        resolveOutput = resolve;
        rejectOutput = reject;
      });
      void completion.catch(() => {});
      const check = () => {
        input.signal?.throwIfAborted();
        if (!owned) return;
        observer ??= queries.open(`Local\\Shuriva-MCP-${basename(owned.run)}`);
        if (
          observer &&
          !beforeResume &&
          existsSync(join(owned.run, "ready")) &&
          !existsSync(join(owned.run, "permit"))
        ) {
          beforeResume = observer.members();
          assert.equal(beforeResume.length, 1, "host must own its suspended root before resume");
        }
      };
      owned = await ownedStdio(
        installed,
        {
          environment: {
            MCP_TEST_KEY: JSON.stringify({
              ...input,
              control,
              signal: undefined,
              timeoutMs: undefined,
            }),
          },
        },
        join(program.root, "runs"),
        (send) => send(check, input.signal ?? new AbortController().signal, () => 5000),
      );
      const close = () => {
        if (closing) return closing;
        closing = (async () => {
          if (timer) clearTimeout(timer);
          await finishClaudeOperation(
            (async () => {
              await owned?.close(); // Includes host-owned ActiveProcesses=0 acknowledgment.
              if (observer) {
                finalAccounting = observer.accounting();
                assert.equal(finalAccounting.active, 0, "the entire owned Job must be empty");
                assert.deepEqual(observer.members(), []);
              }
            })(),
            async () => {
              const current = observer;
              observer = undefined;
              current?.close();
            },
          );
          cleaned = true;
        })();
        return closing;
      };
      const abort = () => {
        rejectOutput(Error("OWNED_CLAUDE_CANCELLED"));
        void close().catch(() => {});
      };
      const transport = owned.transport;
      transport.onmessage = (message) => {
        if (
          "error" in message &&
          message.id === 1 &&
          message.error.code === -32091 &&
          message.error.message === "OWNED_CLAUDE_INJECTED_FAULT"
        )
          return rejectOutput(Error("OWNED_CLAUDE_INJECTED_FAULT"));
        if (!isJSONRPCResultResponse(message) || message.id !== 1)
          return rejectOutput(Error("OWNED_CLAUDE_OUTPUT_REJECTED"));
        const parsed = exitSchema.safeParse(message.result);
        if (!parsed.success) return rejectOutput(Error("OWNED_CLAUDE_OUTPUT_REJECTED"));
        resolveOutput(parsed.data);
      };
      transport.onerror = () => rejectOutput(Error("OWNED_CLAUDE_PROCESS_FAILED"));
      transport.onclose = () => rejectOutput(Error("OWNED_CLAUDE_EXITED_WITHOUT_RESULT"));
      const run = { close };
      runs.add(run);
      try {
        input.signal?.addEventListener("abort", abort, { once: true });
        await transport.start();
        assert.ok(observer && beforeResume, "Job ownership observation must precede target resume");
        timer = setTimeout(() => {
          rejectOutput(Error("OWNED_CLAUDE_TIMEOUT"));
          void close().catch(() => {});
        }, input.timeoutMs);
        const finished = finishClaudeOperation(completion, async () => {
          input.signal?.removeEventListener("abort", abort);
          await close();
          runs.delete(run);
        });
        void finished.catch(() => {});
        return {
          finished,
          close,
          members() {
            return observer?.members() ?? [];
          },
          fault() {
            return writeFile(control, "fault", { flag: "wx" });
          },
          get evidence() {
            return { beforeResume, cleaned, finalAccounting };
          },
        };
      } catch (error) {
        input.signal?.removeEventListener("abort", abort);
        return finishClaudeOperation(Promise.reject(error), async () => {
          await close();
          runs.delete(run);
        });
      }
    },
    async close() {
      const settled = await Promise.allSettled([...runs].map((run) => run.close()));
      const failures = settled.flatMap((result) =>
        result.status === "rejected"
          ? [new Error("owned Claude Job cleanup unproven", { cause: result.reason })]
          : [],
      );
      try {
        queries.close();
      } catch (error) {
        failures.push(new Error("Claude query library cleanup", { cause: error }));
      }
      // Never delete a run tree while a Job may still be live.
      if (!settled.some((result) => result.status === "rejected")) {
        try {
          await program.close();
        } catch (error) {
          failures.push(new Error("Claude packaged fixture cleanup", { cause: error }));
        }
      }
      if (failures.length) throw new AggregateError(failures, "owned Claude cleanup incomplete");
    },
  };
}
