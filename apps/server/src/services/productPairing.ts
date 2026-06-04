/**
 * Product pairing — pure functions for fingerprinting, variant detection, and
 * difficulty-aware product selection. No database dependency.
 */

export interface CandidateProduct {
  id: number;
  price_cents: number;
  title: string;
  category: string;
  manufacturer: string | null;
}

export type DifficultyTier = "easy" | "medium" | "hard";

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "in", "on", "of", "to",
  "is", "it", "by", "at", "from", "as", "be", "was", "are", "its",
  "set", "pack", "size", "inch", "count", "piece", "oz", "lb", "ml",
]);

/**
 * Extract a fingerprint from a product title for similarity detection.
 *
 * @param title - Product title string.
 * @returns Array of up to 4 significant tokens.
 */
export function getProductFingerprint(title: string): string[] {
  const cleaned = title.toLowerCase().replace(/[^a-z0-9\s]/g, "");
  const tokens = cleaned.split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return tokens.slice(0, 4);
}

/**
 * Detect whether two products are likely variants of the same item.
 *
 * @param titleA - First product title.
 * @param titleB - Second product title.
 * @returns True if fingerprint overlap >= 2 tokens.
 */
export function areVariants(titleA: string, titleB: string): boolean {
  const fpA = getProductFingerprint(titleA);
  const fpB = new Set(getProductFingerprint(titleB));
  let overlap = 0;
  for (const token of fpA) {
    if (fpB.has(token)) overlap++;
  }
  return overlap >= 2;
}

/** Fisher-Yates shuffle (in-place). */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Check whether products are in ascending price order.
 *
 * @param products - Array of products to check.
 * @returns True if every product's price is >= the previous product's price.
 */
export function isSortedByPrice(products: CandidateProduct[]): boolean {
  for (let i = 1; i < products.length; i++) {
    if (products[i].price_cents < products[i - 1].price_cents) return false;
  }
  return true;
}

/**
 * Shuffle products ensuring the result is never in ascending price order.
 * Uses Fisher-Yates, then swaps the first two elements if the shuffle
 * happened to produce the sorted order. Note: if all products share the
 * same price, the array is always "sorted" and the swap is a no-op —
 * callers that filter duplicate prices (like selectSortItOutGroup) are
 * unaffected.
 *
 * @param products - Array of products to shuffle (mutated in place).
 * @returns The same array, shuffled and guaranteed not in sorted order
 *          when at least two distinct prices exist.
 */
export function shuffleNonSorted(products: CandidateProduct[]): CandidateProduct[] {
  shuffle(products);
  if (products.length >= 2 && isSortedByPrice(products)) {
    [products[0], products[1]] = [products[1], products[0]];
  }
  return products;
}

/**
 * Compute the percentage spread between two prices.
 *
 * @returns Absolute ratio difference from 1, e.g. prices 100 and 140 → 0.40.
 */
function priceSpread(a: number, b: number): number {
  if (a === 0 || b === 0) return a === b ? 0 : Infinity;
  const max = Math.max(a, b);
  const min = Math.min(a, b);
  return (max - min) / min;
}

interface SpreadRange {
  min: number;
  max: number;
}

const COMPARISON_SPREADS: Record<DifficultyTier, SpreadRange> = {
  easy: { min: 0.30, max: 0.60 },
  medium: { min: 0.15, max: 0.30 },
  hard: { min: 0.05, max: 0.15 },
};

/**
 * Select a pair of products for Comparison mode, difficulty-aware.
 *
 * @param difficulty - Target difficulty tier.
 * @param candidates - Available products to choose from.
 * @param usedIds - Products already used this session.
 * @returns A pair of products or null if no valid pair found.
 */
export function selectComparisonPair(
  difficulty: DifficultyTier,
  candidates: CandidateProduct[],
  usedIds: Set<number>
): [CandidateProduct, CandidateProduct] | null {
  const available = candidates.filter((c) => !usedIds.has(c.id));
  if (available.length < 2) return null;

  // Try progressively relaxed constraints
  const relaxations = [
    { spreadWiden: 0, requireCategory: difficulty !== "easy", checkVariants: true },
    { spreadWiden: 0.10, requireCategory: difficulty === "hard", checkVariants: true },
    { spreadWiden: 0.20, requireCategory: false, checkVariants: true },
    { spreadWiden: 0.30, requireCategory: false, checkVariants: false },
  ];

  for (const relax of relaxations) {
    const target = COMPARISON_SPREADS[difficulty];
    const minSpread = Math.max(0, target.min - relax.spreadWiden);
    const maxSpread = target.max + relax.spreadWiden;

    const pairs: [CandidateProduct, CandidateProduct][] = [];
    const shuffled = shuffle([...available]);

    for (let i = 0; i < shuffled.length; i++) {
      for (let j = i + 1; j < shuffled.length; j++) {
        const a = shuffled[i];
        const b = shuffled[j];

        // Price spread check
        const spread = priceSpread(a.price_cents, b.price_cents);
        if (spread < minSpread || spread > maxSpread) continue;

        // Category check
        if (relax.requireCategory && a.category !== b.category) continue;

        // Variant check
        if (relax.checkVariants && areVariants(a.title, b.title)) continue;

        // Manufacturer preference (soft — still add but deprioritize)
        const diffMfr = a.manufacturer !== b.manufacturer;
        if (diffMfr) {
          pairs.unshift([a, b]);
        } else {
          pairs.push([a, b]);
        }

        // Cap search for performance
        if (pairs.length >= 10) break;
      }
      if (pairs.length >= 10) break;
    }

    if (pairs.length > 0) return pairs[0];
  }

  // Ultimate fallback: any two available products with different prices
  const shuffled = shuffle([...available]);
  for (let i = 0; i < shuffled.length; i++) {
    for (let j = i + 1; j < shuffled.length; j++) {
      if (shuffled[i].price_cents !== shuffled[j].price_cents) {
        return [shuffled[i], shuffled[j]];
      }
    }
  }

  return available.length >= 2 ? [available[0], available[1]] : null;
}

/**
 * Select a group of 4 products for Price Match mode, difficulty-aware.
 *
 * @param difficulty - Target difficulty tier.
 * @param candidates - Available products.
 * @param usedIds - Products already used this session.
 * @returns Array of 4 products or null if not enough available.
 */
export function selectPriceMatchGroup(
  difficulty: DifficultyTier,
  candidates: CandidateProduct[],
  usedIds: Set<number>
): CandidateProduct[] | null {
  const available = candidates.filter((c) => !usedIds.has(c.id));
  if (available.length < 4) return null;

  const relaxations = [
    { relaxCategory: false, relaxSpread: false, checkVariants: true },
    { relaxCategory: true, relaxSpread: false, checkVariants: true },
    { relaxCategory: true, relaxSpread: true, checkVariants: false },
  ];

  for (const relax of relaxations) {
    const result = tryPriceMatchSelection(difficulty, available, relax);
    if (result) return result;
  }

  // Ultimate fallback: any 4 with distinct prices
  const shuffled = shuffle([...available]);
  const group: CandidateProduct[] = [];
  const usedPrices = new Set<number>();
  for (const p of shuffled) {
    if (!usedPrices.has(p.price_cents)) {
      group.push(p);
      usedPrices.add(p.price_cents);
      if (group.length === 4) return group;
    }
  }

  return available.length >= 4 ? available.slice(0, 4) : null;
}

function tryPriceMatchSelection(
  difficulty: DifficultyTier,
  available: CandidateProduct[],
  relax: { relaxCategory: boolean; relaxSpread: boolean; checkVariants: boolean }
): CandidateProduct[] | null {
  const shuffled = shuffle([...available]);

  if (difficulty === "easy" && !relax.relaxCategory) {
    // 4 products from 4 different categories
    const byCategory = new Map<string, CandidateProduct[]>();
    for (const p of shuffled) {
      const list = byCategory.get(p.category) || [];
      list.push(p);
      byCategory.set(p.category, list);
    }
    const categories = [...byCategory.keys()];
    if (categories.length < 4) return null;
    const group: CandidateProduct[] = [];
    for (const cat of shuffle(categories).slice(0, 4)) {
      group.push(byCategory.get(cat)![0]);
    }
    if (hasDuplicatePrices(group)) return null;
    if (relax.checkVariants && hasVariantsInGroup(group)) return null;
    return group;
  }

  if (difficulty === "medium" && !relax.relaxCategory) {
    // 4 products from 2 categories (2 each)
    const byCategory = new Map<string, CandidateProduct[]>();
    for (const p of shuffled) {
      const list = byCategory.get(p.category) || [];
      list.push(p);
      byCategory.set(p.category, list);
    }
    const validCats = [...byCategory.entries()].filter(([, prods]) => prods.length >= 2);
    if (validCats.length < 2) return null;
    const chosen = shuffle(validCats).slice(0, 2);
    const group = [chosen[0][1][0], chosen[0][1][1], chosen[1][1][0], chosen[1][1][1]];
    if (hasDuplicatePrices(group)) return null;
    if (relax.checkVariants && hasVariantsInGroup(group)) return null;
    return group;
  }

  if (difficulty === "hard" && !relax.relaxCategory) {
    // 4 products from same category, >= 25% spread between adjacent sorted prices
    const byCategory = new Map<string, CandidateProduct[]>();
    for (const p of shuffled) {
      const list = byCategory.get(p.category) || [];
      list.push(p);
      byCategory.set(p.category, list);
    }
    for (const [, prods] of shuffle([...byCategory.entries()])) {
      if (prods.length < 4) continue;
      const sorted = [...prods].sort((a, b) => a.price_cents - b.price_cents);
      // Try combinations
      for (let attempt = 0; attempt < 10; attempt++) {
        const sample = shuffle([...sorted]).slice(0, 4).sort((a, b) => a.price_cents - b.price_cents);
        const minSpread = relax.relaxSpread ? 0.10 : 0.25;
        let valid = true;
        for (let i = 1; i < sample.length; i++) {
          if (priceSpread(sample[i - 1].price_cents, sample[i].price_cents) < minSpread) {
            valid = false;
            break;
          }
        }
        if (!valid) continue;
        if (hasDuplicatePrices(sample)) continue;
        if (relax.checkVariants && hasVariantsInGroup(sample)) continue;
        return sample;
      }
    }
    return null;
  }

  // Relaxed: any 4 products, prefer different manufacturers
  const group: CandidateProduct[] = [];
  const usedMfrs = new Set<string>();
  const usedPrices = new Set<number>();

  // First pass: different manufacturers and prices
  for (const p of shuffled) {
    if (group.length >= 4) break;
    const mfr = p.manufacturer || "";
    if (usedPrices.has(p.price_cents)) continue;
    if (relax.checkVariants && group.some((g) => areVariants(g.title, p.title))) continue;
    if (!usedMfrs.has(mfr) || mfr === "") {
      group.push(p);
      usedMfrs.add(mfr);
      usedPrices.add(p.price_cents);
    }
  }

  // Fill remaining
  if (group.length < 4) {
    for (const p of shuffled) {
      if (group.length >= 4) break;
      if (group.some((g) => g.id === p.id)) continue;
      if (usedPrices.has(p.price_cents)) continue;
      group.push(p);
      usedPrices.add(p.price_cents);
    }
  }

  return group.length >= 4 ? group.slice(0, 4) : null;
}

function hasDuplicatePrices(products: CandidateProduct[]): boolean {
  const prices = new Set(products.map((p) => p.price_cents));
  return prices.size < products.length;
}

function hasVariantsInGroup(products: CandidateProduct[]): boolean {
  for (let i = 0; i < products.length; i++) {
    for (let j = i + 1; j < products.length; j++) {
      if (areVariants(products[i].title, products[j].title)) return true;
    }
  }
  return false;
}

/**
 * Select a single product for Classic, Closest, Higher-Lower, or Riser modes.
 *
 * @param difficulty - Target difficulty tier.
 * @param mode - Game mode (affects price tier selection for classic/closest).
 * @param candidates - Available products.
 * @param usedIds - Products already used this session.
 * @returns A single product or null.
 */
export function selectSingleProduct(
  difficulty: DifficultyTier,
  mode: string,
  candidates: CandidateProduct[],
  usedIds: Set<number>
): CandidateProduct | null {
  const available = candidates.filter((c) => !usedIds.has(c.id));
  if (available.length === 0) return null;

  // Classic and Closest modes: difficulty affects price tier
  if (mode === "classic" || mode === "closest-without-going-over") {
    let filtered: CandidateProduct[];
    if (difficulty === "easy") {
      filtered = available.filter((p) => p.price_cents >= 1500 && p.price_cents <= 15000);
    } else if (difficulty === "hard") {
      filtered = available.filter((p) => p.price_cents < 500 || p.price_cents > 50000);
    } else {
      filtered = available;
    }
    // Fallback to all available if tier filter is too restrictive
    if (filtered.length === 0) filtered = available;
    return shuffle([...filtered])[0];
  }

  // Higher-Lower and Riser: any price (difficulty applied via round metadata)
  return shuffle([...available])[0];
}

/**
 * Select a group of products for Odd One Out mode.
 * Three products share a similar price range; one is the outlier.
 *
 * @param difficulty - Target difficulty tier.
 * @param candidates - Available products.
 * @param usedIds - Products already used this session.
 * @returns Array of 4 products or null if not enough available.
 */
export function selectOddOneOutGroup(
  difficulty: DifficultyTier,
  candidates: CandidateProduct[],
  usedIds: Set<number>
): CandidateProduct[] | null {
  const available = candidates.filter((c) => !usedIds.has(c.id));
  if (available.length < 4) return null;

  const shuffled = shuffle([...available]);

  // Try to find 3 products within a tight spread and 1 outlier
  const spreadThreshold = difficulty === "easy" ? 0.15 : difficulty === "medium" ? 0.25 : 0.35;

  for (let anchor = 0; anchor < Math.min(shuffled.length, 20); anchor++) {
    const base = shuffled[anchor];
    const cluster: CandidateProduct[] = [base];
    let outlier: CandidateProduct | null = null;

    for (const p of shuffled) {
      if (p.id === base.id) continue;
      const spread = priceSpread(base.price_cents, p.price_cents);
      if (spread <= spreadThreshold && cluster.length < 3) {
        if (!areVariants(base.title, p.title)) {
          cluster.push(p);
        }
      } else if (spread > spreadThreshold * 2 && !outlier) {
        outlier = p;
      }
    }

    if (cluster.length === 3 && outlier) {
      return shuffle([...cluster, outlier]);
    }
  }

  // Fallback: any 4 products
  return shuffled.length >= 4 ? shuffled.slice(0, 4) : null;
}

/**
 * Select a group of products for Market Basket mode.
 * Product count varies by difficulty (3 easy, 4-5 medium, 6 hard).
 *
 * @param difficulty - Target difficulty tier.
 * @param candidates - Available products.
 * @param usedIds - Products already used this session.
 * @returns Array of products or null if not enough available.
 */
export function selectMarketBasketGroup(
  difficulty: DifficultyTier,
  candidates: CandidateProduct[],
  usedIds: Set<number>
): CandidateProduct[] | null {
  const count = difficulty === "easy" ? 3 : difficulty === "medium" ? 5 : 6;
  const available = candidates.filter((c) => !usedIds.has(c.id));
  if (available.length < count) return null;

  const shuffled = shuffle([...available]);

  // Prefer diverse categories
  const byCategory = new Map<string, CandidateProduct[]>();
  for (const p of shuffled) {
    const list = byCategory.get(p.category) || [];
    list.push(p);
    byCategory.set(p.category, list);
  }

  const group: CandidateProduct[] = [];
  const usedCats = new Set<string>();

  // One from each category first
  for (const [cat, prods] of byCategory) {
    if (group.length >= count) break;
    if (!usedCats.has(cat)) {
      group.push(prods[0]);
      usedCats.add(cat);
    }
  }

  // Fill remaining
  for (const p of shuffled) {
    if (group.length >= count) break;
    if (!group.some((g) => g.id === p.id)) {
      group.push(p);
    }
  }

  return group.length >= count ? group.slice(0, count) : null;
}

/**
 * Select a group of products for Sort It Out mode.
 * Players must rank products by price.
 *
 * @param difficulty - Target difficulty tier.
 * @param candidates - Available products.
 * @param usedIds - Products already used this session.
 * @returns Array of 5 products or null if not enough available.
 */
export function selectSortItOutGroup(
  difficulty: DifficultyTier,
  candidates: CandidateProduct[],
  usedIds: Set<number>
): CandidateProduct[] | null {
  const available = candidates.filter((c) => !usedIds.has(c.id));
  if (available.length < 5) return null;

  const shuffled = shuffle([...available]);

  // Target minimum spread between adjacent sorted prices
  const minAdjacentSpread = difficulty === "easy" ? 0.30 : difficulty === "medium" ? 0.15 : 0.05;

  for (let attempt = 0; attempt < 15; attempt++) {
    const sample = shuffle([...shuffled]).slice(0, 5).sort((a, b) => a.price_cents - b.price_cents);

    if (hasDuplicatePrices(sample)) continue;

    let valid = true;
    for (let i = 1; i < sample.length; i++) {
      if (priceSpread(sample[i - 1].price_cents, sample[i].price_cents) < minAdjacentSpread) {
        valid = false;
        break;
      }
    }
    if (valid && !hasVariantsInGroup(sample)) return shuffleNonSorted(sample);
  }

  // Fallback: any 5 with distinct prices
  const group: CandidateProduct[] = [];
  const usedPrices = new Set<number>();
  for (const p of shuffled) {
    if (!usedPrices.has(p.price_cents)) {
      group.push(p);
      usedPrices.add(p.price_cents);
      if (group.length === 5) return shuffleNonSorted(group);
    }
  }

  return shuffled.length >= 5 ? shuffleNonSorted(shuffled.slice(0, 5)) : null;
}

/**
 * Select a group of products for Budget Builder mode.
 * Players choose items that fit within a budget.
 *
 * @param difficulty - Target difficulty tier.
 * @param candidates - Available products.
 * @param usedIds - Products already used this session.
 * @returns Array of 6 products or null if not enough available.
 */
export function selectBudgetBuilderGroup(
  difficulty: DifficultyTier,
  candidates: CandidateProduct[],
  usedIds: Set<number>
): CandidateProduct[] | null {
  const available = candidates.filter((c) => !usedIds.has(c.id));
  if (available.length < 6) return null;

  const shuffled = shuffle([...available]);

  // Prefer diverse price points for interesting budget decisions
  const group: CandidateProduct[] = [];
  const usedPrices = new Set<number>();

  for (const p of shuffled) {
    if (group.length >= 6) break;
    if (!usedPrices.has(p.price_cents) && !group.some((g) => areVariants(g.title, p.title))) {
      group.push(p);
      usedPrices.add(p.price_cents);
    }
  }

  // Fill remaining if needed
  for (const p of shuffled) {
    if (group.length >= 6) break;
    if (!group.some((g) => g.id === p.id)) {
      group.push(p);
    }
  }

  return group.length >= 6 ? group.slice(0, 6) : null;
}

/**
 * Select a chain of products for Chain Reaction mode.
 * Products should form a plausible ascending price chain.
 *
 * @param difficulty - Target difficulty tier.
 * @param candidates - Available products.
 * @param usedIds - Products already used this session.
 * @returns Array of 5 products or null if not enough available.
 */
export function selectChainGroup(
  difficulty: DifficultyTier,
  candidates: CandidateProduct[],
  usedIds: Set<number>
): CandidateProduct[] | null {
  const available = candidates.filter((c) => !usedIds.has(c.id));
  if (available.length < 5) return null;

  const shuffled = shuffle([...available]);

  // Target spread between adjacent items in the chain
  const minSpread = difficulty === "easy" ? 0.25 : difficulty === "medium" ? 0.12 : 0.05;
  const maxSpread = difficulty === "easy" ? 1.00 : difficulty === "medium" ? 0.60 : 0.30;

  for (let attempt = 0; attempt < 15; attempt++) {
    const sample = shuffle([...shuffled]).slice(0, 5).sort((a, b) => a.price_cents - b.price_cents);

    if (hasDuplicatePrices(sample)) continue;

    let valid = true;
    for (let i = 1; i < sample.length; i++) {
      const spread = priceSpread(sample[i - 1].price_cents, sample[i].price_cents);
      if (spread < minSpread || spread > maxSpread) {
        valid = false;
        break;
      }
    }
    // Shuffle after validation so the chain has a random mix of ups and downs
    if (valid && !hasVariantsInGroup(sample)) return shuffle(sample);
  }

  // Fallback: any 5 with distinct prices, shuffled for random chain order
  const group: CandidateProduct[] = [];
  const usedPrices = new Set<number>();
  for (const p of shuffled) {
    if (!usedPrices.has(p.price_cents)) {
      group.push(p);
      usedPrices.add(p.price_cents);
      if (group.length === 5) return shuffle(group);
    }
  }

  return shuffled.length >= 5 ? shuffle(shuffled.slice(0, 5)) : null;
}
