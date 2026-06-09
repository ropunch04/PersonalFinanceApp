import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";

const CATEGORY_COLORS = {
  Food:          "#6C63FF",
  Transport:     "#22C55E",
  Shopping:      "#F59E0B",
  Entertainment: "#EC4899",
  Health:        "#14B8A6",
  Housing:       "#F97316",
  Utilities:     "#8B5CF6",
  Income:        "#22C55E",
  Other:         "#475569",
  Refund:        "#94A3B8",
};

const FALLBACK_COLORS = ["#6366F1", "#EC4899", "#F97316", "#14B8A6", "#8B5CF6", "#06B6D4", "#EAB308", "#84CC16"];

function getColor(name, index) {
  return CATEGORY_COLORS[name] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

function fmt(n) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(n ?? 0);
}

export default function CategoryDonut({ categories, selectedId, onSelect }) {
  const slices = (categories ?? []).filter((c) => c.spent > 0);
  const totalSpent = slices.reduce((sum, c) => sum + c.spent, 0);

  if (slices.length === 0) {
    return (
      <div style={{ position: "relative", width: "100%", height: 200, marginBottom: 20 }}>
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie
              data={[{ value: 1 }]}
              dataKey="value"
              innerRadius={60}
              outerRadius={90}
              startAngle={90}
              endAngle={-270}
              stroke="none"
            >
              <Cell fill="#22263A" />
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div style={{
          position: "absolute", top: "50%", left: "50%",
          transform: "translate(-50%, -50%)",
          textAlign: "center", pointerEvents: "none",
        }}>
          <div style={{ fontSize: 11, color: "#94A3B8" }}>No spending data</div>
        </div>
      </div>
    );
  }

  const data = slices.map((c, i) => ({
    ...c,
    fill: getColor(c.category_name, i),
  }));

  return (
    <div style={{ position: "relative", width: "100%", height: 200, marginBottom: 4 }}>
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie
            data={data}
            dataKey="spent"
            innerRadius={60}
            outerRadius={90}
            startAngle={90}
            endAngle={-270}
            stroke="none"
            onClick={(entry) => {
              onSelect(selectedId === entry.category_id ? null : entry.category_id);
            }}
          >
            {data.map((entry) => (
              <Cell
                key={entry.category_id}
                fill={entry.fill}
                opacity={selectedId && selectedId !== entry.category_id ? 0.35 : 1}
                outerRadius={selectedId === entry.category_id ? 95 : 90}
                style={{ cursor: "pointer", outline: "none" }}
              />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>

      <div style={{
        position: "absolute", top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        textAlign: "center", pointerEvents: "none",
      }}>
        <div style={{ fontSize: 20, fontWeight: 600, color: "#F1F5F9", lineHeight: 1.1 }}>
          {fmt(selectedId
            ? slices.find((c) => c.category_id === selectedId)?.spent ?? totalSpent
            : totalSpent
          )}
        </div>
        <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 2 }}>
          {selectedId
            ? slices.find((c) => c.category_id === selectedId)?.category_name ?? "Total Spent"
            : "Total Spent"
          }
        </div>
      </div>
    </div>
  );
}
