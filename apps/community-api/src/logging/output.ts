import type { DiagnosticSink } from "./logger.js";

// A shared stdout/stderr may outlive several application runtimes. One listener
// belongs to the destination until it closes, including late async write errors;
// runtime.close never closes a stream it does not own or accumulates listeners.
const destinations = new WeakMap<DiagnosticSink, { failed: boolean }>();
export function diagnosticOutputState(output: DiagnosticSink): { failed: boolean } {
  const existing = destinations.get(output);
  if (existing) return existing;
  const state = { failed: false };
  const failed = () => {
    state.failed = true;
  };
  output.on?.("error", failed);
  output.once?.("close", () => {
    output.off?.("error", failed);
    destinations.delete(output);
  });
  destinations.set(output, state);
  return state;
}
