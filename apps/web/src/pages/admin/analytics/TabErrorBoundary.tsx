/**
 * Narrow error boundary around the lazy-loaded analytics tabs.
 *
 * A chunk-load failure inside `React.lazy(() => import("./OverviewTab"))`
 * throws during render and, without a boundary, would crash the entire
 * admin shell via the outer `Suspense`. This boundary catches the failure
 * inside the analytics surface, shows a retry link, and leaves the rest
 * of the admin UI intact.
 */

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export default class TabErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // Log to the server-side beacon if/when we wire one; for now just console.
    console.error("[analytics] tab failed to render:", error);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="admin-error" role="alert" data-testid="analytics-tab-error">
          <p>Failed to load this tab.</p>
          <button type="button" onClick={this.reset} className="admin-btn-secondary">
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
