import fs from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";

/** Reusable test-only guard. No .env, default port or unverified callback checkout. */
export async function isolatedMysql() {
  const file = process.env.STAGE8_G3_MANIFEST;
  if (!file) throw Error("STAGE8_G3_MANIFEST must identify a freshly isolated instance");
  const resolved = path.resolve(file);
  if (
    !/[\\/]\.cache[\\/]stage8-g2-[0-9a-f]{32}[\\/]manifest\.json$/.test(resolved) ||
    (await fs.realpath(resolved)) !== resolved
  )
    throw Error("invalid isolated manifest path");
  const manifest: unknown = JSON.parse(await fs.readFile(resolved, "utf8"));
  if (!manifest || typeof manifest !== "object") throw Error("invalid isolated manifest");
  const get = (name: string): unknown => Reflect.get(manifest, name);
  if (
    get("host") !== "127.0.0.1" ||
    get("port") !== 13308 ||
    get("format") !== "stackoryn-stage8-g2-v1" ||
    get("adminUser") !== "root" ||
    typeof get("adminPassword") !== "string" ||
    !/^[0-9a-f]{64}$/.test(String(get("adminPassword"))) ||
    typeof get("serverUuid") !== "string" ||
    !/^[0-9a-f-]{36}$/.test(String(get("serverUuid")))
  )
    throw Error("manifest is not the fresh allowed instance");
  const dataDir = path.join(path.dirname(resolved), "mysql-data"),
    pidFile = path.join(path.dirname(resolved), "mysql.pid");
  if (
    path.resolve(String(get("dataDir"))) !== dataDir ||
    path.resolve(String(get("pidFile"))) !== pidFile ||
    (await fs.realpath(dataDir)) !== dataDir ||
    !(await fs.readFile(path.join(dataDir, "auto.cnf"), "utf8")).includes(
      `server-uuid=${get("serverUuid")}`,
    )
  )
    throw Error("isolated data identity mismatch");
  const options = {
    host: "127.0.0.1",
    port: 13308,
    user: "root",
    password: String(get("adminPassword")),
    timezone: "Z",
    multipleStatements: false,
    connectionLimit: 8,
  };
  async function verify(c: Pick<mysql.Connection, "query">) {
    const [rows] = await c.query<mysql.RowDataPacket[]>(
      "SELECT @@port AS port,@@datadir AS dir,@@server_uuid AS uuid,@@pid_file AS pid",
    );
    if (
      rows[0]?.port !== 13308 ||
      path.resolve(String(rows[0]?.dir)) !== dataDir ||
      rows[0]?.uuid !== get("serverUuid") ||
      path.resolve(String(rows[0]?.pid)) !== pidFile ||
      (await fs.readFile(pidFile, "utf8")).trim() !== String(get("ownerPid"))
    )
      throw Error("isolated target identity changed; fixture SQL refused");
  }
  async function admin() {
    const connection = await mysql.createConnection(options);
    try {
      await verify(connection);
      return connection;
    } catch (error) {
      await connection.end();
      throw error;
    }
  }
  function openPool(database: string) {
    if (!/^g3_mut_api_[0-9a-f]{16}$/.test(database))
      throw new Error("invalid owned platform fixture database");
    const rawPool = mysql.createPool({ ...options, database });
    const checkedConnection = async () => {
      const c = await rawPool.getConnection();
      try {
        await verify(c);
        return c;
      } catch (error) {
        c.release();
        throw error;
      }
    };
    const pool = new Proxy(rawPool, {
      get(target, key, receiver) {
        if (key === "pool") return guardedCallbackPool;
        if (key === "getConnection") return checkedConnection;
        if (key === "execute" || key === "query")
          return async (...args: unknown[]) => {
            const c = await checkedConnection();
            try {
              return await Reflect.apply(Reflect.get(c, key), c, args);
            } finally {
              c.release();
            }
          };
        const value: unknown = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const guardedCallbackPool = new Proxy(rawPool.pool, {
      get(target, key, receiver) {
        if (key === "getConnection")
          return (callback: Parameters<typeof target.getConnection>[0]) => {
            target.getConnection((error, connection) => {
              if (error) {
                callback(error, connection);
                return;
              }
              void verify(connection.promise()).then(
                () => callback(null, connection),
                (failure) => {
                  connection.release();
                  callback(
                    failure instanceof Error
                      ? failure
                      : new Error("isolated target verification failed"),
                    connection,
                  );
                },
              );
            });
          };
        const value: unknown = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return pool;
  }
  return {
    admin,
    pool: openPool,
    verify,
    runId: path.basename(path.dirname(resolved)).slice("stage8-g2-".length),
  };
}
