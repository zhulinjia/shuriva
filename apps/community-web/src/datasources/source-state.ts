/** Coordinates workspace-scoped requests and revokes in-flight snapshot reads. */
export class SourceState {
  private workspace = "";
  private bindingVersion = 0;
  private snapshotVersion = 0;
  private snapshotSource = "";

  select(workspace: string): void {
    this.workspace = workspace;
    this.bindingVersion++;
    this.invalidateSnapshot();
  }

  bindings(workspace: string): number {
    return workspace === this.workspace ? ++this.bindingVersion : -1;
  }

  acceptsBindings(workspace: string, version: number): boolean {
    return workspace === this.workspace && version === this.bindingVersion;
  }

  updateBindings(scope: string[], ids: string[]): void {
    if (shouldClearSnapshot(this.snapshotSource, scope, ids)) this.invalidateSnapshot();
  }

  beginSnapshot(source: string): number {
    this.snapshotSource = source;
    return ++this.snapshotVersion;
  }

  acceptsSnapshot(version: number): boolean {
    return version === this.snapshotVersion;
  }

  invalidateSnapshot(): void {
    this.snapshotSource = "";
    this.snapshotVersion++;
  }
}

/** Absence only proves an unbinding when that source was actually requested. */
export function shouldClearSnapshot(source: string, scope: string[], bound: string[]): boolean {
  return !!source && scope.includes(source) && !bound.includes(source);
}

/** A list may be displayed only under the filter and cursor that produced it. */
export function sourceViewKey(archived: boolean, after: string): string {
  return JSON.stringify([archived, after]);
}

export function sourceViewReady(loaded: string | null, selected: string): boolean {
  return loaded === selected;
}

/** Preserve the fact that a write succeeded when the subsequent reload fails. */
export async function commitAndRefresh(
  commit: () => Promise<unknown>,
  refresh: () => Promise<unknown>,
): Promise<"complete" | "refresh-failed"> {
  await commit();
  try {
    await refresh();
    return "complete";
  } catch {
    return "refresh-failed";
  }
}

/** Start each poll only after the preceding request has finished. */
export function pollSerial(
  work: () => Promise<unknown>,
  schedule: (callback: () => void) => number,
  cancel: (handle: number) => void,
): () => void {
  let stopped = false;
  let timer: number | undefined;
  const run = async () => {
    try {
      await work();
    } catch {
      // Continue polling after a transient failure.
    }
    if (!stopped) timer = schedule(() => void run());
  };
  void run();
  return () => {
    stopped = true;
    if (timer !== undefined) cancel(timer);
  };
}
