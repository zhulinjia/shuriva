import { BoundaryError } from "./limits.js";

/** The response and its underlying work share one admission permit. A closed
 * transport must not release work that has ignored cancellation. */
export class RetainedPermit {
  private holders = 1;
  private responseClosed = false;
  constructor(private readonly finish: () => void) {}
  retain() {
    if (this.responseClosed) throw new BoundaryError(408, "MCP_REQUEST_CLOSED");
    this.holders++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.drop();
    };
  }
  closeResponse() {
    if (this.responseClosed) return;
    this.responseClosed = true;
    this.drop();
  }
  private drop() {
    if (--this.holders === 0) this.finish();
  }
}
