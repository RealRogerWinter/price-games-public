/**
 * Error display component for Product Universe.
 */

interface ErrorDisplayProps {
  message: string;
  onRetry?: () => void;
}

export default function ErrorDisplay({ message, onRetry }: ErrorDisplayProps) {
  return (
    <div className="pu-error">
      <p className="pu-error-message">{message}</p>
      {onRetry && (
        <button className="pu-btn" onClick={onRetry}>Retry</button>
      )}
    </div>
  );
}
