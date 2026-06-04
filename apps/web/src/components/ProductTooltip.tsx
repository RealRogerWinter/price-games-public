import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useId,
  cloneElement,
  isValidElement,
} from "react";
import type {
  ReactElement,
  MouseEvent as ReactMouseEvent,
  FocusEvent as ReactFocusEvent,
} from "react";
import { createPortal } from "react-dom";
import type { Product, ProductWithPrice } from "@price-game/shared";
import { useCurrency } from "../context/CurrencyContext";
import { AmazonCTA } from "./AmazonCTA";

/**
 * Props for {@link ProductTooltip}.
 */
export interface ProductTooltipProps {
  /** The product to preview. `ProductWithPrice` enables the price row. */
  product: Product | ProductWithPrice;
  /**
   * The trigger element. Must be a single React element (typically a `<span>`
   * or `<a>`). Event handlers and `aria-describedby` are merged onto it via
   * `cloneElement` — no wrapper element is added to the DOM.
   */
  children: ReactElement;
  /** Disable the tooltip entirely (hover and tap become no-ops). */
  disabled?: boolean;
  /**
   * Preferred placement. `"auto"` (default) picks the side with more space,
   * preferring below when both sides fit.
   */
  placement?: "auto" | "top" | "bottom";
  /**
   * Whether to render the "View on Amazon" CTA button inside the card.
   * Defaults to `true`. Set `false` for mid-round previews where clicking
   * the affiliate link would reveal the exact price and spoil the guess.
   */
  showAmazonLink?: boolean;
}

const OPEN_DELAY_MS = 150;
const CLOSE_GRACE_MS = 100;
const TOOLTIP_WIDTH = 300;
const VIEWPORT_GUTTER = 8;

/** Narrow `Product | ProductWithPrice` to the price-bearing variant. */
function hasPrice(p: Product | ProductWithPrice): p is ProductWithPrice {
  return typeof (p as ProductWithPrice).priceCents === "number";
}

/** Cheap touch-capability probe. Re-read on every call so tests can flip it. */
function isTouchOnly(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(hover: none)").matches;
}

/**
 * Reusable hover/tap product preview popover.
 *
 * Shows a card with the product image, price (when available), category,
 * description, and affiliate Amazon link. On hover-capable devices the
 * tooltip opens after a 150 ms delay and closes after a 100 ms grace (long
 * enough for the cursor to travel from the trigger into the card without
 * dismissing). On touch-only devices (matches `(hover: none)`) tapping the
 * trigger toggles the tooltip and a tap outside dismisses it.
 *
 * The card is rendered via `createPortal` into `document.body`, so it
 * escapes `overflow: hidden` parents and z-index stacking contexts.
 *
 * @example
 * <ProductTooltip product={product}>
 *   <span className="breakdown-row-title">{product.title}</span>
 * </ProductTooltip>
 */
export default function ProductTooltip({
  product,
  children,
  disabled = false,
  placement = "auto",
  showAmazonLink = true,
}: ProductTooltipProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    side: "top" | "bottom";
  }>({ top: 0, left: 0, side: "bottom" });

  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const tooltipId = useId();
  const { formatPrice } = useCurrency();

  // --- timer helpers ------------------------------------------------------
  const clearOpenTimer = () => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  };
  const clearCloseTimer = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleOpen = useCallback(() => {
    if (disabled) return;
    clearCloseTimer();
    clearOpenTimer();
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      setOpen(true);
    }, OPEN_DELAY_MS);
  }, [disabled]);

  const scheduleClose = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, CLOSE_GRACE_MS);
  }, []);

  const closeImmediately = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    setOpen(false);
  }, []);

  // --- positioning --------------------------------------------------------
  const recomputePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tooltipHeight = tooltipRef.current?.offsetHeight ?? 200;

    // Prefer the requested side; fall back to auto-flip when it doesn't fit.
    const spaceBelow = vh - rect.bottom;
    const spaceAbove = rect.top;
    let side: "top" | "bottom";
    if (placement === "top") {
      side = "top";
    } else if (placement === "bottom") {
      side = "bottom";
    } else {
      side =
        spaceBelow >= tooltipHeight + VIEWPORT_GUTTER || spaceBelow >= spaceAbove
          ? "bottom"
          : "top";
    }

    let top =
      side === "bottom"
        ? rect.bottom + VIEWPORT_GUTTER
        : rect.top - tooltipHeight - VIEWPORT_GUTTER;
    let left = rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2;

    // Clamp horizontally + vertically into the viewport.
    left = Math.max(
      VIEWPORT_GUTTER,
      Math.min(left, vw - TOOLTIP_WIDTH - VIEWPORT_GUTTER)
    );
    top = Math.max(
      VIEWPORT_GUTTER,
      Math.min(top, vh - tooltipHeight - VIEWPORT_GUTTER)
    );

    setPosition({ top, left, side });
  }, [placement]);

  // Recompute on open and whenever the viewport changes while open.
  // Throttled via requestAnimationFrame so touch-inertia or rapid scrolls
  // from ancestor containers don't thrash getBoundingClientRect + setState.
  useEffect(() => {
    if (!open) return;
    recomputePosition();
    let rafId: number | null = null;
    const handler = () => {
      if (rafId !== null) return; // already queued for this frame
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        recomputePosition();
      });
    };
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, [open, recomputePosition]);

  // --- global dismiss listeners while open --------------------------------
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeImmediately();
    };
    const onMouseDown = (e: globalThis.MouseEvent) => {
      const target = e.target as Node | null;
      if (target && triggerRef.current?.contains(target)) return;
      if (target && tooltipRef.current?.contains(target)) return;
      closeImmediately();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open, closeImmediately]);

  // --- cleanup on unmount -------------------------------------------------
  useEffect(() => {
    return () => {
      clearOpenTimer();
      clearCloseTimer();
    };
  }, []);

  // --- trigger event handlers --------------------------------------------
  const handleMouseEnter = () => {
    if (isTouchOnly()) return;
    scheduleOpen();
  };
  const handleMouseLeave = () => {
    if (isTouchOnly()) return;
    scheduleClose();
  };
  const handleFocus = () => {
    if (isTouchOnly()) return;
    scheduleOpen();
  };
  const handleBlur = () => {
    if (isTouchOnly()) return;
    scheduleClose();
  };
  const handleClick = (e: ReactMouseEvent<HTMLElement>) => {
    if (disabled) return;
    if (!isTouchOnly()) return;
    // Touch toggle — open on first tap, close on second tap.
    // stopPropagation prevents ancestor click handlers (e.g. a surrounding
    // "submit guess" button on the comparison cards) from firing when the
    // user taps a product title just to preview its tooltip.
    e.stopPropagation();
    if (open) {
      closeImmediately();
    } else {
      clearOpenTimer();
      clearCloseTimer();
      setOpen(true);
    }
  };

  // --- clone trigger to attach listeners + a11y --------------------------
  if (!isValidElement(children)) {
    // Should be caught by the `children: ReactElement` TS prop type, but
    // guard at runtime too so misuse fails loudly during dev.
    throw new Error("ProductTooltip requires a single React element child");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const childAny = children as ReactElement<any>;
  const childProps: Record<string, unknown> = childAny.props ?? {};
  // Preserve any ref the caller already attached to the trigger — we call
  // both their ref and ours so we don't silently clobber downstream usage.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalRef: unknown = (childAny as any).ref;
  const setTriggerRef = (node: HTMLElement | null) => {
    triggerRef.current = node;
    if (typeof originalRef === "function") {
      (originalRef as (n: HTMLElement | null) => void)(node);
    } else if (originalRef && typeof originalRef === "object") {
      (originalRef as { current: HTMLElement | null }).current = node;
    }
  };

  const mergedChild = cloneElement(childAny, {
    ref: setTriggerRef,
    "aria-haspopup": "dialog",
    onMouseEnter: (e: ReactMouseEvent<HTMLElement>) => {
      (childProps.onMouseEnter as ((ev: ReactMouseEvent<HTMLElement>) => void) | undefined)?.(e);
      handleMouseEnter();
    },
    onMouseLeave: (e: ReactMouseEvent<HTMLElement>) => {
      (childProps.onMouseLeave as ((ev: ReactMouseEvent<HTMLElement>) => void) | undefined)?.(e);
      handleMouseLeave();
    },
    onFocus: (e: ReactFocusEvent<HTMLElement>) => {
      (childProps.onFocus as ((ev: ReactFocusEvent<HTMLElement>) => void) | undefined)?.(e);
      handleFocus();
    },
    onBlur: (e: ReactFocusEvent<HTMLElement>) => {
      (childProps.onBlur as ((ev: ReactFocusEvent<HTMLElement>) => void) | undefined)?.(e);
      handleBlur();
    },
    onClick: (e: ReactMouseEvent<HTMLElement>) => {
      (childProps.onClick as ((ev: ReactMouseEvent<HTMLElement>) => void) | undefined)?.(e);
      handleClick(e);
    },
    "aria-describedby": open
      ? tooltipId
      : (childProps["aria-describedby"] as string | undefined),
  });

  // --- tooltip card -------------------------------------------------------
  // role="group" rather than "dialog": the component intentionally does not
  // provide focus management or trap semantics, so "dialog" would be
  // misleading to assistive tech. "group" pairs with aria-label to convey
  // "a labeled region" without making promises we don't keep.
  const tooltipNode = open ? (
    <div
      ref={tooltipRef}
      id={tooltipId}
      role="group"
      aria-label="Product preview"
      className={`product-tooltip product-tooltip-${position.side}`}
      style={{
        position: "fixed",
        top: position.top,
        left: position.left,
        width: TOOLTIP_WIDTH,
      }}
      onMouseEnter={() => {
        if (!isTouchOnly()) clearCloseTimer();
      }}
      onMouseLeave={() => {
        if (!isTouchOnly()) scheduleClose();
      }}
    >
      <div className="product-tooltip-img-wrap">
        <img
          src={product.imageUrl}
          alt={product.title}
          className="product-tooltip-img"
          loading="lazy"
        />
      </div>
      <div className="product-tooltip-body">
        <div className="product-tooltip-title">{product.title}</div>
        {hasPrice(product) ? (
          <div className="product-tooltip-price">
            {formatPrice(product.priceCents)}
          </div>
        ) : (
          <div className="product-tooltip-price product-tooltip-price-hidden">
            $???
          </div>
        )}
        {product.category && (
          <div className="product-tooltip-category">{product.category}</div>
        )}
        {showAmazonLink && product.amazonUrl && (
          <AmazonCTA
            href={product.amazonUrl}
            size="sm"
            productLabel={product.title}
            className="product-tooltip-cta"
          />
        )}
      </div>
    </div>
  ) : null;

  // SSR safety: `document` doesn't exist during server render. The app
  // doesn't SSR today, but guarding costs nothing and prevents a crash if
  // Vite SSR or a static export is ever enabled.
  const canPortal = typeof document !== "undefined";

  return (
    <>
      {mergedChild}
      {tooltipNode && canPortal && createPortal(tooltipNode, document.body)}
    </>
  );
}
