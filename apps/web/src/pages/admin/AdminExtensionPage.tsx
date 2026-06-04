/**
 * Admin page with Chrome extension download link and installation instructions.
 */

export default function AdminExtensionPage() {
  return (
    <div className="admin-container">
      <h1 className="admin-page-title">Chrome Extension</h1>

      <section className="admin-section">
        <h2>Amazon Product Importer</h2>
        <p style={{ marginBottom: 16, color: "#b0b0b0", lineHeight: 1.6 }}>
          The Price Games Chrome extension lets you import products directly from
          Amazon product pages with one click. Browse Amazon, preview the scraped
          data, and import it straight into the database.
        </p>

        <div style={{ background: "#16213e", borderRadius: 8, padding: 20, marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>Download</h3>
          <p style={{ color: "#b0b0b0", marginBottom: 16 }}>
            Click below to download the extension as a .zip file. Extract it and
            load it as an unpacked extension in Chrome.
          </p>
          <a
            href="/api/admin/extension/download"
            style={{
              display: "inline-block",
              padding: "12px 24px",
              background: "#6c5ce7",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              fontSize: 15,
              fontWeight: 600,
              cursor: "pointer",
              textDecoration: "none",
            }}
          >
            Download Extension (.zip)
          </a>
        </div>
      </section>

      <section className="admin-section">
        <h2>Installation</h2>
        <ol className="admin-install-steps">
          <li>Download the .zip file using the button above</li>
          <li>Extract the zip to a folder on your PC</li>
          <li>
            Open Chrome and navigate to{" "}
            <code>chrome://extensions</code>
          </li>
          <li>
            Enable <strong>Developer mode</strong> using the toggle in the top-right corner
          </li>
          <li>
            Click <strong>Load unpacked</strong> and select the extracted folder
          </li>
          <li>
            The Price Games icon will appear in your browser toolbar. Pin it for easy access.
          </li>
        </ol>
      </section>

      <section className="admin-section">
        <h2>Usage</h2>
        <ol className="admin-install-steps">
          <li>Click the extension icon and log in with your admin credentials</li>
          <li>Navigate to any Amazon product page</li>
          <li>Click the extension icon again &mdash; the product data will be scraped automatically</li>
          <li>Review the preview, adjust the category if needed, and click <strong>Import to Price Games</strong></li>
          <li>
            If the ASIN already exists in the database the product will be <em>updated</em>;
            otherwise a new product is created
          </li>
        </ol>
      </section>

      <section className="admin-section">
        <h2>Permissions</h2>
        <p style={{ color: "#b0b0b0", lineHeight: 1.6 }}>
          Only admin accounts with the <strong>can_use_extension</strong> flag enabled can
          use the extension. If you see a &ldquo;403 Extension access not permitted&rdquo;
          error, ask a database admin to set your flag:
        </p>
        <pre className="admin-code-block">{`UPDATE admin_users SET can_use_extension = 1 WHERE username = 'yourname';`}</pre>
      </section>

      <section className="admin-section">
        <h2>Troubleshooting</h2>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Problem</th>
              <th>Solution</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>&ldquo;Navigate to an Amazon product page&rdquo;</td>
              <td>Make sure you are on a <code>/dp/</code> or <code>/gp/product/</code> URL</td>
            </tr>
            <tr>
              <td>Price shows &ldquo;unavailable&rdquo;</td>
              <td>Some product pages use dynamic pricing; refresh and try again</td>
            </tr>
            <tr>
              <td>403 on login</td>
              <td>Your account needs the <code>can_use_extension</code> flag</td>
            </tr>
            <tr>
              <td>Network / CORS errors</td>
              <td>
                The server needs the <code>CHROME_EXTENSION_ID</code> env var set to your
                extension&rsquo;s ID (shown on <code>chrome://extensions</code>)
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}
