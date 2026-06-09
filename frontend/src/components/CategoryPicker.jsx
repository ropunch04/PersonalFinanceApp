import { useEffect, useState } from "react";
import { api } from "../api";

export default function CategoryPicker({ value, onChange, categories: propCats }) {
  const [cats, setCats] = useState(propCats ?? []);

  useEffect(() => {
    if (!propCats) {
      api.getCategories().then(setCats).catch(() => {});
    }
  }, [propCats]);

  if (propCats && propCats !== cats) setCats(propCats);

  return (
    <div className="cat-pills">
      {cats.map((c) => (
        <button
          key={c.id}
          type="button"
          className="cat-pill"
          style={value === c.id ? {
            borderColor: "var(--primary)",
            background: "rgba(108,99,255,0.15)",
            color: "var(--primary)",
          } : {}}
          onClick={() => onChange(value === c.id ? null : c.id)}
        >
          {c.name}
        </button>
      ))}
    </div>
  );
}
