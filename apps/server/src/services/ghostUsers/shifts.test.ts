import { describe, it, expect } from "vitest";
import {
  sampleShiftDurationMs,
  sampleNextShiftStart,
  shouldTakeBreak,
  sampleBreakDurationMs,
  hourWeightForLocalHour,
  PEAK_HOURS,
} from "./shifts";

describe("sampleShiftDurationMs", () => {
  it("always returns a duration between 5 and 90 minutes", () => {
    for (let i = 0; i < 1000; i++) {
      const ms = sampleShiftDurationMs();
      const minutes = ms / 60_000;
      expect(minutes).toBeGreaterThanOrEqual(5);
      expect(minutes).toBeLessThanOrEqual(90);
    }
  });

  it("median is in the realistic 15-40 minute band", () => {
    const samples = Array.from({ length: 5000 }, () => sampleShiftDurationMs() / 60_000);
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    expect(median).toBeGreaterThan(15);
    expect(median).toBeLessThan(40);
  });
});

describe("hourWeightForLocalHour", () => {
  it("peak hours weigh more than off-peak", () => {
    const peakWeight = hourWeightForLocalHour(20); // 8pm
    const offPeak = hourWeightForLocalHour(4);     // 4am
    expect(peakWeight).toBeGreaterThan(offPeak);
  });

  it("3am-6am are the trough", () => {
    for (const h of [3, 4, 5]) {
      expect(hourWeightForLocalHour(h)).toBeLessThan(hourWeightForLocalHour(20));
    }
  });

  it("PEAK_HOURS constants cover an evening window", () => {
    expect(PEAK_HOURS.start).toBeLessThan(PEAK_HOURS.end);
    expect(PEAK_HOURS.end).toBeLessThanOrEqual(23);
    expect(PEAK_HOURS.start).toBeGreaterThanOrEqual(15);
  });

  it("returns positive non-zero weights for every hour", () => {
    for (let h = 0; h < 24; h++) {
      expect(hourWeightForLocalHour(h)).toBeGreaterThan(0);
    }
  });
});

describe("sampleNextShiftStart", () => {
  it("returns a timestamp in the future", () => {
    const now = new Date(2026, 0, 1, 12, 0, 0).getTime();
    for (let i = 0; i < 50; i++) {
      const t = sampleNextShiftStart({ now, timezone: "America/Los_Angeles" });
      expect(t).toBeGreaterThan(now);
    }
  });

  it("returns a timestamp within the next 24 hours (after weighted lottery)", () => {
    const now = new Date(2026, 0, 1, 12, 0, 0).getTime();
    for (let i = 0; i < 50; i++) {
      const t = sampleNextShiftStart({ now, timezone: "America/Los_Angeles" });
      const hoursOut = (t - now) / 3_600_000;
      expect(hoursOut).toBeLessThanOrEqual(24);
    }
  });
});

describe("shouldTakeBreak", () => {
  it("returns true ~10% of the time", () => {
    let trueCount = 0;
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      if (shouldTakeBreak()) trueCount++;
    }
    const rate = trueCount / N;
    expect(rate).toBeGreaterThan(0.05);
    expect(rate).toBeLessThan(0.15);
  });
});

describe("sampleBreakDurationMs", () => {
  it("returns a duration of at least 1 hour", () => {
    for (let i = 0; i < 100; i++) {
      expect(sampleBreakDurationMs() / 3_600_000).toBeGreaterThanOrEqual(1);
    }
  });

  it("median is in the 6-14 hour band", () => {
    const samples = Array.from({ length: 5000 }, () => sampleBreakDurationMs() / 3_600_000);
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    expect(median).toBeGreaterThan(6);
    expect(median).toBeLessThan(14);
  });
});
