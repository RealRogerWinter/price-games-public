import React, { createContext, useContext, useState, useEffect, useCallback } from "react";

interface CurrencyContextType {
  currency: string;
  setCurrency: (currency: string) => void;
  formatPrice: (cents: number) => string;
  parseInput: (value: string) => number;
  rates: Record<string, number>;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "\u20ac",
  GBP: "\u00a3",
  CAD: "CA$",
  AUD: "A$",
  JPY: "\u00a5",
  INR: "\u20b9",
  BRL: "R$",
  MXN: "MX$",
  KRW: "\u20a9",
  SEK: "kr ",
  CHF: "CHF ",
  CNY: "\u00a5",
};

const NO_DECIMAL_CURRENCIES = new Set(["JPY", "KRW"]);

const CurrencyContext = createContext<CurrencyContextType | undefined>(undefined);

export function CurrencyProvider({ children }: { children: React.ReactNode }) {
  const [currency, setCurrencyState] = useState<string>(() => {
    try {
      return localStorage.getItem("selected_currency") || "USD";
    } catch {
      return "USD";
    }
  });

  const [rates, setRates] = useState<Record<string, number>>(() => {
    try {
      const cached = localStorage.getItem("exchange_rates_cache");
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {
      // ignore parse errors
    }
    return {};
  });

  useEffect(() => {
    fetch("/api/exchange-rates")
      .then((res) => res.json())
      .then((data: { rates: Record<string, number> }) => {
        setRates(data.rates);
        try {
          localStorage.setItem("exchange_rates_cache", JSON.stringify(data.rates));
        } catch {
          // ignore storage errors
        }
      })
      .catch(() => {
        // keep using cached rates if fetch fails
      });
  }, []);

  const setCurrency = useCallback((code: string) => {
    setCurrencyState(code);
    try {
      localStorage.setItem("selected_currency", code);
    } catch {
      // ignore storage errors
    }
  }, []);

  const formatPrice = useCallback(
    (cents: number): string => {
      const symbol = CURRENCY_SYMBOLS[currency] || currency + " ";

      if (currency === "USD") {
        const dollars = cents / 100;
        return `$${dollars.toFixed(2)}`;
      }

      const rate = rates[currency];
      if (rate === undefined) {
        // Fallback to USD formatting if rate not available
        const dollars = cents / 100;
        return `$${dollars.toFixed(2)}`;
      }

      const dollars = cents / 100;
      const converted = dollars * rate;

      if (NO_DECIMAL_CURRENCIES.has(currency)) {
        return `${symbol}${Math.round(converted)}`;
      }

      return `${symbol}${converted.toFixed(2)}`;
    },
    [currency, rates]
  );

  const parseInput = useCallback(
    (value: string): number => {
      const cleaned = value.replace(/[^0-9.]/g, "");
      const parsed = parseFloat(cleaned);
      if (isNaN(parsed)) return 0;

      if (currency === "USD") {
        return Math.round(parsed * 100);
      }

      const rate = rates[currency];
      if (rate === undefined || rate === 0) {
        return Math.round(parsed * 100);
      }

      // Convert from displayed currency back to USD cents
      return Math.round((parsed / rate) * 100);
    },
    [currency, rates]
  );

  return (
    <CurrencyContext.Provider value={{ currency, setCurrency, formatPrice, parseInput, rates }}>
      {children}
    </CurrencyContext.Provider>
  );
}

export function useCurrency(): CurrencyContextType {
  const context = useContext(CurrencyContext);
  if (context === undefined) {
    throw new Error("useCurrency must be used within a CurrencyProvider");
  }
  return context;
}
