/**
 * Runtime config helpers — parse + validate the streamer's env-var
 * inputs into the shapes the lifecycle policy expects. Kept as pure
 * functions so they're trivially unit-testable.
 */

import type { BotDifficulty, GameMode } from "@price-game/shared";
import { BOT_DIFFICULTIES, VALID_GAME_MODES } from "@price-game/shared";

export type RotationStep = "solo" | "public_join" | "host_public" | "quickplay_bidding";

const VALID_STEPS = new Set<RotationStep>([
  "solo",
  "public_join",
  "host_public",
  "quickplay_bidding",
]);

/**
 * Parse a comma-separated rotation override (e.g. "solo,solo,host_public").
 * Unknown tokens are dropped with a warning and never reach the policy.
 *
 * @param raw The env-var value, or undefined.
 * @param onWarn Optional sink for "dropped invalid token" warnings; defaults to console.warn.
 * @returns Validated rotation array, or undefined if the input is empty/all-invalid.
 */
export function parseRotation(
  raw: string | undefined,
  onWarn: (msg: string) => void = (m) => console.warn(m),
): RotationStep[] | undefined {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return undefined;
  const tokens = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  const valid: RotationStep[] = [];
  for (const tok of tokens) {
    if (VALID_STEPS.has(tok as RotationStep)) {
      valid.push(tok as RotationStep);
    } else {
      onWarn(`[runner] STREAMER_ROTATION: dropping unknown step "${tok}"`);
    }
  }
  return valid.length > 0 ? valid : undefined;
}

/**
 * Parse a comma-separated mode whitelist (e.g. "classic,higher-lower").
 * Tokens not in shared `VALID_GAME_MODES` are dropped with a warning so
 * a typo can't silently widen the rotation to unsupported modes.
 *
 * @param raw The env-var value, or undefined.
 * @param onWarn Optional sink for "dropped invalid token" warnings; defaults to console.warn.
 * @returns Validated mode array, or undefined if the input is empty/all-invalid.
 */
export function parseModeWhitelist(
  raw: string | undefined,
  onWarn: (msg: string) => void = (m) => console.warn(m),
): GameMode[] | undefined {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return undefined;
  const tokens = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  const valid: GameMode[] = [];
  for (const tok of tokens) {
    if (VALID_GAME_MODES.has(tok)) {
      valid.push(tok as GameMode);
    } else {
      onWarn(`[runner] STREAMER_MODES: dropping unknown mode "${tok}"`);
    }
  }
  return valid.length > 0 ? valid : undefined;
}

/**
 * Phase 3d.2: parse `STREAMER_BIDDING_BOT_DIFFICULTY` into the
 * shared `BotDifficulty` type. Falls through to `undefined` for
 * empty / invalid input — caller defaults to "medium".
 */
export function parseBiddingBotDifficulty(
  raw: string | undefined,
  onWarn: (msg: string) => void = (m) => console.warn(m),
): BotDifficulty | undefined {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed) return undefined;
  if ((BOT_DIFFICULTIES as readonly string[]).includes(trimmed)) {
    return trimmed as BotDifficulty;
  }
  onWarn(`[runner] STREAMER_BIDDING_BOT_DIFFICULTY: unknown value "${trimmed}", falling back to default`);
  return undefined;
}
