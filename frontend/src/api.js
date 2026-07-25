const TOKEN_KEY = "finance_token";

async function request(method, path, body = null) {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  const json = await res.json();
  if (res.status === 401) {
    const hadToken = !!localStorage.getItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
    if (hadToken) {
      window.location.href = "/login";
      return;
    }
    throw new Error(json.error || "Invalid credentials");
  }
  if (!res.ok) throw new Error(json.error || "Request failed");
  return json.data;
}

export const api = {
  login: (username, password) =>
    request("POST", "/api/auth/login", { username, password }),
  register: (username, email, password) =>
    request("POST", "/api/auth/register", { username, email, password }),
  me: () => request("GET", "/api/auth/me"),
  logout: () => localStorage.removeItem(TOKEN_KEY),

  getComparison: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request("GET", `/api/dashboard/comparison${qs ? `?${qs}` : ""}`);
  },

  getMerchants: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request("GET", `/api/dashboard/merchants${qs ? `?${qs}` : ""}`);
  },

  getTrend: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request("GET", `/api/dashboard/trend${qs ? `?${qs}` : ""}`);
  },

  getDashboard: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request("GET", `/api/dashboard${qs ? `?${qs}` : ""}`);
  },

  getDuplicates: () => request("GET", "/api/transactions/duplicates"),

  getLinkableOutflows: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request("GET", `/api/transactions/linkable-outflows${qs ? `?${qs}` : ""}`);
  },
  createReimbursementLink: (inflowId, outflowId, amount) =>
    request("POST", "/api/reimbursement-links", { inflow_id: inflowId, outflow_id: outflowId, amount }),
  deleteReimbursementLink: (linkId) => request("DELETE", `/api/reimbursement-links/${linkId}`),
  getTransactionLinks: (id) => request("GET", `/api/transactions/${id}/links`),
  getOwed: () => request("GET", "/api/transactions/owed"),
  splitTransaction: (id, parts) => request("POST", `/api/transactions/${id}/split`, { parts }),

  getTransactions: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request("GET", `/api/transactions${qs ? `?${qs}` : ""}`);
  },
  changePassword: (current_password, new_password) =>
    request("POST", "/api/auth/change-password", { current_password, new_password }),
  createTransaction: (data) => request("POST", "/api/transactions", data),
  updateTransaction: (id, data) =>
    request("PUT", `/api/transactions/${id}`, data),
  deleteTransaction: (id) => request("DELETE", `/api/transactions/${id}`),
  bulkCategorize: (merchant_raw, category_id) =>
    request("POST", "/api/transactions/bulk-categorize", { merchant_raw, category_id }),
  reclassify: (merchant_raw, from_category_id, to_category_id) =>
    request("POST", "/api/transactions/reclassify", { merchant_raw, from_category_id, to_category_id }),
  getUnclassifiedMerchants: () =>
    request("GET", "/api/transactions/merchants/unclassified"),
  autoClassify: () =>
    request("POST", "/api/transactions/auto-classify"),

  getCategories: () => request("GET", "/api/categories"),
  createCategory: (name) => request("POST", "/api/categories", { name }),
  deleteCategory: (id) => request("DELETE", `/api/categories/${id}`),
  reorderCategories: (order) => request("PUT", "/api/categories/reorder", { order }),
  setMiscCategory: (id, is_misc) => request("PUT", `/api/categories/${id}/misc`, { is_misc }),

  getProfile: () => request("GET", "/api/profile"),
  updateProfile: (data) => request("PUT", "/api/profile", data),
  updateGmail: (data) => request("PUT", "/api/profile/gmail", data),

  syncNow: () => request("POST", "/api/sync"),
  syncStatus: () => request("GET", "/api/sync/status"),

  importTransactions: (sourceType, files) => {
    const token = localStorage.getItem(TOKEN_KEY);
    const form = new FormData();
    form.append("source_type", sourceType);
    for (const file of files) {
      form.append("file", file);
    }
    const headers = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return fetch("/api/import/transactions", { method: "POST", headers, body: form }).then(
      async (res) => {
        const json = await res.json();
        if (res.status === 401) {
          localStorage.removeItem(TOKEN_KEY);
          window.location.href = "/login";
          return;
        }
        if (!res.ok) throw new Error(json.error || "Request failed");
        return json.data;
      }
    );
  },

  admin: {
    listUsers: () => request("GET", "/api/admin/users"),
    createUser: (data) => request("POST", "/api/admin/users", data),
    updateUser: (id, data) => request("PUT", `/api/admin/users/${id}`, data),
    resetPassword: (id, new_password) =>
      request("POST", `/api/admin/users/${id}/reset-password`, { new_password }),
    deleteUser: (id) => request("DELETE", `/api/admin/users/${id}`),
    syncUser: (id) => request("POST", `/api/admin/users/${id}/sync`),
    getSystem: () => request("GET", "/api/admin/system"),
    getLogs: (lines = 100) => request("GET", `/api/admin/logs?lines=${lines}`),
  },
};
