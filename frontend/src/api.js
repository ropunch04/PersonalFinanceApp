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
    localStorage.removeItem(TOKEN_KEY);
    window.location.href = "/login";
    return;
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

  getDashboard: () => request("GET", "/api/dashboard"),

  getTransactions: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request("GET", `/api/transactions${qs ? `?${qs}` : ""}`);
  },
  createTransaction: (data) => request("POST", "/api/transactions", data),
  updateTransaction: (id, data) =>
    request("PUT", `/api/transactions/${id}`, data),
  deleteTransaction: (id) => request("DELETE", `/api/transactions/${id}`),

  getCategories: () => request("GET", "/api/categories"),

  getProfile: () => request("GET", "/api/profile"),
  updateProfile: (data) => request("PUT", "/api/profile", data),

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

  updateGmail: (data) => request("PUT", "/api/profile/gmail", data),

  sync: () => request("POST", "/api/sync"),

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
