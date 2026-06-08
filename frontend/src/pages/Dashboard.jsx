import { useEffect, useState } from "react";
import { api } from "../api";

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getDashboard()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p>Loading...</p>;
  if (error) return <p className="error">{error}</p>;
  if (!data) return null;

  const { monthly_income, total_spent, net, savings_target, categories } = data;

  return (
    <div className="dashboard">
      <h1>Dashboard</h1>

      <div className="summary-cards">
        <div className="card">
          <span className="label">Income</span>
          <span className="value">${monthly_income?.toFixed(2)}</span>
        </div>
        <div className="card">
          <span className="label">Spent</span>
          <span className="value">${total_spent?.toFixed(2)}</span>
        </div>
        <div className="card">
          <span className="label">Net</span>
          <span className="value">${net?.toFixed(2)}</span>
        </div>
        <div className="card">
          <span className="label">Savings Target</span>
          <span className="value">${savings_target?.toFixed(2)}</span>
        </div>
      </div>

      {categories?.length > 0 && (
        <div className="categories">
          <h2>Categories</h2>
          {categories.map((cat) => (
            <div key={cat.name} className="category-row">
              <span className="cat-name">{cat.name}</span>
              <div className="cat-bar-track">
                <div
                  className="cat-bar-fill"
                  style={{
                    width: cat.budget
                      ? `${Math.min(100, (cat.spent / cat.budget) * 100)}%`
                      : "0%",
                  }}
                />
              </div>
              <span className="cat-amounts">
                ${cat.spent?.toFixed(2)} / ${cat.budget?.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
