import { Transform, type TransformCallback } from "node:stream";
import { BoundaryError, boundedJson, limits } from "./input-limits.js";

/** Only framing/limits. The official SDK still parses and implements JSON-RPC. */
export class BoundedStdioInput extends Transform {
  private pending = Buffer.alloc(0);
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly frameTimeoutMs = 5000) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset);
        const part = chunk.subarray(offset, end < 0 ? chunk.length : end);
        if (this.pending.length + part.length > limits.messageBytes)
          throw new BoundaryError(413, "MCP_INPUT_LIMIT");
        if (!this.timer)
          this.timer = setTimeout(
            () => this.destroy(new BoundaryError(408, "MCP_FRAME_TIMEOUT")),
            this.frameTimeoutMs,
          );
        this.pending = Buffer.concat([this.pending, part]);
        if (end < 0) break;
        if (this.pending.length) {
          boundedJson(this.pending);
          this.push(this.pending);
          this.push("\n");
        }
        this.pending = Buffer.alloc(0);
        clearTimeout(this.timer);
        this.timer = undefined;
        offset = end + 1;
      }
      done();
    } catch (error) {
      done(error instanceof Error ? error : new Error("MCP_INPUT_INVALID"));
    }
  }
  override _flush(done: TransformCallback) {
    done(this.pending.length ? new BoundaryError(400, "MCP_FRAME_INCOMPLETE") : undefined);
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void) {
    clearTimeout(this.timer);
    this.pending = Buffer.alloc(0);
    done(error);
  }
}
