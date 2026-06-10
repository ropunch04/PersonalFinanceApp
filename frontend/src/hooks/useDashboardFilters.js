import { useMemo, useState } from "react";

const STORAGE_KEY      = "dashboard_range";
const CUSTOM_START_KEY = "dashboard_custom_start";
const CUSTOM_END_KEY   = "dashboard_custom_end";
const PINNED_KEY       = "pinned_txn_ids";

export const RANGES = [
  { label: "This Month", value: "this_month" },
  { label: "Last Month", value: "last_month" },
  { label: "3 Months",   value: "3_months" },
  { label: "6 Months",   value: "6_months" },
  { label: "This Year",  value: "this_year" },
  { label: "Custom",     value: "custom" },
];

function toDateParams(range, customStart, customEnd) {
  if (range === "custom") {
    const today = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return {
      start_date: customStart || fmt(new Date(today.getFullYear(), today.getMonth(), 1)),
      end_date:   customEnd   || fmt(today),
    };
  }

  const today = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const end = fmt(today);

  switch (range) {
    case "last_month": {
      const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const last  = new Date(today.getFullYear(), today.getMonth(), 0);
      return { start_date: fmt(first), end_date: fmt(last) };
    }
    case "3_months": {
      const start = new Date(today);
      start.setDate(today.getDate() - 90);
      return { start_date: fmt(start), end_date: end };
    }
    case "6_months": {
      const start = new Date(today);
      start.setDate(today.getDate() - 180);
      return { start_date: fmt(start), end_date: end };
    }
    case "this_year":
      return { start_date: `${today.getFullYear()}-01-01`, end_date: end };
    default: {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      return { start_date: fmt(first), end_date: end };
    }
  }
}

export function useDashboardFilters() {
  const [range, setRangeState] = useState(
    () => localStorage.getItem(STORAGE_KEY) ?? "this_month"
  );
  const [customStart, setCustomStartState] = useState(
    () => localStorage.getItem(CUSTOM_START_KEY) ?? ""
  );
  const [customEnd, setCustomEndState] = useState(
    () => localStorage.getItem(CUSTOM_END_KEY) ?? ""
  );
  const [pinnedIds, setPinnedIds] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(PINNED_KEY) ?? "[]");
    } catch {
      return [];
    }
  });

  function setRange(r) {
    localStorage.setItem(STORAGE_KEY, r);
    setRangeState(r);
  }

  function setCustomStart(v) {
    localStorage.setItem(CUSTOM_START_KEY, v);
    setCustomStartState(v);
  }

  function setCustomEnd(v) {
    localStorage.setItem(CUSTOM_END_KEY, v);
    setCustomEndState(v);
  }

  function togglePin(id) {
    setPinnedIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      localStorage.setItem(PINNED_KEY, JSON.stringify(next));
      return next;
    });
  }

  function clearPins() {
    localStorage.setItem(PINNED_KEY, "[]");
    setPinnedIds([]);
  }

  const dateParams = useMemo(
    () => toDateParams(range, customStart, customEnd),
    [range, customStart, customEnd]
  );

  return {
    range, setRange,
    customStart, setCustomStart,
    customEnd, setCustomEnd,
    pinnedIds, togglePin, clearPins,
    dateParams,
  };
}
