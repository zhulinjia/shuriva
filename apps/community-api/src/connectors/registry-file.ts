import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function acquireLock(path: string, token: string): Promise<void> {
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const file = await open(lockPath, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ pid: process.pid, token }));
        await file.sync();
      } finally {
        await file.close();
      }
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    let reap: Awaited<ReturnType<typeof open>> | undefined;
    try {
      reap = await open(`${lockPath}.reap`, "wx", 0o600);
      let owner: unknown;
      try {
        owner = JSON.parse(await readFile(lockPath, "utf8"));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      if (
        !owner ||
        typeof owner !== "object" ||
        !("pid" in owner) ||
        !Number.isSafeInteger(owner.pid) ||
        Number(owner.pid) < 1
      )
        throw new Error("Invalid connector lock; manual inspection required");
      let alive = true;
      try {
        process.kill(Number(owner.pid), 0);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") alive = false;
        else throw error;
      }
      if (!alive) await rm(lockPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    } finally {
      if (reap) {
        await reap.close();
        await rm(`${lockPath}.reap`, { force: true });
      }
    }
    await delay(100);
  }
  throw new Error("Connector registry is already in use");
}

/** Owns the single-process file lock and atomic durable replacement only. */
export class RegistryFile {
  private constructor(
    private readonly path: string,
    private readonly token: string,
  ) {}
  static async open(path: string): Promise<RegistryFile> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const token = randomBytes(24).toString("hex");
    await acquireLock(path, token);
    return new RegistryFile(path, token);
  }
  async read(): Promise<string | undefined> {
    try {
      return await readFile(this.path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  async write(content: string): Promise<void> {
    const temp = `${this.path}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(content, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, this.path);
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }
  async close(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(`${this.path}.lock`, "utf8"));
      if (raw && typeof raw === "object" && "token" in raw && raw.token === this.token)
        await rm(`${this.path}.lock`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}
