const maxBodyBytes = 8192;
const bodyTimeoutMs = 2000;

export class AuthRequestError extends Error {
  constructor(
    readonly status: 400 | 403 | 408 | 413,
    readonly finish: () => void = () => {},
  ) {
    super("INVALID_AUTH_REQUEST");
  }
}

/** Finish bounded network input before taking a credential transaction lock. */
export async function prepareAuthRequest(request: Request, origin: string): Promise<Request> {
  if (request.method !== "POST") return request;
  if (request.headers.get("origin") !== origin) throw new AuthRequestError(403);
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectDeadline!: (error: unknown) => void;
  const expired = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const stop = (status: 400 | 408 | 413) => {
    const error = new AuthRequestError(status, () => {
      // Node cancellation destroys IncomingMessage's socket. The transport
      // invokes this only once the error response is sent or the peer closes.
      void reader.cancel().catch(() => {});
    });
    rejectDeadline(error);
    return error;
  };
  const timer = setTimeout(() => stop(408), bodyTimeoutMs);
  const abort = () => stop(400);
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  try {
    const read = async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBodyBytes) {
          throw stop(413);
        }
        chunks.push(value);
      }
      const body = Buffer.concat(chunks, size);
      return new Request(request, { body });
    };
    return await Promise.race([read(), expired]);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
  }
}
