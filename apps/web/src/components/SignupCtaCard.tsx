import type { ReactNode } from "react";
import treasureChestImg from "../assets/signup-cta/treasure-chest.webp";

export type SignupCtaVariant = "score" | "streak" | "multiplayer";

interface SignupCtaCardProps {
  variant: SignupCtaVariant;
  /** Final score — used by "score" and "multiplayer" variants to personalize the headline. */
  score?: number;
  onSignup: () => void;
}

interface VariantCopy {
  title: ReactNode;
  benefits: { icon: string; text: string }[];
}

/**
 * Shared signup CTA card rendered on every final-results screen for
 * unauthenticated players. Visual: treasure-chest illustration + headline +
 * three benefits + "Create free account" button. Variant adapts the
 * headline and the middle benefits row to the context of the screen.
 *
 * @param variant - "score" (standard single-player), "streak" (daily
 *   challenge) or "multiplayer" (multiplayer room end-screen).
 * @param score - Optional final score; personalizes "Claim your N points"
 *   for score/multiplayer variants.
 * @param onSignup - Invoked when the button is clicked. Callers wire this
 *   to whatever opens their registration modal.
 */
export default function SignupCtaCard({ variant, score, onSignup }: SignupCtaCardProps) {
  const copy = buildCopy(variant, score);

  return (
    <div className="signup-claim-cta">
      <img
        className="signup-claim-cta-img"
        src={treasureChestImg}
        alt=""
        aria-hidden="true"
      />
      <div className="signup-claim-cta-body">
        <h3 className="signup-claim-cta-title">{copy.title}</h3>
        <ul className="signup-claim-cta-benefits">
          {copy.benefits.map((b) => (
            <li key={b.text}>
              <span aria-hidden="true">{b.icon}</span> {b.text}
            </li>
          ))}
        </ul>
        <div className="signup-claim-cta-actions">
          <button className="btn btn-primary" onClick={onSignup} type="button">
            Create free account
          </button>
        </div>
      </div>
    </div>
  );
}

function buildCopy(variant: SignupCtaVariant, score?: number): VariantCopy {
  const hasScore = typeof score === "number" && score > 0;
  const scoreHeadline = hasScore ? (
    <>
      Claim your{" "}
      <span className="signup-claim-cta-score">{score!.toLocaleString()}</span> points
    </>
  ) : (
    <>Save this game to your account</>
  );

  if (variant === "streak") {
    return {
      title: (
        <>
          <span aria-hidden="true">{"\u{1F525}"}</span> Save your daily streak
        </>
      ),
      benefits: [
        { icon: "\u{1F525}", text: "Keep your streak alive across devices" },
        { icon: "\u{1F3C6}", text: "Climb the global leaderboard" },
        { icon: "\u{1F4CA}", text: "Track every daily in your history" },
      ],
    };
  }

  return {
    title: scoreHeadline,
    benefits: [
      { icon: "\u2B50", text: "Banked toward your lifetime score" },
      { icon: "\u{1F3C6}", text: "Climb the global leaderboard" },
      { icon: "\u{1F4CA}", text: "Track every round in your history" },
    ],
  };
}
