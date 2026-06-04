import { describe, it, expect } from "vitest";
import {
  assignArchetype,
  resolvePersonality,
  sampleBotPrice,
  sampleBotBid,
  snapToHumanPrice,
  type BotArchetype,
} from "./botPersonality";

describe("assignArchetype", () => {
  it("is deterministic for the same bot + room", () => {
    const a = assignArchetype("bot-1", "ROOM", "medium");
    const b = assignArchetype("bot-1", "ROOM", "medium");
    expect(a).toBe(b);
  });

  it("varies across different bot IDs", () => {
    const archetypes = new Set<BotArchetype>();
    for (let i = 0; i < 100; i++) {
      archetypes.add(assignArchetype(`bot-${i}`, "ROOM", "medium"));
    }
    // We should see more than one archetype in 100 draws
    expect(archetypes.size).toBeGreaterThan(1);
  });

  it("varies by room code (same bot, different rooms)", () => {
    const archetypes = new Set<BotArchetype>();
    for (let i = 0; i < 50; i++) {
      archetypes.add(assignArchetype("bot-1", `ROOM-${i}`, "medium"));
    }
    expect(archetypes.size).toBeGreaterThan(1);
  });

  it("hard mode produces experts more often than easy mode", () => {
    let hardExperts = 0;
    let easyExperts = 0;
    for (let i = 0; i < 500; i++) {
      if (assignArchetype(`bot-${i}`, "R", "hard") === "expert") hardExperts++;
      if (assignArchetype(`bot-${i}`, "R", "easy") === "expert") easyExperts++;
    }
    expect(hardExperts).toBeGreaterThan(easyExperts);
  });

  it("easy mode produces wild-cards more often than hard mode", () => {
    let hardWild = 0;
    let easyWild = 0;
    for (let i = 0; i < 500; i++) {
      if (assignArchetype(`bot-${i}`, "R", "hard") === "wild-card") hardWild++;
      if (assignArchetype(`bot-${i}`, "R", "easy") === "wild-card") easyWild++;
    }
    expect(easyWild).toBeGreaterThan(hardWild);
  });
});

describe("resolvePersonality", () => {
  it("returns a personality with all required params", () => {
    const p = resolvePersonality("bot-1", "ROOM", "medium");
    expect(p.archetype).toBeTruthy();
    expect(typeof p.bias).toBe("number");
    expect(p.sigma).toBeGreaterThan(0);
    expect(p.pClose + p.pModerate + p.pWild).toBeCloseTo(1, 2);
  });

  it("falls back to random archetype when no botId", () => {
    const p = resolvePersonality(undefined, undefined, "medium");
    expect(p.archetype).toBeTruthy();
  });
});

describe("snapToHumanPrice", () => {
  it("snaps sub-$20 to $X.99", () => {
    expect(snapToHumanPrice(1243)).toBe(1299);
    expect(snapToHumanPrice(899)).toBe(899);
  });

  it("produces round-looking output for $20-$100 range", () => {
    for (let i = 0; i < 20; i++) {
      const snapped = snapToHumanPrice(4732);
      // Should end in 00, 99, or 500
      expect(snapped % 500 === 0 || snapped % 1000 === 999).toBe(true);
    }
  });

  it("does not return negative values", () => {
    expect(snapToHumanPrice(1)).toBeGreaterThan(0);
    expect(snapToHumanPrice(50)).toBeGreaterThan(0);
  });

  it("snaps >$500 to nearest $25", () => {
    expect(snapToHumanPrice(87342) % 2500).toBe(0);
  });

  it("snaps $100-$500 to round $10s or $X9 charm prices", () => {
    for (let i = 0; i < 30; i++) {
      const snapped = snapToHumanPrice(24753);
      // Round $10 (ends in 000) OR $X9 charm (ends in 900)
      expect(snapped % 1000 === 0 || (snapped + 100) % 1000 === 0).toBe(true);
    }
  });
});

describe("sampleBotPrice — distribution shape", () => {
  function accuracyBand(sample: number, truth: number): string {
    const err = Math.abs(sample - truth) / truth;
    if (err <= 0.05) return "<=5%";
    if (err <= 0.15) return "5-15%";
    if (err <= 0.30) return "15-30%";
    if (err <= 0.60) return "30-60%";
    if (err <= 2.0) return "60-200%";
    return ">200%";
  }

  function runAcrossBots(difficulty: "easy" | "medium" | "hard", truth: number, botCount: number, runsPerBot: number) {
    const bands: Record<string, number> = { "<=5%": 0, "5-15%": 0, "15-30%": 0, "30-60%": 0, "60-200%": 0, ">200%": 0 };
    for (let b = 0; b < botCount; b++) {
      const personality = resolvePersonality(`bot-${b}`, "ROOM", difficulty);
      for (let i = 0; i < runsPerBot; i++) {
        const sample = sampleBotPrice(truth, personality);
        bands[accuracyBand(sample, truth)]++;
      }
    }
    const total = botCount * runsPerBot;
    const pct: Record<string, number> = {};
    for (const [k, v] of Object.entries(bands)) pct[k] = v / total;
    return pct;
  }

  it("medium difficulty: does NOT cluster tightly around price", () => {
    const pct = runAcrossBots("medium", 5000, 50, 40); // 2000 samples
    // "Within 5%" should be meaningful but not dominant — the whole point
    expect(pct["<=5%"]).toBeLessThan(0.45);
    expect(pct["<=5%"]).toBeGreaterThan(0.05);
    // We want a meaningful mass far off (30%+)
    const farOff = pct["30-60%"] + pct["60-200%"] + pct[">200%"];
    expect(farOff).toBeGreaterThan(0.10);
  });

  it("hard difficulty has more close guesses than easy", () => {
    const hard = runAcrossBots("hard", 5000, 50, 40);
    const easy = runAcrossBots("easy", 5000, 50, 40);
    expect(hard["<=5%"]).toBeGreaterThan(easy["<=5%"]);
  });

  it("easy difficulty has more far-off guesses than hard", () => {
    const hard = runAcrossBots("hard", 5000, 50, 40);
    const easy = runAcrossBots("easy", 5000, 50, 40);
    const hardFar = hard["30-60%"] + hard["60-200%"] + hard[">200%"];
    const easyFar = easy["30-60%"] + easy["60-200%"] + easy[">200%"];
    expect(easyFar).toBeGreaterThan(hardFar);
  });

  it("produces some guesses OVER the true price (not only below)", () => {
    // Critical: old bidding/closest bots always bid below. Generic sampler
    // should not have that bias — bidding's shade-down is applied separately.
    let over = 0;
    const personality = resolvePersonality("bot-x", "ROOM", "medium");
    for (let i = 0; i < 500; i++) {
      if (sampleBotPrice(5000, personality) > 5000) over++;
    }
    expect(over).toBeGreaterThan(50);
  });
});

describe("sampleBotBid — bidding wrapper", () => {
  it("returns a positive integer", () => {
    const p = resolvePersonality("bot-1", "R", "medium");
    const bid = sampleBotBid(5000, p);
    expect(bid).toBeGreaterThan(0);
    expect(Number.isInteger(bid)).toBe(true);
  });

  it("shade-down: most bids fall BELOW the true price", () => {
    const p = resolvePersonality("expert-bot", "R", "hard");
    let under = 0;
    for (let i = 0; i < 500; i++) {
      if (sampleBotBid(5000, p) < 5000) under++;
    }
    // Shade-down pulls below on average even with log-normal symmetry
    expect(under).toBeGreaterThan(275);
  });

  it("+$1 clip: clips at maxOther + 100 cents (one dollar) when last bidder", () => {
    // Build a personality guaranteed to prefer clip often
    const p = resolvePersonality("bot-1", "R", "hard");
    let clips = 0;
    for (let i = 0; i < 500; i++) {
      const bid = sampleBotBid(5000, p, {
        isLastBidder: true,
        previousBids: [
          { playerId: "p1", bidCents: 3000 },
          { playerId: "p2", bidCents: 3500 },
        ],
      });
      // Clip = maxOther (3500) + 100 = 3600
      if (bid === 3600) clips++;
    }
    expect(clips).toBeGreaterThan(0);
  });

  it("clip is skipped when clip value would exceed bot's estimate", () => {
    // Previous bid is wildly higher than the true price. The +$1 clip value
    // would land far above ANY plausible estimate → bot must fall back to
    // shade-down and never produce the exact clip value.
    const p = resolvePersonality("bot-1", "R", "hard");
    let clips = 0;
    for (let i = 0; i < 500; i++) {
      const bid = sampleBotBid(5000, p, {
        isLastBidder: true,
        previousBids: [{ playerId: "p1", bidCents: 100000 }],
      });
      if (bid === 100100) clips++;
    }
    expect(clips).toBe(0);
  });

  it("clip/gambit do NOT fire when bot is not the last bidder", () => {
    const p = resolvePersonality("bot-1", "R", "hard");
    let clips = 0;
    let gambits = 0;
    for (let i = 0; i < 500; i++) {
      const bid = sampleBotBid(5000, p, {
        isLastBidder: false,
        previousBids: [{ playerId: "p1", bidCents: 3500 }],
      });
      if (bid === 3600) clips++;
      if (bid === 1) gambits++;
    }
    expect(clips).toBe(0);
    expect(gambits).toBe(0);
  });

  it("$1 gambit: fires at roughly the wild-card gambitProb rate", () => {
    const p = resolvePersonality("wild-bot", "R", "easy");
    let gambits = 0;
    const TRIALS = 4000;
    for (let i = 0; i < TRIALS; i++) {
      const bid = sampleBotBid(5000, p, {
        isLastBidder: true,
        previousBids: [{ playerId: "p1", bidCents: 4000 }],
      });
      if (bid === 1) gambits++;
    }
    // gambitProb is 0.02-0.05 depending on archetype. Generous tolerance
    // keeps the test non-flaky while still proving the gambit is rare and nonzero.
    const rate = gambits / TRIALS;
    expect(rate).toBeGreaterThan(0.002);
    expect(rate).toBeLessThan(0.10);
  });
});

describe("copycat exploit — bidding mode", () => {
  it("mimicking the bot centroid does NOT dominate in bidding mode", () => {
    // Simulate a 4-player bidding room: 3 bots + 1 copycat.
    // Copycat places the average of observed bots' bids - $1 (optimal mimic).
    const TRIALS = 400;
    const TRUE_PRICE = 5000;
    let copycatWins = 0;

    for (let t = 0; t < TRIALS; t++) {
      const bots = [0, 1, 2].map((i) => {
        const personality = resolvePersonality(`bot-${i}`, `room-${t}`, "medium");
        return { id: `bot-${i}`, bid: sampleBotBid(TRUE_PRICE, personality) };
      });

      const avg = Math.round(bots.reduce((s, b) => s + b.bid, 0) / bots.length);
      const copycatBid = Math.max(1, avg - 1);

      // Score: closest-without-going-over wins
      const all = [...bots.map((b) => ({ id: b.id, bid: b.bid })), { id: "copycat", bid: copycatBid }];
      const valid = all.filter((x) => x.bid <= TRUE_PRICE);
      if (valid.length === 0) continue;
      valid.sort((a, b) => b.bid - a.bid);
      if (valid[0].id === "copycat") copycatWins++;
    }

    const winRate = copycatWins / TRIALS;
    // Today's bots: copycat wins >70%+ of the time (predictable cluster).
    // Target: well below 50% so the naive mimic strategy no longer dominates.
    expect(winRate).toBeLessThan(0.50);
  });
});
