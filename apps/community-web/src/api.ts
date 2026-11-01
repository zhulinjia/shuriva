export class ApiError extends Error {
  readonly status: number;
  readonly requestId?: string;
  readonly code?:
    | "CAPACITY"
    | "RESULT_CAPACITY"
    | "SEMANTIC_STALE"
    | "NO_MODEL_FIELDS"
    | "SEMANTICS_TOO_LARGE";
  constructor(status: number, message: string, code?: ApiError["code"], requestId?: string) {
    super(requestId ? `${message}（排查编号：${requestId}）` : message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

// Only recognized bounded error codes cross the untrusted response boundary.
async function capacityCode(response: Response): Promise<ApiError["code"]> {
  if (
    ![409, 503].includes(response.status) ||
    !response.headers.get("content-type")?.includes("application/json") ||
    !response.body
  )
    return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 2048) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      body &&
      typeof body === "object" &&
      "error" in body &&
      ((response.status === 503 &&
        (body.error === "CAPACITY" || body.error === "RESULT_CAPACITY")) ||
        (response.status === 409 &&
          (body.error === "SEMANTIC_STALE" ||
            body.error === "NO_MODEL_FIELDS" ||
            body.error === "SEMANTICS_TOO_LARGE")))
    )
      return body.error;
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
  return undefined;
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  return (await apiResponse(path, options)).json() as Promise<T>;
}

export async function apiResponse(
  path: RequestInfo | URL,
  options?: RequestInit,
): Promise<Response> {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  if (!response.ok) {
    const message =
      response.status === 401
        ? "用户名或密码错误，或登录已过期。"
        : response.status === 429
          ? "操作过于频繁，请稍后再试。"
          : response.status === 403
            ? "没有权限执行此操作。"
            : "操作未完成，请检查输入后重试。";
    const header = response.headers.get("x-request-id");
    const requestId = header && /^[A-Za-z0-9_-]{1,64}$/.test(header) ? header : undefined;
    throw new ApiError(response.status, message, await capacityCode(response), requestId);
  }
  return response;
}
export function post(data?: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  };
}
