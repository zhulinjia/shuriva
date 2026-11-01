import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "../api";
import type { Snapshot, SnapshotSelection, SnapshotVersion } from "./SnapshotPanel";
import { schemaChanges } from "./schema-diff";
import {
  bindingIsLoading,
  bindingScope,
  loadBindingStatus,
  loadBoundPage,
} from "./source-bindings";
import { pollSerial, SourceState, shouldClearSnapshot, sourceViewReady } from "./source-state";
import type { Scan, Source } from "./source-types";

/** Owns scoped binding status, bounded polling and the matching snapshot lifecycle. */
export function useSourceBindings(options: {
  workspace: string;
  sources: Source[];
  selectedView: string;
  loadedView: string | null;
  querySource: string;
  setQuerySource: Dispatch<SetStateAction<string>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
}) {
  const {
    workspace,
    sources,
    selectedView,
    loadedView,
    querySource,
    setQuerySource,
    setBusy,
    setError,
  } = options;
  const [bound, setBound] = useState<Source[]>([]);
  const [boundOptions, setBoundOptions] = useState<Source[]>([]);
  const [boundPages, setBoundPages] = useState<string[]>([""]);
  const [boundNext, setBoundNext] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotSelection | null>(null);
  const [versions, setVersions] = useState<SnapshotVersion[]>([]);
  const [versionCursor, setVersionCursor] = useState<string | null>(null);
  const [changes, setChanges] = useState<string[] | null>(null);
  const [scans, setScans] = useState<Record<string, Scan>>({});
  const state = useRef(new SourceState());
  const bindingFlight = useRef<{ id: string; promise: Promise<void> } | null>(null);
  const [bindingLoading, setBindingLoading] = useState(false);
  const [bindingError, setBindingError] = useState(false);
  const [loadedBindingKey, setLoadedBindingKey] = useState("");
  const bindingInput = useRef({
    workspace: "",
    visible: [] as string[],
    selected: "",
    snapshot: "",
    after: "",
  });
  bindingInput.current = {
    workspace,
    visible: sourceViewReady(loadedView, selectedView) ? sources.map((item) => item.id) : [],
    selected: querySource,
    snapshot: snapshot?.id ?? "",
    after: boundPages[boundPages.length - 1] ?? "",
  };
  const loadBindings = useCallback(async (id: string) => {
    const request = state.current.bindings(id);
    if (request < 0) return;
    if (!id) {
      setBound([]);
      setScans({});
      setBindingLoading(false);
      return;
    }
    const input = bindingInput.current;
    try {
      const scope = bindingScope(input.visible, input.selected, input.snapshot);
      const [all, page] = await Promise.all([
        loadBindingStatus(id, scope),
        loadBoundPage(id, input.after),
      ]);
      const current = bindingInput.current;
      if (
        !state.current.acceptsBindings(id, request) ||
        JSON.stringify(input) !== JSON.stringify(current)
      )
        return;
      if (
        !Array.isArray(page.sources) ||
        page.sources.length > 100 ||
        (page.nextCursor !== null && typeof page.nextCursor !== "string")
      )
        throw Error("invalid bound source page");
      setBoundOptions(page.sources);
      setBoundNext(page.nextCursor);
      setLoadedBindingKey(JSON.stringify(input));
      const boundIds = all.map((source) => source.id);
      state.current.updateBindings(scope, boundIds);
      setBound(all);
      setSnapshot((current) =>
        current && shouldClearSnapshot(current.id, scope, boundIds) ? null : current,
      );
      setScans(
        Object.fromEntries(
          all.map((item) => [
            item.id,
            item.scanStatus ? { status: item.scanStatus, errorCode: item.errorCode ?? null } : null,
          ]),
        ),
      );
      setBindingError(false);
    } catch (e) {
      if (
        state.current.acceptsBindings(id, request) &&
        JSON.stringify(input) === JSON.stringify(bindingInput.current)
      ) {
        setBindingError(true);
        state.current.invalidateSnapshot();
      }
      throw e;
    } finally {
      if (
        state.current.acceptsBindings(id, request) &&
        JSON.stringify(input) === JSON.stringify(bindingInput.current)
      )
        setBindingLoading(false);
    }
  }, []);
  const refreshBindings = useCallback(
    async (id: string, force = false) => {
      const active = bindingFlight.current;
      if (active?.id === id) {
        if (!force) return active.promise;
        try {
          await active.promise;
        } catch {
          /* the new refresh may recover */
        }
      }
      const promise = loadBindings(id);
      bindingFlight.current = { id, promise };
      try {
        await promise;
      } finally {
        if (bindingFlight.current?.promise === promise) bindingFlight.current = null;
      }
    },
    [loadBindings],
  );
  useEffect(() => {
    state.current.select(workspace);
    setQuerySource("");
    setBound([]);
    setBoundOptions([]);
    setBoundPages([""]);
    setBoundNext(null);
    setScans({});
    setSnapshot(null);
    setVersions([]);
    setVersionCursor(null);
    setChanges(null);
    setBindingError(false);
    setBindingLoading(!!workspace);
    if (!workspace) return;
    const stop = pollSerial(
      () => refreshBindings(workspace),
      (callback) => window.setTimeout(callback, 5000),
      (timer) => window.clearTimeout(timer),
    );
    return () => {
      stop();
      state.current.select("");
    };
  }, [workspace, refreshBindings, setQuerySource]);
  // A new visible page or selection needs a fresh, narrowly scoped status
  // immediately. A stale response cannot decide an unrequested source.
  const bindingScopeKey = JSON.stringify(bindingInput.current);
  const bindingsLoading = bindingIsLoading(
    workspace,
    bindingLoading,
    bindingError,
    loadedBindingKey,
    bindingScopeKey,
  );
  useEffect(() => {
    if (!workspace || !bindingScopeKey) return;
    setBindingLoading(true);
    void refreshBindings(workspace, true).catch(() => {});
  }, [workspace, bindingScopeKey, refreshBindings]);
  async function view(item: Source) {
    const request = state.current.beginSnapshot(item.id);
    setBusy(true);
    setError("");
    try {
      const base = `/api/data-sources/workspaces/${encodeURIComponent(workspace)}/${encodeURIComponent(item.id)}`;
      const [response, history] = await Promise.all([
        api<{ snapshot: Snapshot }>(`${base}/snapshot`),
        api<{ snapshots: SnapshotVersion[]; nextCursor: string | null }>(`${base}/snapshots`),
      ]);
      if (state.current.acceptsSnapshot(request)) {
        setSnapshot({ id: item.id, source: item.name, value: response.snapshot });
        setVersions(history.snapshots);
        setVersionCursor(history.nextCursor);
        setChanges(null);
      }
    } catch {
      if (state.current.acceptsSnapshot(request)) {
        setSnapshot(null);
        setError("无法获取结构快照；可能尚未扫描，或服务暂不可用。");
      }
    } finally {
      setBusy(false);
    }
  }
  async function selectVersion(id: string) {
    if (!snapshot) return;
    const request = state.current.beginSnapshot(snapshot.id);
    const source = snapshot.id;
    setBusy(true);
    setError("");
    try {
      const response = await api<{ snapshot: Snapshot }>(
        `/api/data-sources/workspaces/${encodeURIComponent(workspace)}/${encodeURIComponent(source)}/snapshots/${encodeURIComponent(id)}`,
      );
      if (state.current.acceptsSnapshot(request))
        setSnapshot((current) =>
          current?.id === source ? { ...current, value: response.snapshot } : current,
        );
      if (state.current.acceptsSnapshot(request)) setChanges(null);
    } catch {
      if (state.current.acceptsSnapshot(request)) {
        setSnapshot(null);
        setError("无法获取该版本的结构快照。");
      }
    } finally {
      setBusy(false);
    }
  }
  async function comparePrevious() {
    if (!snapshot) return;
    const index = versions.findIndex((item) => item.id === snapshot.value.id);
    const previous = index >= 0 ? versions[index + 1] : undefined;
    if (!previous) return;
    const request = state.current.beginSnapshot(snapshot.id);
    const source = snapshot.id;
    setBusy(true);
    setError("");
    try {
      const response = await api<{ snapshot: Snapshot }>(
        `/api/data-sources/workspaces/${encodeURIComponent(workspace)}/${encodeURIComponent(source)}/snapshots/${encodeURIComponent(previous.id)}`,
      );
      if (state.current.acceptsSnapshot(request))
        setChanges(schemaChanges(snapshot.value.content, response.snapshot.content));
    } catch {
      if (state.current.acceptsSnapshot(request)) setError("无法比较结构版本。");
    } finally {
      setBusy(false);
    }
  }
  async function moreVersions() {
    if (!snapshot || !versionCursor) return;
    const request = state.current.beginSnapshot(snapshot.id);
    const source = snapshot.id;
    setBusy(true);
    setError("");
    try {
      const page = await api<{ snapshots: SnapshotVersion[]; nextCursor: string | null }>(
        `/api/data-sources/workspaces/${encodeURIComponent(workspace)}/${encodeURIComponent(source)}/snapshots?before=${encodeURIComponent(versionCursor)}`,
      );
      if (state.current.acceptsSnapshot(request)) {
        setVersions((items) => [...items, ...page.snapshots]);
        setVersionCursor(page.nextCursor);
      }
    } catch {
      if (state.current.acceptsSnapshot(request)) setError("无法加载更多版本。");
    } finally {
      setBusy(false);
    }
  }

  return {
    bound,
    boundOptions,
    boundPages,
    boundNext,
    setBoundPages,
    snapshot,
    setSnapshot,
    versions,
    versionCursor,
    changes,
    scans,
    state,
    bindingError,
    bindingsLoading,
    refreshBindings,
    view,
    selectVersion,
    comparePrevious,
    moreVersions,
  };
}
