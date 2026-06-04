/**
 * Service worker for Price Games push notifications.
 *
 * Handles incoming push events, displays notifications, processes clicks
 * with deep linking, and manages subscription changes.
 */

/* eslint-env serviceworker */
/* global self, clients */

// Push event — display the notification
self.addEventListener("push", (event) => {
  let data = { title: "Price Games", body: "You have a notification!" };

  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch {
      data.body = event.data.text();
    }
  }

  const silent = data.silent || false;

  const options = {
    body: data.body,
    // Small icon shown next to the title on all platforms.
    icon: data.icon || "/logo192.png",
    // Pure-white-on-transparent silhouette for the Android status bar.
    // Android ignores RGB and uses only the alpha channel, so this asset
    // must be monochrome (see /badge-96.png).
    badge: data.badge || "/badge-96.png",
    tag: data.tag || "default",
    // Default to quiet replacement when a tag is reused — re-alerting on every
    // push with the same tag is a known spam-classifier signal on Chrome mobile.
    // Callers can opt into `renotify: true` when genuinely time-sensitive.
    renotify: data.renotify === true,
    data: { url: data.url || "/" },
    requireInteraction: data.requireInteraction || false,
    silent,
    // Help Android order notifications correctly when several arrive together.
    // Use `??` so an explicit `timestamp: 0` (epoch) is preserved, not overridden.
    timestamp: data.timestamp ?? Date.now(),
  };

  // Only include a hero image when the server explicitly provides one.
  // Always-on hero images inflate notification weight without user benefit
  // and contribute to Chrome's abusive-notification classification.
  if (data.image) {
    options.image = data.image;
  }

  // Short vibration pattern on mobile — suppressed when silent.
  if (!silent) {
    options.vibrate = Array.isArray(data.vibrate) ? data.vibrate : [120, 60, 120];
  }

  // Add action buttons if provided
  if (data.actions && Array.isArray(data.actions)) {
    options.actions = data.actions;
  }

  event.waitUntil(self.registration.showNotification(data.title, options));
});

// Notification click — navigate to the target URL
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  let targetUrl = event.notification.data?.url || "/";

  // Handle action buttons
  if (event.action === "play") {
    targetUrl = "/daily";
  } else if (event.action === "dismiss") {
    return;
  }

  // Prevent open redirect — only allow same-origin URLs
  try {
    const resolved = new URL(targetUrl, self.location.origin);
    if (resolved.origin !== self.location.origin) {
      targetUrl = "/";
    }
  } catch {
    targetUrl = "/";
  }

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Try to focus an existing tab
        for (const client of clientList) {
          if (new URL(client.url).origin === self.location.origin && "focus" in client) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }
        // Open new tab
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      })
  );
});

// Subscription change — re-subscribe and update the server
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    self.registration.pushManager
      .subscribe(event.oldSubscription?.options || { userVisibleOnly: true })
      .then((newSub) => {
        return fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(newSub.toJSON()),
        });
      })
      .catch((err) => {
        console.error("Failed to re-subscribe after pushsubscriptionchange:", err);
      })
  );
});
