import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { NdjsonLogger } from "../../src/learning/ndjsonLogger";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "ndjson-"));
}

function todayName(): string {
  return `round-${new Date().toISOString().slice(0, 10)}.ndjson`;
}

describe("NdjsonLogger", () => {
  it("appends lines to today's file", async () => {
    const dir = await tmpDir();
    const lg = new NdjsonLogger({ dir, pruneOlderThanDays: 14, flushEvery: 1 });
    await lg.start();
    await lg.write({ a: 1 });
    await lg.write({ b: "hello" });
    await lg.stop();
    const fp = path.join(dir, todayName());
    const content = await fs.readFile(fp, "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0])).toEqual({ a: 1 });
    expect(JSON.parse(lines[1])).toEqual({ b: "hello" });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("setBlocked stops writes", async () => {
    const dir = await tmpDir();
    const lg = new NdjsonLogger({ dir, pruneOlderThanDays: 14, flushEvery: 1 });
    await lg.start();
    lg.setBlocked(true);
    await lg.write({ a: 1 });
    await lg.write({ b: 2 });
    await lg.stop();
    let content = "";
    try {
      content = await fs.readFile(path.join(dir, todayName()), "utf8");
    } catch {
      content = "";
    }
    expect(content).toBe("");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("prune removes files older than threshold", async () => {
    const dir = await tmpDir();
    const lg = new NdjsonLogger({ dir, pruneOlderThanDays: 1, flushEvery: 1 });
    await lg.start();
    await lg.write({ a: 1 });
    await lg.stop();
    // Drop a stale file with mtime 5 days ago.
    const oldFile = path.join(dir, "round-2000-01-01.ndjson");
    await fs.writeFile(oldFile, "stale\n");
    await fs.utimes(oldFile, Date.now() / 1000 - 86400 * 5, Date.now() / 1000 - 86400 * 5);
    await lg.prune();
    const remaining = await fs.readdir(dir);
    expect(remaining).not.toContain("round-2000-01-01.ndjson");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rotateIfNeeded swaps streams across day boundary", async () => {
    const dir = await tmpDir();
    const lg = new NdjsonLogger({ dir, pruneOlderThanDays: 14, flushEvery: 1 });
    await lg.start();
    await lg.write({ a: 1 });
    // Force-rotate by lying about currentDay.
    (lg as unknown as { currentDay: string }).currentDay = "2099-12-31";
    lg.rotateIfNeeded();
    await lg.write({ b: 2 });
    await lg.stop();
    const fp = path.join(dir, todayName());
    const content = await fs.readFile(fp, "utf8");
    expect(content).toContain('"b":2');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("diskUsedRatio returns a value in [0,1]", async () => {
    const ratio = await NdjsonLogger.diskUsedRatio("/");
    expect(ratio).toBeGreaterThanOrEqual(0);
    expect(ratio).toBeLessThanOrEqual(1);
  });
});
