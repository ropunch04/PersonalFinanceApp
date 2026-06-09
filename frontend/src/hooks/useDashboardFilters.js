import { useMemo, useState } from "react";

const STORAGE_KEY = "dashboard_range";

export const RANGES = [
  { label: "This Month", value: "this_month" },
  { label: "Last Month", value: "last_month" },
  { label: "3 Months",   value: "3_months" },
  { label: "6 Months",   value: "6_months" },
  { label: "This Year",  value: "this_year" },
];

function toDateParams(range) {
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
    case "this_year": {
      return { start_date: `${today.getFullYear()}-01-01`, end_date: end };
    }
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

  function setRange(r) {
    localStorage.setItem(STORAGE_KEY, r);
    setRangeState(r);
  }

  const dateParams = useMemo(() => toDateParams(range), [range]);
  return { range, setRange, dateParams };
}
