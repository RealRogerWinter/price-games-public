/**
 * Search bar component for Product Universe.
 *
 * Provides a text input with submit button for product search.
 */

import { useState, FormEvent } from "react";

interface SearchBarProps {
  onSearch: (query: string) => void;
  initialQuery?: string;
  placeholder?: string;
}

export default function SearchBar({ onSearch, initialQuery = "", placeholder = "Search products..." }: SearchBarProps) {
  const [query, setQuery] = useState(initialQuery);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = query.trim();
    if (trimmed) onSearch(trimmed);
  }

  return (
    <form className="pu-search-bar" onSubmit={handleSubmit}>
      <input
        type="text"
        className="pu-search-input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        maxLength={200}
        autoFocus
      />
      <button type="submit" className="pu-search-btn" disabled={!query.trim()}>
        Search
      </button>
    </form>
  );
}
