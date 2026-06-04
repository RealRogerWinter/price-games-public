import { forwardRef, memo } from "react";
import type { AnchorHTMLAttributes } from "react";

/**
 * Visible button label, shared across all callsites. Also imported by tests
 * so assertions don't hard-code the string literal and can survive copy tuning.
 */
export const AMAZON_CTA_LABEL = "See it on Amazon";

export type AmazonCTAVariant = "button" | "inline";
export type AmazonCTASize = "md" | "sm";

export interface AmazonCTAProps
  extends Omit<
    AnchorHTMLAttributes<HTMLAnchorElement>,
    "href" | "rel" | "target" | "children"
  > {
  /** Affiliate URL. */
  href: string;
  /**
   * `button` renders a yellow gradient pill with a hover shimmer; `inline`
   * renders an unadorned text link for dense breakdown rows. Defaults to
   * `button`.
   */
  variant?: AmazonCTAVariant;
  /** Size modifier for the `button` variant. Ignored for `inline`. */
  size?: AmazonCTASize;
  /**
   * Product title, used to disambiguate the aria-label when multiple CTAs
   * render on the same page.
   */
  productLabel?: string;
  /**
   * Render a small "Affiliate link — we may earn a commission." caption
   * directly beneath the button. Required for FTC close-proximity
   * compliance on hero CTAs (result overlays, share cards, per-mode
   * finishing screens). Ignored for the `inline` variant.
   */
  showDisclosure?: boolean;
  /**
   * Analytics hook invoked on click. Fires before the user's own onClick
   * handler, if any.
   */
  onAffiliateClick?: () => void;
}

/**
 * Trailing external-link glyph. Signals "opens in new tab" — honest, and
 * avoids trademark issues with the Amazon smile logo (restricted by the
 * Associates Program Operating Agreement outside SiteStripe).
 */
const ExternalArrow = ({ size }: { size: number }) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    aria-hidden="true"
    focusable="false"
    className="amazon-cta__arrow"
  >
    <path
      d="M6 3h7v7M13 3L6.5 9.5M11 8.5V13H3V5h4.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * Affiliate CTA anchor that opens an Amazon product page in a new tab.
 *
 * Always renders:
 *  - `target="_blank"` + `rel="sponsored nofollow noopener noreferrer"` —
 *    `sponsored` is required by the FTC endorsement guides and Amazon
 *    Associates agreement; `noopener noreferrer` prevent tabnabbing.
 *  - aria-label with "(opens in new tab)" suffix and the product title
 *    when `productLabel` is provided.
 *
 * @param props - See {@link AmazonCTAProps}.
 * @returns An anchor element ready to drop into any layout.
 */
export const AmazonCTA = memo(
  forwardRef<HTMLAnchorElement, AmazonCTAProps>(function AmazonCTA(
    {
      href,
      variant = "button",
      size = "md",
      productLabel,
      showDisclosure = false,
      onAffiliateClick,
      className = "",
      onClick,
      ...rest
    },
    ref,
  ) {
    const classes =
      variant === "inline"
        ? ["amazon-cta", "amazon-cta--inline", className].filter(Boolean).join(" ")
        : ["amazon-cta", "amazon-cta--button", `amazon-cta--${size}`, className]
            .filter(Boolean)
            .join(" ");

    const ariaLabel = productLabel
      ? `${AMAZON_CTA_LABEL}: ${productLabel} (opens in new tab)`
      : `${AMAZON_CTA_LABEL} (opens in new tab)`;

    const arrowSize = variant === "inline" ? 11 : size === "sm" ? 12 : 14;

    const link = (
      <a
        {...rest}
        ref={ref}
        href={href}
        className={classes}
        target="_blank"
        rel="sponsored nofollow noopener noreferrer"
        aria-label={ariaLabel}
        onClick={(e) => {
          onAffiliateClick?.();
          onClick?.(e);
        }}
      >
        {variant === "button" && (
          <span aria-hidden="true" className="amazon-cta__shine" />
        )}
        <span className="amazon-cta__label">{AMAZON_CTA_LABEL}</span>
        <ExternalArrow size={arrowSize} />
      </a>
    );

    if (variant === "inline" || !showDisclosure) return link;

    return (
      <span className="amazon-cta__wrap">
        {link}
        <span className="amazon-cta__disclosure">
          Affiliate link — we may earn a commission.
        </span>
      </span>
    );
  }),
);
