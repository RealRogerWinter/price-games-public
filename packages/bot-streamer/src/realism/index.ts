/**
 * Realism layer for the 24/7 bot streamer.
 *
 * Each module is a pure function (or pair of pure functions) that maps
 * the bot's logical decisions into humanlike timing, motion, or stochastic
 * choices. Strategies stay declarative ("click this selector"); the
 * realism wrappers turn that into a believable input sequence.
 *
 * All randomness is injectable via a `rng?: () => number` parameter so
 * tests can pass a seeded RNG and assert deterministic behaviour.
 */

export * from "./mouse";
export * from "./typing";
export * from "./timing";
export * from "./softmax";
