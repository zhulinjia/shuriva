import { dirname, join } from "node:path";
import { ExternalMcpError } from "./model.js";
import { fileHash, noLinks } from "./program-files.js";
/** Fixed Win32 ABI only; callers cannot choose a DLL, symbol or access policy. */
export async function pinExecutable(file: string, expected?: string) {
  if (process.platform !== "win32" || process.arch !== "x64" || !process.env.SystemRoot)
    throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_UNSUPPORTED");
  const koffi = await import("koffi");
  const kernel = koffi.load(await noLinks(join(process.env.SystemRoot, "System32/kernel32.dll")));
  const create = kernel.func(
    "void * __stdcall CreateFileW(str16 path, uint32_t access, uint32_t share, void * security, uint32_t disposition, uint32_t flags, void * templateFile)",
  );
  const close = kernel.func("bool __stdcall CloseHandle(void * handle)");
  const handles: bigint[] = [];
  let closed = false;
  const release = () => {
    if (closed) return;
    closed = true;
    let failed = false;
    for (const h of handles.reverse()) if (!close(h)) failed = true;
    kernel.unload();
    if (failed) throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_PIN_CLOSE_FAILED", 503);
  };
  try {
    const path = await noLinks(file);
    // Deny deletion of each ancestor as well as writes/replacement of the image.
    for (let p = path; ; p = dirname(p)) {
      const h: unknown = create(
        p,
        p === path ? 0x80000000 : 0,
        p === path ? 1 : 3,
        null,
        3,
        p === path ? 0x00200000 : 0x02200000,
        null,
      );
      if (typeof h !== "bigint" || h === 0n || h === 0xffffffffffffffffn)
        throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_PIN_FAILED", 503);
      handles.push(h);
      if (dirname(p) === p) break;
    }
    await noLinks(path);
    if (expected && (await fileHash(path, 33554432)).sha256 !== expected)
      throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_CHANGED", 409);
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

/** Own random job name created by the pinned host, before target resume. */
export async function openOwnedJob(name: string) {
  if (
    process.platform !== "win32" ||
    !process.env.SystemRoot ||
    !/^Local\\Shuriva-MCP-[a-f0-9-]{36}$/.test(name)
  )
    throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_JOB_REJECTED");
  const koffi = await import("koffi"),
    kernel = koffi.load(await noLinks(join(process.env.SystemRoot, "System32/kernel32.dll")));
  const open = kernel.func(
      "void * __stdcall OpenJobObjectW(uint32_t access, bool inherit, str16 name)",
    ),
    terminate = kernel.func("bool __stdcall TerminateJobObject(void * job, uint32_t code)"),
    close = kernel.func("bool __stdcall CloseHandle(void * handle)");
  const handle: unknown = open(8, false, name);
  if (typeof handle !== "bigint" || handle === 0n || handle === 0xffffffffffffffffn) {
    kernel.unload();
    throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_JOB_REJECTED");
  }
  let closed = false;
  return {
    terminate() {
      if (!closed && !terminate(handle, 1))
        throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_JOB_STOP_FAILED", 503);
    },
    close() {
      if (closed) return;
      closed = true;
      const ok = close(handle);
      kernel.unload();
      if (!ok) throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_JOB_CLOSE_FAILED", 503);
    },
  };
}
