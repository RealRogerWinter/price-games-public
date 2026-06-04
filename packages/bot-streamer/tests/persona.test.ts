import { describe, it, expect } from "vitest";
import { loadPersonaFromEnv, DEFAULT_PERSONA } from "../src/persona/profile";
import { nextMood, INITIAL_MOOD, formatMoodTransition, resolveMood } from "../src/persona/mood";

describe("loadPersonaFromEnv", () => {
  it("returns the default persona when no env vars are set", () => {
    const p = loadPersonaFromEnv({});
    expect(p).toEqual(DEFAULT_PERSONA);
  });

  it("trims and length-clamps the display name", () => {
    const p = loadPersonaFromEnv({
      STREAMER_BOT_DISPLAY_NAME: "  Pricey-Bot-9000-with-a-very-very-long-suffix  ",
    });
    expect(p.name.length).toBeLessThanOrEqual(32);
    expect(p.name).toBe("Pricey-Bot-9000-with-a-very-very");
  });

  it("rejects an unsafe avatar slug and falls back to the default", () => {
    const p = loadPersonaFromEnv({ STREAMER_BOT_AVATAR: "../../../etc/passwd" });
    expect(p.avatar).toBe(DEFAULT_PERSONA.avatar);
  });

  it("accepts a sane avatar slug verbatim", () => {
    const p = loadPersonaFromEnv({ STREAMER_BOT_AVATAR: "pirate" });
    expect(p.avatar).toBe("pirate");
  });

  it("accepts a numeric skill temperature in range", () => {
    const p = loadPersonaFromEnv({ STREAMER_SKILL_TEMPERATURE: "0.7" });
    expect(p.skillTemperature).toBe(0.7);
  });

  it("ignores out-of-range or non-numeric temperatures", () => {
    expect(loadPersonaFromEnv({ STREAMER_SKILL_TEMPERATURE: "-1" }).skillTemperature)
      .toBe(DEFAULT_PERSONA.skillTemperature);
    expect(loadPersonaFromEnv({ STREAMER_SKILL_TEMPERATURE: "10" }).skillTemperature)
      .toBe(DEFAULT_PERSONA.skillTemperature);
    expect(loadPersonaFromEnv({ STREAMER_SKILL_TEMPERATURE: "nope" }).skillTemperature)
      .toBe(DEFAULT_PERSONA.skillTemperature);
  });

  it("defaults moodInfluence to 1 — mood pipeline ships live", () => {
    // Flipped from 0 to 1 in the cleanup PR after PR #298 + #302
    // landed and the adversarial vitests pinned lock-in invariants.
    // Operators reverting to inert pass STREAMER_MOOD_INFLUENCE=0.
    expect(DEFAULT_PERSONA.moodInfluence).toBe(1);
    expect(loadPersonaFromEnv({}).moodInfluence).toBe(1);
  });

  it("accepts a numeric STREAMER_MOOD_INFLUENCE in [0, 1]", () => {
    expect(loadPersonaFromEnv({ STREAMER_MOOD_INFLUENCE: "0" }).moodInfluence).toBe(0);
    expect(loadPersonaFromEnv({ STREAMER_MOOD_INFLUENCE: "0.5" }).moodInfluence).toBe(0.5);
    expect(loadPersonaFromEnv({ STREAMER_MOOD_INFLUENCE: "1" }).moodInfluence).toBe(1);
  });

  it("rejects out-of-range or non-numeric mood-influence and falls back to 0", () => {
    // Out-of-range falls back to the default (0) — a fat-fingered
    // env var leaves the bot in a known-good state (cosmetic mood
    // only) rather than something behaviourally novel.
    expect(loadPersonaFromEnv({ STREAMER_MOOD_INFLUENCE: "-0.1" }).moodInfluence)
      .toBe(DEFAULT_PERSONA.moodInfluence);
    expect(loadPersonaFromEnv({ STREAMER_MOOD_INFLUENCE: "1.5" }).moodInfluence)
      .toBe(DEFAULT_PERSONA.moodInfluence);
    expect(loadPersonaFromEnv({ STREAMER_MOOD_INFLUENCE: "nope" }).moodInfluence)
      .toBe(DEFAULT_PERSONA.moodInfluence);
    expect(loadPersonaFromEnv({ STREAMER_MOOD_INFLUENCE: "" }).moodInfluence)
      .toBe(DEFAULT_PERSONA.moodInfluence);
    // Whitespace-only — `.trim()` is novel logic added in the
    // cleanup PR; pin that it routes to the default rather than to
    // `Number(' ')` which is 0.
    expect(loadPersonaFromEnv({ STREAMER_MOOD_INFLUENCE: "   " }).moodInfluence)
      .toBe(DEFAULT_PERSONA.moodInfluence);
    expect(loadPersonaFromEnv({ STREAMER_MOOD_INFLUENCE: "\t\n " }).moodInfluence)
      .toBe(DEFAULT_PERSONA.moodInfluence);
  });

  it("forwards the voice when set, undefined otherwise", () => {
    expect(loadPersonaFromEnv({}).voice).toBeUndefined();
    expect(loadPersonaFromEnv({ STREAMER_TTS_VOICE: "en_US-amy-medium" }).voice)
      .toBe("en_US-amy-medium");
  });

  it("rejects voices that contain shell metacharacters or path separators", () => {
    // Forward-protection: the voice slug flows into the Piper CLI args
    // in PR 13 and must not be a shell-injection vector.
    expect(loadPersonaFromEnv({ STREAMER_TTS_VOICE: "voice;rm -rf /" }).voice).toBeUndefined();
    expect(loadPersonaFromEnv({ STREAMER_TTS_VOICE: "../etc/passwd" }).voice).toBeUndefined();
    expect(loadPersonaFromEnv({ STREAMER_TTS_VOICE: "voice with spaces" }).voice).toBeUndefined();
    expect(loadPersonaFromEnv({ STREAMER_TTS_VOICE: "$(whoami)" }).voice).toBeUndefined();
  });

  it("rejects voices longer than the 64-char cap", () => {
    expect(loadPersonaFromEnv({ STREAMER_TTS_VOICE: "x".repeat(65) }).voice).toBeUndefined();
    expect(loadPersonaFromEnv({ STREAMER_TTS_VOICE: "x".repeat(64) }).voice).toBe("x".repeat(64));
  });
});

describe("INITIAL_MOOD (v2 shape)", () => {
  it("starts neutral with all hidden axes zeroed", () => {
    expect(INITIAL_MOOD.mood).toBe("neutral");
    expect(INITIAL_MOOD.vibe).toBe(0);
    expect(INITIAL_MOOD.morale).toBe(0);
    expect(INITIAL_MOOD.streak).toBe(0);
  });
});

describe("nextMood — round_outcome", () => {
  it("flips to happy after several wins (vibe crosses high threshold)", () => {
    let s = INITIAL_MOOD;
    for (let i = 0; i < 4; i++) s = nextMood(s, { kind: "round_outcome", outcome: "win" });
    expect(s.mood).toBe("happy");
    expect(s.streak).toBe(4);
    expect(s.vibe).toBeGreaterThan(1.5);
    // Morale untouched by per-round events.
    expect(s.morale).toBe(0);
  });

  it("flips to frustrated after several losses (no morale signal)", () => {
    let s = INITIAL_MOOD;
    for (let i = 0; i < 4; i++) s = nextMood(s, { kind: "round_outcome", outcome: "loss" });
    expect(s.mood).toBe("frustrated");
    expect(s.streak).toBe(-4);
    expect(s.vibe).toBeLessThan(-1.5);
    expect(s.morale).toBe(0);
  });

  it("a single loss after a strong streak does NOT immediately flip the mood (slower v2 decay)", () => {
    let s = INITIAL_MOOD;
    for (let i = 0; i < 4; i++) s = nextMood(s, { kind: "round_outcome", outcome: "win" });
    expect(s.mood).toBe("happy");
    s = nextMood(s, { kind: "round_outcome", outcome: "loss" });
    expect(s.mood).not.toBe("frustrated");
    expect(s.mood).not.toBe("despondent");
  });

  it("resets streak to ±1 on outcome flip", () => {
    let s = INITIAL_MOOD;
    s = nextMood(s, { kind: "round_outcome", outcome: "win" });
    s = nextMood(s, { kind: "round_outcome", outcome: "win" });
    expect(s.streak).toBe(2);
    s = nextMood(s, { kind: "round_outcome", outcome: "loss" });
    expect(s.streak).toBe(-1);
    s = nextMood(s, { kind: "round_outcome", outcome: "win" });
    expect(s.streak).toBe(1);
  });

  it("vibe is bounded to [-3, 3] regardless of how many wins/losses pile up", () => {
    let s = INITIAL_MOOD;
    for (let i = 0; i < 50; i++) s = nextMood(s, { kind: "round_outcome", outcome: "win" });
    expect(s.vibe).toBeLessThanOrEqual(3);
    for (let i = 0; i < 100; i++) s = nextMood(s, { kind: "round_outcome", outcome: "loss" });
    expect(s.vibe).toBeGreaterThanOrEqual(-3);
  });
});

describe("nextMood — game_outcome (morale EMA)", () => {
  it("morale moves toward +1 with consecutive game wins, never exceeding 1", () => {
    let s = INITIAL_MOOD;
    for (let i = 0; i < 30; i++) s = nextMood(s, { kind: "game_outcome", win: true });
    expect(s.morale).toBeGreaterThan(0.95);
    expect(s.morale).toBeLessThanOrEqual(1);
    // Vibe / streak untouched by game_outcome.
    expect(s.vibe).toBe(0);
    expect(s.streak).toBe(0);
  });

  it("morale moves toward -1 with consecutive game losses, never below -1", () => {
    let s = INITIAL_MOOD;
    for (let i = 0; i < 30; i++) s = nextMood(s, { kind: "game_outcome", win: false });
    expect(s.morale).toBeLessThan(-0.95);
    expect(s.morale).toBeGreaterThanOrEqual(-1);
  });

  it("morale recovers gradually after a flip — single win after a long losing streak doesn't reach 0", () => {
    let s = INITIAL_MOOD;
    for (let i = 0; i < 20; i++) s = nextMood(s, { kind: "game_outcome", win: false });
    const beforeRecovery = s.morale;
    expect(beforeRecovery).toBeLessThan(-0.9);
    s = nextMood(s, { kind: "game_outcome", win: true });
    expect(s.morale).toBeGreaterThan(beforeRecovery);
    expect(s.morale).toBeLessThan(0); // single win not enough to flip the long-term arc
  });
});

describe("resolveMood — 8-mood decision table", () => {
  it("vibe high + morale high → elated", () => {
    expect(resolveMood(2.5, 0.6, 5)).toBe("elated");
  });

  it("vibe high + morale neutral → happy", () => {
    expect(resolveMood(2.0, 0, 4)).toBe("happy");
    expect(resolveMood(1.5, -0.3, 1)).toBe("happy");
  });

  it("vibe neutral + morale high (no streak) → confident", () => {
    expect(resolveMood(0.5, 0.5, 1)).toBe("confident");
    expect(resolveMood(-0.5, 0.5, 0)).toBe("confident");
  });

  it("vibe neutral + streak ≥ 3 → focused (streak outranks morale)", () => {
    expect(resolveMood(0.5, 0, 3)).toBe("focused");
    expect(resolveMood(-0.2, 0, -4)).toBe("focused");
  });

  it("vibe neutral + streak ≥ 3 + morale high → focused (NOT confident — addresses PR #291 review)", () => {
    // Streak-driven label outranks morale-driven so a strong groove
    // is never silently relabelled to "confident".
    expect(resolveMood(0.5, 0.6, 4)).toBe("focused");
    // And so a long LOSING streak with high morale doesn't read as
    // "confident" (which was the counterintuitive bug).
    expect(resolveMood(-0.5, 0.6, -4)).toBe("focused");
  });

  it("vibe neutral + morale low → tilted (long-term down, present neutral)", () => {
    expect(resolveMood(0, -0.5, 0)).toBe("tilted");
  });

  it("vibe low + morale low → despondent", () => {
    expect(resolveMood(-2.0, -0.6, -3)).toBe("despondent");
  });

  it("vibe low + morale neutral → frustrated", () => {
    expect(resolveMood(-2.0, 0, -2)).toBe("frustrated");
  });

  it("vibe low + morale high → neutral (long-term arc cancels the dip; no flicker against tilted)", () => {
    // Used to return "tilted" but that label was also assigned to the
    // mid-band+morale-low branch, producing flicker between the two
    // branches as vibe oscillated near ±1.5. Routing here to neutral
    // removes the flicker; the long-term positive arc legitimately
    // cancels the present dip.
    expect(resolveMood(-2.0, 0.5, -2)).toBe("neutral");
  });

  it("falls back to neutral in the middle band with no streak or morale signal", () => {
    expect(resolveMood(0, 0, 0)).toBe("neutral");
    expect(resolveMood(0.3, 0.1, 1)).toBe("neutral");
  });

  it("threshold equalities lean to the threshold side (>= / <=)", () => {
    // Pin the boundary semantics so a future tweak (>= vs >) doesn't
    // silently shift mood across thousands of borderline rounds.
    expect(resolveMood(1.5, 0, 0)).toBe("happy"); // vibe >= 1.5
    expect(resolveMood(-1.5, 0, 0)).toBe("frustrated"); // vibe <= -1.5
    expect(resolveMood(0, 0.4, 0)).toBe("confident"); // morale >= 0.4
    expect(resolveMood(0, -0.4, 0)).toBe("tilted"); // morale <= -0.4
    expect(resolveMood(0, 0, 3)).toBe("focused"); // streak >= 3
    expect(resolveMood(0, 0, -3)).toBe("focused"); // streak <= -3
  });
});

describe("formatMoodTransition (v2 shape)", () => {
  it("round_outcome emits a single line with kind, vibes, morale, streak, mood", () => {
    const prev = INITIAL_MOOD;
    const input = { kind: "round_outcome", outcome: "win" } as const;
    const next = nextMood(prev, input);
    const line = formatMoodTransition(prev, next, input);
    expect(line).toBe(
      `[mood] outcome=win vibe=0.00→1.00 morale=0.00→0.00 streak=0→1 mood=neutral→neutral`,
    );
  });

  it("game_outcome emits the game= tag instead of outcome=", () => {
    const prev = INITIAL_MOOD;
    const input = { kind: "game_outcome", win: true } as const;
    const next = nextMood(prev, input);
    const line = formatMoodTransition(prev, next, input);
    expect(line).toMatch(/^\[mood\] game=win /);
    expect(line).toMatch(/morale=0\.00→0\.18/);
  });

  it("a long losing streak round_outcome reads as expected", () => {
    let s = INITIAL_MOOD;
    for (let i = 0; i < 3; i++) s = nextMood(s, { kind: "round_outcome", outcome: "loss" });
    const input = { kind: "round_outcome", outcome: "loss" } as const;
    const next = nextMood(s, input);
    const line = formatMoodTransition(s, next, input);
    expect(line).toMatch(/outcome=loss/);
    expect(line).toMatch(/mood=\w+→frustrated/);
    expect(line).toMatch(/streak=-3→-4/);
  });
});
