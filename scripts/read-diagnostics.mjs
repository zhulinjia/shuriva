import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** Read local JSON-lines diagnostics only. No database, mutation or network access. */
const arguments_ = process.argv.slice(2);
const directory = arguments_[arguments_.indexOf("--dir") + 1];
const id = arguments_[arguments_.indexOf("--id") + 1];
if (
  arguments_.length !== 4 ||
  !arguments_.includes("--dir") ||
  !arguments_.includes("--id") ||
  !directory ||
  !isAbsolute(directory) ||
  !id ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
) {
  process.stderr.write(
    "Usage: node scripts/read-diagnostics.mjs --dir ABSOLUTE_LOG_DIRECTORY --id REQUEST_OR_TASK_UUID\n",
  );
  process.exitCode = 2;
} else {
  try {
    const names = (await readdir(directory))
      .filter((name) => /^[A-Za-z0-9_.-]+\.(?:log|jsonl)(?:\.[0-9]+)?$/.test(name))
      .slice(0, 64);
    let found = 0;
    for (const name of names) {
      const file = join(directory, name);
      if (!(await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink()) continue;
      let partial = "",
        oversized = false;
      for await (const chunk of createReadStream(file, { encoding: "utf8" })) {
        for (const part of chunk.split(/(?<=\n)/)) {
          if (!oversized) partial += part;
          if (Buffer.byteLength(partial) > 65536) {
            partial = "";
            oversized = true;
          }
          if (!part.endsWith("\n")) continue;
          if (!oversized) {
            try {
              const record = JSON.parse(partial);
              if (
                ["requestId", "taskId", "executionId", "connectorId", "sourceId"].some(
                  (key) => record?.[key] === id,
                )
              ) {
                process.stdout.write(`${partial.trim()}\n`);
                found++;
              }
            } catch {
              /* Incomplete/corrupt diagnostic lines are not trusted records. */
            }
          }
          partial = "";
          oversized = false;
        }
      }
    }
    process.stderr.write(`Matched ${found} diagnostic records.\n`);
  } catch {
    process.stderr.write("Cannot read the selected local diagnostics directory.\n");
    process.exitCode = 1;
  }
}
