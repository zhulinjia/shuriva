import { useEffect, useState } from "react";
import { historyRequest } from "./history-api";
import { decodeHistoryCapability } from "./history-model";
export function useHistoryCapability() {
  const [status, setStatus] = useState<"loading" | "enabled" | "disabled" | "unavailable">(
    "loading",
  );
  useEffect(() => {
    let active = true;
    void historyRequest<unknown>("/api/history/capability")
      .then((value) => {
        const enabled = decodeHistoryCapability(value);
        if (active) setStatus(enabled ? "enabled" : "disabled");
      })
      .catch(() => {
        if (active) setStatus("unavailable");
      });
    return () => {
      active = false;
    };
  }, []);
  return status;
}
