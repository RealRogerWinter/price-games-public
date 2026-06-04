import React from "react";
import ReactDOM from "react-dom/client";
import { loadGA } from "./utils/analytics";
import { loadRedditPixel } from "./utils/redditPixel";
import { captureUtmFromUrl, trackAttributionOnServer } from "./utils/attribution";
import { getPreferences } from "./utils/cookieConsent";
import App from "./App";
import "./index.css";

// After a deployment, users with a cached index.html may try to load JS chunks
// that no longer exist (hash changed). Vite fires this event when a dynamic
// import's modulepreload fails. We reload once to pick up the new index.html.
// The timestamp-based guard allows retries after 30 seconds while still
// preventing tight reload loops.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  const key = "vite-chunk-reload";
  const lastReload = Number(sessionStorage.getItem(key) || "0");
  if (Date.now() - lastReload > 30_000) {
    sessionStorage.setItem(key, String(Date.now()));
    window.location.reload();
  }
});

// UTM attribution capture + server binding are marketing-analytics actions,
// so they must wait for analytics consent. For returning visitors who
// already accepted we run them here against the landing URL; first-time
// visitors have this triggered from CookieConsent at the moment they accept
// (the URL is still the landing URL since they haven't navigated yet).
if (getPreferences().analytics) {
  captureUtmFromUrl();
  void trackAttributionOnServer();
}

// Initialize GA and the Reddit Pixel immediately — before React renders — so
// they don't depend on any component mounting successfully. Both default to
// consent denied; CookieConsent grants consent when the user accepts.
loadGA();
loadRedditPixel();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
