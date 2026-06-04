import { useCurrency } from "../context/CurrencyContext";

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
  SEK: "kr",
  CHF: "CHF",
  CNY: "\u00a5",
};

export default function CurrencySelector() {
  const { currency, setCurrency, rates } = useCurrency();

  const availableCurrencies = ["USD", ...Object.keys(rates).filter((code) => code !== "USD")];

  return (
    <select
      className="currency-selector"
      value={currency}
      onChange={(e) => setCurrency(e.target.value)}
    >
      {availableCurrencies.map((code) => {
        const symbol = CURRENCY_SYMBOLS[code] || code;
        return (
          <option key={code} value={code}>
            {code} ({symbol})
          </option>
        );
      })}
    </select>
  );
}
