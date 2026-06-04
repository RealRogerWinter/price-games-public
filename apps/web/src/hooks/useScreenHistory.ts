import { useState, useEffect, useRef, useCallback } from "react";

/**
 * Drop-in replacement for `useState<Screen>` that syncs screen transitions
 * with the browser History API, enabling back-button navigation between screens.
 *
 * @param initialScreen - The initial screen to display (e.g. "home")
 * @returns A `[screen, setScreen]` tuple compatible with `useState`
 */
export function useScreenHistory<S extends string>(
  initialScreen: S
): [screen: S, setScreen: (next: S) => void] {
  const [screen, setScreenState] = useState<S>(initialScreen);
  // Guard to prevent pushState when the screen change came from popstate
  const isPopStateRef = useRef(false);

  // Tag the initial history entry with the screen value
  useEffect(() => {
    window.history.replaceState(
      { ...window.history.state, screen: initialScreen },
      ""
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for browser back/forward navigation
  useEffect(() => {
    function handlePopState(event: PopStateEvent) {
      const s = event.state?.screen;
      if (s == null) return; // not our history entry — let browser handle it
      isPopStateRef.current = true;
      setScreenState(s as S);
      // Reset the guard after React processes the state update
      queueMicrotask(() => {
        isPopStateRef.current = false;
      });
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const setScreen = useCallback(
    (next: S) => {
      if (isPopStateRef.current) return;
      window.history.pushState(
        { ...window.history.state, screen: next },
        ""
      );
      setScreenState(next);
    },
    []
  );

  return [screen, setScreen];
}
