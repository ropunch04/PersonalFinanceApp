import { useState } from "react";

const STORAGE_KEY = "dashboard_widgets_v1";

export const WIDGETS = [
  { key: "comparison", label: "Month Comparison" },
  { key: "trend", label: "Spending Trend" },
  { key: "donut", label: "Category Chart" },
  { key: "budget", label: "Budget by Category" },
  { key: "merchants", label: "Merchant Insights" },
  { key: "owed", label: "Owed to You" },
];

const DEFAULT_ORDER = WIDGETS.map((w) => w.key);
const VALID_KEYS = new Set(DEFAULT_ORDER);

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!raw) return { order: DEFAULT_ORDER, hidden: [] };

    const order = Array.isArray(raw.order) ? raw.order.filter((k) => VALID_KEYS.has(k)) : [];
    for (const k of DEFAULT_ORDER) if (!order.includes(k)) order.push(k);

    const hidden = Array.isArray(raw.hidden) ? raw.hidden.filter((k) => VALID_KEYS.has(k)) : [];
    return { order, hidden };
  } catch {
    return { order: DEFAULT_ORDER, hidden: [] };
  }
}

function save(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function useDashboardWidgets() {
  const [state, setState] = useState(load);

  function toggleWidget(key) {
    setState((prev) => {
      const hidden = prev.hidden.includes(key)
        ? prev.hidden.filter((k) => k !== key)
        : [...prev.hidden, key];
      const next = { ...prev, hidden };
      save(next);
      return next;
    });
  }

  function moveWidget(key, direction) {
    setState((prev) => {
      const index = prev.order.indexOf(key);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= prev.order.length) return prev;
      const order = [...prev.order];
      [order[index], order[targetIndex]] = [order[targetIndex], order[index]];
      const next = { ...prev, order };
      save(next);
      return next;
    });
  }

  const visibleOrder = state.order.filter((k) => !state.hidden.includes(k));

  return {
    widgets: WIDGETS,
    order: state.order,
    hidden: state.hidden,
    visibleOrder,
    toggleWidget,
    moveWidget,
  };
}
