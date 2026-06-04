#!/usr/bin/env node
/**
 * Verifies the real-TTS sandbox cycle end-to-end. Opens
 * sandbox.price.games/?broadcast=1 in headless Playwright (so the
 * page mounts useStreamerTtsRelay), then POSTs to
 * /api/sandbox/tts/cycle-moods. Watches the Avatar's mood + mouth
 * state for the duration of the cycle. Reports per-mood snapshots
 * so we can verify (1) every mood ran, (2) the body sprite swapped,
 * (3) the mouth animated through closed/mid/wide states.
 */
import { chromium } from "playwright";

const TARGET_URL = process.argv[2] ?? "https://sandbox.price.games/?broadcast=1";

async function main() {
  console.log(`[verify] launching → ${TARGET_URL}`);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const ttsEnvelopes = [];
  await page.exposeFunction("__recordEnvelope", (kind, mood, hasChunks) => {
    ttsEnvelopes.push({ kind, mood, hasChunks, t: Date.now() });
  });

  // Tap into received envelopes by hooking window.postMessage AFTER
  // page load. The relay hook fires postMessage from inside React's
  // useEffect, so we hook the listener once.
  await page.addInitScript(() => {
    window.addEventListener("message", (ev) => {
      if (!ev.data || ev.data.source !== "pg-bot") return;
      const k = ev.data.kind;
      if (typeof k !== "string") return;
      if (!k.startsWith("tts.utterance.") && k !== "mood.snapshot" && k !== "stats.update") return;
      const mood = ev.data.payload?.mood;
      const hasChunks = Array.isArray(ev.data.payload?.chunks);
      // eslint-disable-next-line no-undef
      window.__recordEnvelope?.(k, mood ?? null, hasChunks);
    });
  });

  page.on("console", (msg) => {
    const t = msg.text();
    if (t.includes("[pcm-test]") || t.includes("[overlayBus]")) {
      console.log(`[page] ${t}`);
    }
  });

  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector('[data-testid="broadcast-shell"]', { timeout: 15_000 });
  console.log(`[verify] shell mounted`);

  // Trigger the cycle
  console.log(`[verify] POST /api/sandbox/tts/cycle-moods`);
  const apiUrl = new globalThis.URL("/api/sandbox/tts/cycle-moods", TARGET_URL).toString();
  const res = await page.request.post(apiUrl);
  console.log(`[verify] cycle: ${res.status()} ${await res.text()}`);

  // Sample mouth + mood every 1s for up to 75s (enough for 8 moods).
  const samples = [];
  const start = Date.now();
  while (Date.now() - start < 75_000) {
    const snap = await page.evaluate(() => {
      const op = (sel) => {
        const el = document.querySelector(sel);
        return el ? parseFloat(el.style.opacity || "0") : null;
      };
      const av = document.querySelector('[data-testid="broadcast-avatar"]');
      return {
        t: Date.now(),
        mood: av?.getAttribute("data-mood") ?? null,
        speaking: av?.getAttribute("data-speaking") ?? null,
        c: op('[data-testid="broadcast-avatar-frame-body"]'),
        m: op('[data-testid="broadcast-avatar-frame-mid"]'),
        w: op('[data-testid="broadcast-avatar-frame-wide"]'),
        pcm: window.__pgPcmStats?.dispatched ?? 0,
        viseme: window.__pgVisemeStats?.processed ?? 0,
        apsw: window.__pgVisemeStats?.apertureEvents ?? 0,
      };
    });
    samples.push(snap);

    // Stop early once we've seen a long stretch of not-speaking
    // (cycle finished + brief tail).
    const last = ttsEnvelopes[ttsEnvelopes.length - 1];
    if (last && last.kind === "tts.utterance.audio_ended" && Date.now() - last.t > 3000 && samples.length > 20) {
      console.log(`[verify] cycle quiesced after ${samples.length}s`);
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`\n=== Envelopes received via Socket.IO -> postMessage ===`);
  const byKind = {};
  for (const e of ttsEnvelopes) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  console.log(byKind);

  const moodsSeen = new Set(ttsEnvelopes.filter((e) => e.kind === "tts.utterance.start").map((e) => e.mood));
  console.log(`\nMoods that started an utterance: ${[...moodsSeen].join(", ")}`);

  console.log(`\n=== Mouth/mood timeline (1s samples) ===`);
  console.table(samples.map((s, i) => ({
    s: i,
    mood: s.mood,
    sp: s.speaking,
    c: s.c?.toFixed(1),
    m: s.m?.toFixed(1),
    w: s.w?.toFixed(1),
    pcm: s.pcm,
    visemes: s.viseme,
    aSw: s.apsw,
  })));

  await browser.close();
}

main().catch((e) => {
  console.error(`[verify] fatal: ${e.stack ?? e}`);
  process.exit(2);
});
