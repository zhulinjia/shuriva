import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import {
  type JSONRPCMessage,
  ReadBuffer,
  serializeMessage,
  type Transport,
} from "@modelcontextprotocol/client";
import { ExternalMcpError } from "./model.js";

/** SDK framing and protocol, native absolute-image spawn. The SDK's Windows
 * cross-spawn path can insert cmd.exe even with shell:false; it is unsuitable
 * for this platform's no-shell and exact process-ownership contract. */
export class NativeStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly stderr = new PassThrough();
  private child?: ChildProcessWithoutNullStreams;
  private ended?: Promise<void>;
  private drained?: Promise<void>;
  private closing?: Promise<void>;
  private started = false;
  private readonly buffer = new ReadBuffer({ maxBufferSize: 1048576 });
  constructor(
    private readonly options: {
      command: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
    },
    private readonly afterExit: () => void = () => {},
  ) {}
  get pid() {
    return this.child?.pid ?? null;
  }
  async start() {
    if (this.started) throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_ALREADY_STARTED");
    this.started = true;
    const p = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = p;
    this.ended = new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try {
          this.afterExit();
        } finally {
          resolve();
        }
      };
      p.once("exit", finish);
      p.once("error", () => {
        if (!p.pid) finish();
      });
    });
    this.drained = new Promise<void>((resolve) =>
      p.once("close", () => {
        resolve();
        this.onclose?.();
      }),
    );
    const failed = () =>
      this.onerror?.(new ExternalMcpError("EXTERNAL_MCP_PROGRAM_IO_FAILED", 502));
    p.stdin.on("error", failed);
    p.stdout.on("error", failed);
    p.stderr.on("error", failed);
    p.stderr.pipe(this.stderr);
    p.stdout.on("data", (part: Buffer) => {
      try {
        this.buffer.append(part);
        for (;;) {
          const message = this.buffer.readMessage();
          if (message === null) break;
          this.onmessage?.(message);
        }
      } catch {
        this.buffer.clear();
        failed();
        void this.close().catch(failed);
      }
    });
    await new Promise<void>((resolve, reject) => {
      p.once("spawn", () => resolve());
      p.once("error", (error) => {
        failed();
        reject(error);
      });
    });
  }
  send(message: JSONRPCMessage) {
    const p = this.child;
    if (!p || p.exitCode !== null || p.signalCode !== null || !p.stdin.writable)
      return Promise.reject(new ExternalMcpError("EXTERNAL_MCP_NOT_CONNECTED", 409));
    return new Promise<void>((resolve, reject) => {
      p.stdin.write(serializeMessage(message), (error) =>
        error ? reject(new ExternalMcpError("EXTERNAL_MCP_PROGRAM_IO_FAILED", 502)) : resolve(),
      );
    });
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      const p = this.child;
      if (!p) return;
      if (!p.pid) {
        p.stdin.destroy();
        p.stdout.destroy();
        p.stderr.destroy();
        this.buffer.clear();
        return;
      }
      const wait = async (ms: number, completion = this.ended) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            completion,
            new Promise<void>((r) => {
              timer = setTimeout(r, ms);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      p.stdin.destroy();
      if (p.exitCode === null && p.signalCode === null) await wait(2000);
      if (p.exitCode === null && p.signalCode === null) {
        p.kill();
        await wait(1000);
      }
      if (p.exitCode === null && p.signalCode === null)
        throw new ExternalMcpError("EXTERNAL_MCP_PROCESS_CLEANUP_UNKNOWN", 503);
      await wait(1000, this.drained);
      p.stdout.destroy();
      p.stderr.destroy();
      this.buffer.clear();
    })();
    return this.closing;
  }
}
