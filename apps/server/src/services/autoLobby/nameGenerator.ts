/**
 * Human-style nickname generator for disguised bots.
 *
 * Produces handles that pass for an internet-anonymous user (e.g.
 * `mike_42`, `sarahxo`, `pricepro`, `kbird`, `jdog23`) — deliberately
 * different from the legacy `Adjective Animal` pattern used for labeled
 * bots, so a player can't pattern-match the disguised population.
 *
 * Style choices, calibrated against the engagement-expert review:
 *   - Lowercase by default (occasional CamelCase) — most real anonymous
 *     users don't capitalize.
 *   - Numeric suffixes are common but not universal.
 *   - Avoid `xX...Xx` cringe and obvious bot tells (`prizeWinner99`).
 *   - No spaces (handles, not display names).
 */

const FIRST_NAMES = [
  "alex", "ben", "cam", "dan", "ed", "finn", "gus", "hank", "ian", "jay",
  "kai", "leo", "max", "nick", "owen", "pete", "quin", "ray", "sam", "tom",
  "ty", "vic", "will", "zach", "abe", "carl", "drew", "eli", "fred", "greg",
  "hugo", "isaac", "jake", "kyle", "luke", "matt", "noah", "oscar", "paul", "rob",
  "seth", "theo", "ty", "vince", "wes", "xander", "yale", "zane", "andy", "blake",
  "amy", "beth", "cara", "dani", "emma", "faye", "gem", "hana", "iris", "jess",
  "kate", "lia", "mia", "nora", "olive", "pia", "ruby", "sara", "tess", "uma",
  "viv", "wren", "yara", "zoe", "ava", "brie", "cleo", "dot", "ellie", "fiona",
  "gigi", "hope", "ivy", "june", "kiki", "luna", "maya", "nia", "opal", "piper",
  "rae", "sky", "thea", "una", "vera", "willow", "yuki", "zara", "ada", "blair",
] as const;

const NOUNS = [
  "bird", "fox", "wolf", "shark", "tiger", "bear", "dragon", "lion",
  "eagle", "hawk", "raven", "deer", "moose", "panda", "puma", "cat",
  "dog", "owl", "rat", "crow", "ant", "bee", "snake", "fish",
  "deal", "buy", "shop", "cart", "tag", "bid", "guess", "pick",
  "price", "deal", "match", "play", "game", "win", "score", "round",
  "quik", "fast", "slow", "easy", "hard", "loud", "calm", "cool",
  "byte", "code", "loop", "node", "app", "web", "net", "log",
] as const;

const SUFFIXES = [
  "", "", "", "", // unweighted: bare name is fine
  "x", "xo", "z", "yz", "_", "._", "y",
  "pro", "rly", "ish", "tx", "mn", "ks", "fl", "il",
  "gg", "wp", "rly", "irl", "pls", "tbh",
] as const;

const PATTERNS = [
  "name+num",       // mike42
  "name_num",       // mike_42
  "name+suffix",    // mikex, mikepro
  "name+suffix+num",// mikex42
  "name.name",      // mike.tom
  "noun+num",       // shark42
  "name+noun",      // mikebird
  "n+name",         // m_alex (initial + name) — see assemble()
] as const;

/**
 * Notional size of the unique base pool. Used by callers to validate that
 * collision-avoidance has enough headroom; tests assert a floor of 400.
 *
 * Calculation: |FIRST_NAMES| * (|SUFFIXES| + |NOUNS|/4 + 100/4) covers the
 * minimum distinct bases produced by the dominant patterns. Conservative —
 * the actual generation space is far larger because of `name.name` and
 * numeric variation.
 */
export const HUMAN_NAME_POOL_SIZE =
  FIRST_NAMES.length * (SUFFIXES.length + Math.floor(NOUNS.length / 4) + 25);

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomNumberSuffix(): string {
  // Bias away from "00" / single-digit (less natural) — most real handles
  // either have no number or a 2-digit number.
  const r = Math.random();
  if (r < 0.55) return String(Math.floor(Math.random() * 100));
  if (r < 0.85) return String(Math.floor(Math.random() * 10) + 1);
  return String(Math.floor(Math.random() * 1000));
}

function assemble(): string {
  const pattern = pick(PATTERNS);
  const a = pick(FIRST_NAMES);
  const b = pick(FIRST_NAMES);
  const noun = pick(NOUNS);
  const suffix = pick(SUFFIXES);
  const num = randomNumberSuffix();

  switch (pattern) {
    case "name+num":
      return `${a}${num}`;
    case "name_num":
      return `${a}_${num}`;
    case "name+suffix":
      return `${a}${suffix || "x"}`;
    case "name+suffix+num":
      return `${a}${suffix}${num}`;
    case "name.name":
      return a === b ? `${a}.${pick(FIRST_NAMES)}` : `${a}.${b}`;
    case "noun+num":
      return `${noun}${num}`;
    case "name+noun":
      return `${a}${noun}`;
    case "n+name":
      return `${a[0]}_${b}`;
  }
  return a + num;
}

/**
 * Generate a unique human-style nickname not already in `existing`.
 *
 * Tries up to ~250 candidates from the assembly grammar; if every attempt
 * collides with `existing`, falls back to a numbered base (`anon{n}`) so
 * the function is total and never throws.
 *
 * @param existing - Names to avoid colliding with.
 * @returns A nickname guaranteed to be absent from `existing`.
 */
export function generateHumanStyleName(existing: Set<string>): string {
  for (let i = 0; i < 250; i++) {
    const candidate = assemble();
    if (!existing.has(candidate)) return candidate;
  }
  // Numbered fallback — keeps the generator total even if the caller is
  // actively dedup'ing against an enormous historical pool.
  let counter = 1;
  while (existing.has(`anon${counter}`)) counter++;
  return `anon${counter}`;
}

/**
 * Generate `count` unique human-style nicknames, all distinct from
 * `existing` and from each other.
 *
 * @param count - How many names to return.
 * @param existing - Names already in use (will not be returned).
 */
export function generateHumanStyleNames(count: number, existing: Set<string>): string[] {
  const out: string[] = [];
  const combined = new Set(existing);
  for (let i = 0; i < count; i++) {
    const n = generateHumanStyleName(combined);
    out.push(n);
    combined.add(n);
  }
  return out;
}
