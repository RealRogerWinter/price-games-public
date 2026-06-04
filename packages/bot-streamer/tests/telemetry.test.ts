/**
 * Telemetry emitter tests. Contract:
 *  - Each `log()` call produces exactly one stringified JSON line.
 *  - The emitter adds a `ts` field automatically.
 *  - Circular records do not crash the runner.
 */

import { describe, it, expect } from "vitest";
import { createTelemetry, createMemoryTelemetry } from "../src/runner/telemetry";

describe("createTelemetry", () => {
  it("emits one JSON line per log call with auto-injected ts", () => {
    const lines: string[] = [];
    const t = createTelemetry((line) => lines.push(line), () => 1714867200000);
    t.log({ evt: "round.complete", success: true, mode: "classic" });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({
      ts: 1714867200000,
      evt: "round.complete",
      success: true,
      mode: "classic",
    });
  });

  it("does not throw on circular references", () => {
    const lines: string[] = [];
    const t = createTelemetry((line) => lines.push(line));
    const obj: { evt: string; self?: unknown } = { evt: "test" };
    obj.self = obj;
    expect(() => t.log(obj as never)).not.toThrow();
    // Circular case produces no output.
    expect(lines).toHaveLength(0);
  });
});

describe("createMemoryTelemetry", () => {
  it("captures records as parsed objects", () => {
    const t = createMemoryTelemetry(() => 1234);
    t.log({ evt: "panic", reason: "page_crashed" });
    t.log({ evt: "round.complete", mode: "higher-lower" });
    expect(t.records).toHaveLength(2);
    expect(t.records[0]).toMatchObject({ ts: 1234, evt: "panic", reason: "page_crashed" });
    expect(t.records[1]).toMatchObject({ ts: 1234, evt: "round.complete", mode: "higher-lower" });
  });
});
