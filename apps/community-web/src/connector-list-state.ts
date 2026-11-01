export type Connector = {
  id: string;
  name: string;
  agentVersion: string;
  lastSeenAt: number | null;
  status: "online" | "offline" | "incompatible" | "revoked";
  diagnosticStatus: "pending" | "completed" | "expired" | null;
};

export type ConnectorListState = {
  items: Connector[];
  loading: boolean;
  refreshError: boolean;
  latestRequest: number;
};

export const initialConnectorList: ConnectorListState = {
  items: [],
  loading: true,
  refreshError: false,
  latestRequest: 0,
};

type Action =
  | { type: "start"; request: number }
  | { type: "success"; request: number; items: Connector[] }
  | { type: "failure"; request: number };

export function connectorListReducer(
  state: ConnectorListState,
  action: Action,
): ConnectorListState {
  if (action.type === "start") return { ...state, latestRequest: action.request };
  if (action.request !== state.latestRequest) return state;
  if (action.type === "failure") return { ...state, loading: false, refreshError: true };
  return { ...state, loading: false, refreshError: false, items: action.items };
}

export function connectorListView(
  state: ConnectorListState,
): "loading" | "unavailable" | "empty" | "items" {
  if (state.loading) return "loading";
  if (state.refreshError && state.items.length === 0) return "unavailable";
  return state.items.length === 0 ? "empty" : "items";
}

export function connectorStatus(
  state: ConnectorListState,
  item: Connector,
): Connector["status"] | "unknown" {
  return state.refreshError ? "unknown" : item.status;
}
