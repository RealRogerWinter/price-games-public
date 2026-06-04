import { useState, useEffect } from "react";
import { getCategories } from "../api/client";

interface CategorySelectProps {
  selected: string[];
  onChange: (categories: string[]) => void;
}

interface CategoryInfo {
  name: string;
  count: number;
}

export default function CategorySelect({
  selected,
  onChange,
}: CategorySelectProps) {
  const [categories, setCategories] = useState<CategoryInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getCategories()
      .then((data) => setCategories(data.categories))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  function toggle(name: string) {
    if (selected.includes(name)) {
      onChange(selected.filter((c) => c !== name));
    } else {
      onChange([...selected, name]);
    }
  }

  function selectAll() {
    onChange(categories.map((c) => c.name));
  }

  function selectNone() {
    onChange([]);
  }

  if (loading) {
    return <div className="category-select loading">Loading categories...</div>;
  }

  const allSelected = selected.length === categories.length;

  return (
    <div className="category-select">
      <div className="category-header">
        <h3 className="category-select-title">Choose Categories</h3>
        <button
          className="btn-link"
          onClick={allSelected ? selectNone : selectAll}
        >
          {allSelected ? "Deselect All" : "Select All"}
        </button>
      </div>
      <div className="category-grid">
        {categories.map((cat) => {
          const isSelected = selected.includes(cat.name);
          return (
            <button
              key={cat.name}
              className={`category-chip ${isSelected ? "category-chip-active" : ""}`}
              onClick={() => toggle(cat.name)}
            >
              <span className="category-chip-name">{cat.name}</span>
              <span className="category-chip-count">{cat.count}</span>
            </button>
          );
        })}
      </div>
      {selected.length === 0 && (
        <p className="category-hint">Select at least one category to play</p>
      )}
    </div>
  );
}
