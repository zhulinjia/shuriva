import { createPool, type PoolOptions } from "mysql2/promise";
import { OperationalError } from "../operational-error.js";

/** Parse once for both startup validation and the actual driver. URL query options are allowlisted. */
export function databaseConnectionOptions(raw: string): PoolOptions {
  let url: URL;
  try {
    url = new URL(raw);
    if (url.protocol !== "mysql:" || !url.hostname || !url.pathname.slice(1) || url.hash)
      throw new Error();
  } catch {
    throw new OperationalError("DATABASE_URL_INVALID");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port ? Number(url.port) : 3306;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new OperationalError("DATABASE_URL_INVALID");
  const local = ["localhost", "127.0.0.1", "::1"].includes(host);
  const tls = url.searchParams.get("tls") ?? (local ? "local" : "required");
  if (
    [...url.searchParams.keys()].some((key) => key !== "tls") ||
    url.searchParams.getAll("tls").length > 1 ||
    (tls !== "required" && !(tls === "local" && local))
  )
    throw new OperationalError("DATABASE_TLS_INVALID");
  try {
    return {
      host,
      port,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
      timezone: "Z",
      connectionLimit: 10,
      connectTimeout: 5000,
      enableCleartextPlugin: false,
      ...(tls === "required" ? { ssl: { rejectUnauthorized: true, verifyIdentity: true } } : {}),
    };
  } catch {
    throw new OperationalError("DATABASE_URL_INVALID");
  }
}
export function createDatabase(url: string) {
  return createPool(databaseConnectionOptions(url));
}
