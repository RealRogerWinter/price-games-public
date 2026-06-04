import { useState, useEffect, useRef } from "react";
import { useCurrency } from "../context/CurrencyContext";
import { soundEngine } from "../audio/SoundEngine";

interface PriceInputProps {
  category: string;
  priceRange?: { min: number; max: number };
  onSubmit: (priceCents: number) => void;
  disabled: boolean;
  onInteract?: () => void;
}

export default function PriceInput({
  category,
  priceRange,
  onSubmit,
  disabled,
  onInteract,
}: PriceInputProps) {
  const { formatPrice, parseInput, currency } = useCurrency();
  const range = priceRange ?? { min: 100, max: 200000 };
  const [cents, setCents] = useState(0);
  const [textValue, setTextValue] = useState("");
  const lastTickRef = useRef(0);

  // Randomize starting value when the range changes (new product)
  useEffect(() => {
    const spread = range.max - range.min;
    const randomStart = Math.round(range.min + Math.random() * spread);
    // Round to a nice step
    const step = range.max <= 5000 ? 50 : range.max <= 50000 ? 100 : 500;
    const rounded = Math.round(randomStart / step) * step;
    const clamped = Math.max(range.min, Math.min(range.max, rounded));
    setCents(clamped);
    setTextValue(formatPrice(clamped));
  }, [range.min, range.max]);

  // Re-format display when currency changes
  useEffect(() => {
    if (cents > 0) {
      setTextValue(formatPrice(cents));
    }
  }, [currency]);

  function handleSliderChange(e: React.ChangeEvent<HTMLInputElement>) {
    onInteract?.();
    const val = parseInt(e.target.value, 10);
    setCents(val);
    setTextValue(formatPrice(val));
    // Throttled tick sound — at most once every 60ms
    const now = performance.now();
    if (now - lastTickRef.current > 60) {
      lastTickRef.current = now;
      soundEngine.play("slider_tick");
    }
  }

  function handleTextChange(e: React.ChangeEvent<HTMLInputElement>) {
    onInteract?.();
    setTextValue(e.target.value);
    const parsed = parseInput(e.target.value);
    if (parsed >= 0) {
      setCents(Math.max(range.min, Math.min(range.max, parsed)));
    }
  }

  function handleTextBlur() {
    const parsed = parseInput(textValue);
    const clamped = Math.max(range.min, Math.min(range.max, parsed));
    setCents(clamped);
    setTextValue(formatPrice(clamped));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!disabled) {
      onSubmit(cents);
    }
  }

  const step = range.max <= 5000 ? 50 : range.max <= 50000 ? 100 : 500;

  return (
    <form className="price-input" onSubmit={handleSubmit} data-testid="price-input">
      <label className="price-label" htmlFor="price-text-input">Your Guess</label>
      <input
        id="price-text-input"
        type="text"
        className="price-text-input"
        value={textValue}
        onChange={handleTextChange}
        onBlur={handleTextBlur}
        disabled={disabled}
        inputMode="decimal"
        aria-label="Your guess price in dollars"
        data-testid="price-input-text"
      />
      <div className="slider-container">
        <span className="slider-label">{formatPrice(range.min)}</span>
        <input
          type="range"
          className="price-slider"
          min={range.min}
          max={range.max}
          step={step}
          value={cents}
          onChange={handleSliderChange}
          disabled={disabled}
          aria-label="Adjust your price guess with the slider"
          data-testid="price-input-slider"
        />
        <span className="slider-label">{formatPrice(range.max)}</span>
      </div>
      <button type="submit" className="btn btn-primary" disabled={disabled} data-testid="price-input-submit">
        Lock In Price
      </button>
    </form>
  );
}
