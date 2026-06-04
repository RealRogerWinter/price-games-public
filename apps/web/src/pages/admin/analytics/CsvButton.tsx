/**
 * "Export CSV" link. Renders as a button-styled anchor that triggers a
 * native browser download via `<a href download>` — that path keeps the
 * admin session cookie attached without any extra XHR plumbing.
 *
 * Usage:
 *   <CsvButton href={csvExportUrl("daily", filters)} filename="analytics-daily.csv" />
 */

interface Props {
  href: string;
  filename: string;
  label?: string;
}

export default function CsvButton({ href, filename, label = "Export CSV" }: Props): React.ReactElement {
  return (
    <a
      href={href}
      download={filename}
      className="admin-csv-btn"
      data-testid="csv-export"
    >
      {label}
    </a>
  );
}
