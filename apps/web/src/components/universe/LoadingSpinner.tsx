/**
 * Loading spinner component for Product Universe.
 */

interface LoadingSpinnerProps {
  message?: string;
}

export default function LoadingSpinner({ message = "Loading..." }: LoadingSpinnerProps) {
  return (
    <div className="pu-loading-spinner">
      <div className="pu-spinner" />
      <p>{message}</p>
    </div>
  );
}
