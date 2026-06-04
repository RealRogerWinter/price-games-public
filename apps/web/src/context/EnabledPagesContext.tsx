import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { getEnabledPages, type EnabledPages, type PageKey } from "../api/content";

/** Defaults: every SEO page off. Matches the server's conservative
 *  default so a provider without a successful fetch never leaks a page
 *  that the admin hasn't explicitly enabled. */
const ALL_DISABLED: EnabledPages = {
  about: false,
  faq: false,
  contact: false,
  game_modes: false,
  privacy: false,
  terms: false,
};

/** Value exposed by `EnabledPagesContext`. `loading` is true until the
 *  first fetch resolves — consumers can render a skeleton/blocker while
 *  they don't yet know which pages are visible. */
export interface EnabledPagesValue {
  pages: EnabledPages;
  loading: boolean;
  refresh: () => Promise<void>;
}

const Ctx = createContext<EnabledPagesValue | null>(null);

/**
 * Provider that fetches `/api/content/pages-enabled` on mount and
 * republishes it through context. Re-fetch is exposed so the admin UI
 * (in the same SPA) can notify the provider when the toggles change.
 */
export function EnabledPagesProvider({ children }: { children: ReactNode }) {
  const [pages, setPages] = useState<EnabledPages>(ALL_DISABLED);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    const next = await getEnabledPages();
    setPages(next);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = await getEnabledPages();
      if (!cancelled) {
        setPages(next);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return <Ctx.Provider value={{ pages, loading, refresh }}>{children}</Ctx.Provider>;
}

/**
 * Read the enabled-pages map from context. When the provider is not
 * present (e.g., isolated unit tests) the hook falls back to the
 * all-disabled default so components don't need to branch on a null
 * context.
 */
export function useEnabledPages(): EnabledPagesValue {
  const ctx = useContext(Ctx);
  if (ctx) return ctx;
  return { pages: ALL_DISABLED, loading: false, refresh: async () => {} };
}

/** Convenience: return true iff the given page is enabled. */
export function useIsPageEnabled(page: PageKey): boolean {
  const { pages } = useEnabledPages();
  return pages[page] === true;
}
