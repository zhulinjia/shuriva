import { OperationalError } from "../operational-error.js";
import { randomUUID } from "node:crypto";
import { mkdir, open, lstat, readFile, unlink, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { Writable } from "node:stream";
import { createStream } from "rotating-file-stream";
import type { LoggingConfig } from "./config.js";
import { createDiagnosticLogger, type DiagnosticSink } from "./logger.js";
import { diagnosticOutputState } from "./output.js";

export async function createDiagnosticRuntime(
  config: LoggingConfig,
  output: DiagnosticSink = process.stdout,
) {
  let dropped = 0,
    fileFailed = false,
    closed = false,
    outputFailed = false,
    pending = 0;
  const outputState = diagnosticOutputState(output);
  const writeOutput = (line: string) => {
    if ((output.writableLength ?? 0) + Buffer.byteLength(line) > 1024 * 1024) {
      dropped++;
      return;
    }
    try {
      if (output instanceof Writable) {
        pending++;
        output.write(line, (error) => {
          pending--;
          if (error) {
            outputFailed = true;
            dropped++;
          }
        });
      } else output.write(line);
    } catch {
      outputFailed = true;
    }
  };
  let release: (() => Promise<void>) | undefined;
  let file: ReturnType<typeof createStream> | undefined;
  if (config.directory) {
    await mkdir(config.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(config.directory)).isSymbolicLink())
      throw new OperationalError("LOG_DIRECTORY_LINK");
    if (
      (await realpath(config.directory)).toLowerCase() !== resolve(config.directory).toLowerCase()
    )
      throw new OperationalError("LOG_DIRECTORY_LINK");
    for (const name of await readdir(config.directory))
      if (
        /^community-api\.jsonl(?:\.[0-9]+)?$/.test(name) &&
        (await lstat(join(config.directory, name))).isSymbolicLink()
      )
        throw new OperationalError("LOG_FILE_LINK");
    const lockPath = join(config.directory, "community-api.lock"),
      token = randomUUID();
    const lock = await open(lockPath, "wx", 0o600);
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, token }));
      await lock.sync();
    } finally {
      await lock.close();
    }
    release = async () => {
      let lockRecord: unknown;
      try {
        lockRecord = JSON.parse(await readFile(lockPath, "utf8"));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          return;
        throw error;
      }
      if (
        lockRecord &&
        typeof lockRecord === "object" &&
        "token" in lockRecord &&
        lockRecord.token === token
      )
        await unlink(lockPath);
    };
    try {
      file = createStream("community-api.jsonl", {
        path: config.directory,
        size: `${config.maxBytes}B`,
        rotate: config.maxFiles,
        mode: 0o600,
      });
      file.on("error", () => {
        fileFailed = true;
        writeOutput(
          `${JSON.stringify({ level: "error", time: new Date().toISOString(), service: "community-api", event: "diagnostic.file_unavailable", code: "LOG_WRITE_FAILED" })}\n`,
        );
      });
      file.on("warning", () => {
        fileFailed = true;
      });
      // Detect initial open failure before reporting successful startup.
      await new Promise<void>((yes, no) => {
        file?.once("open", () => yes());
        file?.once("error", no);
      });
    } catch (error) {
      await release();
      throw error;
    }
  }
  const logger = createDiagnosticLogger(
    {
      write(line) {
        if (closed) return;
        writeOutput(line);
        if (file && !fileFailed) {
          if (file.writableLength + Buffer.byteLength(line) > 1024 * 1024) {
            dropped++;
            return;
          }
          file.write(line);
        }
      },
    },
    config.level,
    () => {
      outputFailed = true;
      dropped++;
    },
  );
  let closeTask: Promise<void> | undefined;
  return {
    logger,
    health: () => ({
      available: !closed && !outputState.failed && !outputFailed && !fileFailed && dropped === 0,
      fileEnabled: !!file,
      dropped,
      closed,
    }),
    close() {
      if (closeTask) return closeTask;
      closeTask = (async () => {
        if (closed) return;
        closed = true;
        if (file && !file.destroyed) {
          file.end();
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([
            finished(file).catch(() => {
              fileFailed = true;
            }),
            new Promise<void>((done) => {
              timer = setTimeout(() => {
                fileFailed = true;
                file?.destroy();
                done();
              }, 2000);
            }),
          ]);
          if (timer) clearTimeout(timer);
        }
        const deadline = performance.now() + 2000;
        while (pending > 0 && performance.now() < deadline)
          await new Promise<void>((done) => setTimeout(done, 5));
        if (pending > 0) {
          dropped += pending;
          outputFailed = true;
        }
        try {
          await release?.();
        } catch {
          fileFailed = true;
          writeOutput(
            `${JSON.stringify({ level: "error", time: new Date().toISOString(), service: "community-api", event: "diagnostic.close_failed", code: "LOG_CLOSE_FAILED" })}\n`,
          );
        }
      })();
      return closeTask;
    },
  };
}
