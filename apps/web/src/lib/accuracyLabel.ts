/**
 * Accuracy label driven by `pctOff`, not by `score`. Score is the mode-specific
 * ledger; this label is a universal "narrator" that reads the same across modes.
 * A 30%-off guess always reads "Rough Swing" whether you're playing Classic,
 * Closest, Riser, or Bidding War — even if the numeric scores differ per curve.
 *
 * The tail tiers are deliberately snarky so the label never contradicts the
 * score: a 1-point score paired with "Not Bad" was self-contradictory. A
 * 1-point score paired with "Things Cost Money, Friend" tells the player
 * we noticed the lowball without being cruel.
 *
 * @param pctOff Fractional error (0 = exact, 1 = 100% off).
 * @returns Label text and CSS tier class.
 */
export function getAccuracyLabel(pctOff: number): { text: string; className: string } {
  if (pctOff === 0)   return { text: "PIXEL PERFECT!",           className: "tier-exact" };
  if (pctOff <= 0.01) return { text: "Laser-Guided",              className: "tier-incredible" };
  if (pctOff <= 0.03) return { text: "Sharpshooter",              className: "tier-sharp" };
  if (pctOff <= 0.07) return { text: "Dialed In",                 className: "tier-close" };
  if (pctOff <= 0.12) return { text: "In the Ballpark",           className: "tier-nice" };
  if (pctOff <= 0.20) return { text: "Solid Guess",               className: "tier-ok" };
  if (pctOff <= 0.30) return { text: "Rough Swing",               className: "tier-rough" };
  if (pctOff <= 0.45) return { text: "Way Off",                   className: "tier-far" };
  if (pctOff <= 0.60) return { text: "Did You Even Look?",        className: "tier-miss" };
  if (pctOff <= 0.80) return { text: "Are You Bidding in Yen?",   className: "tier-yen" };
  if (pctOff <= 1.20) return { text: "Things Cost Money, Friend", className: "tier-proTip" };
  return                     { text: "Technically a Number",      className: "tier-hopeless" };
}
