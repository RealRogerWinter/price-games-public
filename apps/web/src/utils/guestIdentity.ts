import type { Avatar } from "@price-game/shared";
import { RANDOMIZABLE_AVATARS, isValidProfileAvatar } from "@price-game/shared";

const MAX_HANDLE_LENGTH = 64;

const STORAGE_KEY = "guest_identity_v1";

/**
 * localStorage key used by the multiplayer surfaces to remember a custom
 * display name an anon player explicitly typed. When present this overrides
 * the guest handle for MP contexts only; single-player always uses the guest
 * handle so the identity is stable across reloads.
 */
export const MP_DISPLAY_NAME_KEY = "mp_display_name";

const ADJECTIVES = [
  "Cosmic", "Jolly", "Frosty", "Lucky", "Sneaky", "Royal", "Dapper", "Sassy",
  "Mighty", "Glittery", "Turbo", "Witty", "Spicy", "Plucky", "Zesty", "Mellow",
  "Cheeky", "Bouncy", "Stellar", "Velvet", "Gilded", "Rusty", "Neon", "Crispy",
  "Drifting", "Rambling", "Brash", "Dizzy", "Nimble", "Smug", "Cozy", "Bold",
  "Quiet", "Wild", "Tidy", "Fancy", "Soggy", "Loyal", "Curious", "Merry",
] as const;

const NOUNS = [
  "Otter", "Pickle", "Falcon", "Penguin", "Walrus", "Goblin", "Cactus", "Comet",
  "Pancake", "Bandit", "Mango", "Wombat", "Yeti", "Pixel", "Pirate", "Noodle",
  "Phantom", "Rascal", "Sparrow", "Beetle", "Sloth", "Muffin", "Dolphin",
  "Rocket", "Lantern", "Vortex", "Acorn", "Badger", "Crumpet", "Donut",
  "Gizmo", "Hamster", "Iguana", "Jellybean", "Koala", "Lobster", "Marmot",
  "Narwhal", "Octopus", "Quokka",
] as const;

export interface GuestIdentity {
  handle: string;
  avatar: Avatar;
}

function randomFrom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

function generate(): GuestIdentity {
  return {
    handle: `${randomFrom(ADJECTIVES)} ${randomFrom(NOUNS)}`,
    avatar: randomFrom(RANDOMIZABLE_AVATARS),
  };
}

/**
 * Returns the persisted guest identity, generating and storing a fresh one on
 * first call. Used by the gameplay IdentityCard to give anonymous players a
 * memorable handle + avatar so the "save my score" CTA has something concrete
 * to attach to instead of an empty profile.
 */
export function getOrCreateGuestIdentity(): GuestIdentity {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<GuestIdentity>;
      // Cap the handle length and validate the avatar against the live
      // avatar set so a tampered localStorage value can't render an
      // arbitrarily long string or a non-existent avatar id.
      if (
        typeof parsed.handle === "string" &&
        parsed.handle.length > 0 &&
        isValidProfileAvatar(parsed.avatar)
      ) {
        return {
          handle: parsed.handle.slice(0, MAX_HANDLE_LENGTH),
          avatar: parsed.avatar as Avatar,
        };
      }
    }
  } catch {
    // Storage disabled or corrupted — fall through to generate.
  }
  const fresh = generate();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
  } catch {
    // Storage unavailable — identity won't persist across reloads, acceptable.
  }
  return fresh;
}

/**
 * Read the multiplayer display-name override, if any.
 *
 * Returns the trimmed value from `localStorage[MP_DISPLAY_NAME_KEY]` when
 * non-empty, otherwise `null`. This is separate from the guest handle so
 * single-player surfaces stay anchored to the guest identity even when a
 * player has customized their MP name.
 */
export function getMultiplayerDisplayNameOverride(): string | null {
  try {
    const raw = localStorage.getItem(MP_DISPLAY_NAME_KEY);
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim().slice(0, MAX_HANDLE_LENGTH);
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective display name for an anonymous player, preferring
 * their explicit multiplayer override and falling back to the persistent
 * guest handle. Used everywhere an anon player's name needs to be sent to
 * the server or rendered as a label — ensures we never reach for yet another
 * ad-hoc "PlayerNNNN" random string.
 */
export function getEffectiveAnonDisplayName(): string {
  return getMultiplayerDisplayNameOverride() ?? getOrCreateGuestIdentity().handle;
}
