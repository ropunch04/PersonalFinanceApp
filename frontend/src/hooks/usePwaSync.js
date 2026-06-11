import { useEffect } from "react";
import { api } from "../api";

const MIN_SYNC_INTERVAL_MS = 10 * 60 * 1000;

export function usePwaSync({ credentialsConfigured, lastSyncedAt, onSynced, onError }) {
  useEffect(() => {
    if (!credentialsConfigured) return;

    function shouldSync() {
      if (!lastSyncedAt) return true;
      const normalized = lastSyncedAt.replace("+00:00", "Z");
      const last = new Date(normalized);
      return Date.now() - last.getTime() > MIN_SYNC_INTERVAL_MS;
    }

    function doSync() {
      api.syncNow()
        .then((result) => { if (onSynced) onSynced(result); })
        .catch((err) => { if (onError) onError(err); });
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible" && shouldSync()) doSync();
    }

    if (shouldSync()) doSync();

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [credentialsConfigured, lastSyncedAt, onSynced, onError]);
}
