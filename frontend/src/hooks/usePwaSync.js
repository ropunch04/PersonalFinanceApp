import { useEffect } from "react";
import { api } from "../api";

const MIN_SYNC_INTERVAL_MS = 10 * 60 * 1000;

export function usePwaSync({ credentialsConfigured, lastSyncedAt, onSynced }) {
  useEffect(() => {
    if (!credentialsConfigured) return;

    function shouldSync() {
      if (!lastSyncedAt) return true;
      const last = new Date(lastSyncedAt.endsWith("Z") ? lastSyncedAt : lastSyncedAt + "Z");
      return Date.now() - last.getTime() > MIN_SYNC_INTERVAL_MS;
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible" && shouldSync()) {
        api.syncNow()
          .then((result) => { if (onSynced) onSynced(result); })
          .catch(() => {});
      }
    }

    if (shouldSync()) {
      api.syncNow()
        .then((result) => { if (onSynced) onSynced(result); })
        .catch(() => {});
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [credentialsConfigured, lastSyncedAt, onSynced]);
}
