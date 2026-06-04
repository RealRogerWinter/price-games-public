import { useState, useEffect, useRef, useCallback } from "react";

/**
 * Drop-in replacement for `useState<boolean>(false)` that syncs modal
 * visibility with the browser History API. Opening pushes an entry;
 * browser-back closes the modal; UI-close pops the entry.
 *
 * @param name - Unique identifier stored in `history.state.modal`
 * @returns A `[visible, setVisible]` tuple compatible with `useState`
 */
export function useModalHistory(
  name: string
): [visible: boolean, setVisible: (open: boolean) => void] {
  const [visible, setVisibleState] = useState(false);
  // Synchronous mirror of `visible` so the popstate handler always sees current value
  const visibleRef = useRef(false);
  // Whether we have an active history entry for this modal
  const pushedRef = useRef(false);

  useEffect(() => {
    function handlePopState(event: PopStateEvent) {
      // Modal not open — nothing to close (also prevents reacting to our own history.back())
      if (!visibleRef.current) return;
      // If the new entry still has our modal marker, don't close (stale entry from a buried push)
      if (event.state?.modal === name) return;
      pushedRef.current = false;
      visibleRef.current = false;
      setVisibleState(false);
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [name]);

  const setVisible = useCallback(
    (open: boolean) => {
      if (open) {
        if (visibleRef.current) return; // already open
        window.history.pushState(
          { ...window.history.state, modal: name },
          ""
        );
        pushedRef.current = true;
        visibleRef.current = true;
        setVisibleState(true);
      } else {
        if (!visibleRef.current) return; // already closed
        // Pop our history entry if it's still on top
        const shouldPop =
          pushedRef.current && window.history.state?.modal === name;
        pushedRef.current = false;
        visibleRef.current = false;
        setVisibleState(false);
        if (shouldPop) {
          window.history.back();
        }
      }
    },
    [name]
  );

  return [visible, setVisible];
}
