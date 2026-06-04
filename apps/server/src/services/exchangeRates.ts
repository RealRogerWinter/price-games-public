const SUPPORTED_CURRENCIES = [
  "EUR", "GBP", "CAD", "AUD", "JPY", "INR",
  "BRL", "MXN", "KRW", "SEK", "CHF", "CNY",
] as const;

const HARDCODED_FALLBACK: Record<string, number> = {
  EUR: 0.92,
  GBP: 0.79,
  CAD: 1.36,
  AUD: 1.53,
  JPY: 149.5,
  INR: 83.1,
  BRL: 4.97,
  MXN: 17.15,
  KRW: 1325.0,
  SEK: 10.42,
  CHF: 0.88,
  CNY: 7.24,
};

interface ExchangeRateData {
  base: string;
  rates: Record<string, number>;
  updatedAt: string;
}

let cachedRates: ExchangeRateData | null = null;

const REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

export async function fetchRates(): Promise<void> {
  try {
    const response = await fetch("https://api.frankfurter.app/latest?from=USD");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json() as { rates?: Record<string, number> };

    const filtered: Record<string, number> = {};
    for (const currency of SUPPORTED_CURRENCIES) {
      if (data.rates && data.rates[currency] != null) {
        filtered[currency] = data.rates[currency];
      }
    }

    cachedRates = {
      base: "USD",
      rates: filtered,
      updatedAt: new Date().toISOString(),
    };

    console.log("[ExchangeRates] Rates fetched successfully");
  } catch (error) {
    console.error("[ExchangeRates] Failed to fetch rates:", error);

    if (!cachedRates) {
      cachedRates = {
        base: "USD",
        rates: { ...HARDCODED_FALLBACK },
        updatedAt: new Date().toISOString(),
      };
      console.log("[ExchangeRates] Using hardcoded fallback rates");
    } else {
      console.log("[ExchangeRates] Keeping previously cached rates");
    }
  }
}

export function getRates(): ExchangeRateData {
  if (cachedRates) {
    return cachedRates;
  }

  return {
    base: "USD",
    rates: { ...HARDCODED_FALLBACK },
    updatedAt: new Date().toISOString(),
  };
}

// Refresh rates every 24 hours
setInterval(() => {
  fetchRates();
}, REFRESH_INTERVAL).unref();
