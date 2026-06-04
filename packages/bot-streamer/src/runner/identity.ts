/**
 * Identity bootstrap — seeds the bot's Chromium instance with the
 * same localStorage keys a regular price.games user would have. This
 * lets the server treat the bot as an existing returning anonymous
 * client, with a stable handle + avatar across container restarts.
 *
 * Runs as an `addInitScript` so the values are present before the
 * page's React boots and reads them.
 */

import type { PersonaProfile } from "../persona/profile";

interface IdentitySnippet {
  guestIdentity: { handle: string; avatar: string };
  multiplayerDisplayName: string;
}

export function buildIdentitySnippet(persona: PersonaProfile): IdentitySnippet {
  return {
    guestIdentity: { handle: persona.name, avatar: persona.avatar },
    multiplayerDisplayName: persona.name,
  };
}

/**
 * The script body that gets injected via Playwright's
 * `page.addInitScript`. Inlines the persona values rather than
 * referencing them by closure — addInitScript serializes its argument,
 * not the surrounding scope.
 */
export function identityInitScript(snippet: IdentitySnippet): string {
  // Stringify the snippet to a constant the script can read.
  const payload = JSON.stringify(snippet);
  // Single quotes around the IIFE; payload is JSON so it's safe.
  return `
    (function() {
      try {
        const p = ${payload};
        localStorage.setItem('guest_identity_v1', JSON.stringify(p.guestIdentity));
        localStorage.setItem('mp_display_name', p.multiplayerDisplayName);
      } catch (e) {
        // Localstorage might be blocked (private mode, etc.). The
        // page still works; the bot just shows up with a different
        // anonymous handle.
        console.error('[bot-streamer] identity seed failed', e);
      }
    })();
  `;
}
