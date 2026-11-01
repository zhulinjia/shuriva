import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Stable package root for both tsx development and compiled Node entry points. */
export function apiPackageRoot(): string {
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  return resolve(sourceDir, basename(dirname(sourceDir)) === "dist" ? "../.." : "..");
}
