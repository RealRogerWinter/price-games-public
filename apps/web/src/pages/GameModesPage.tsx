import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { GAME_MODES, MODE_DETAILS, MULTIPLAYER_ONLY_MODES } from "@price-game/shared";
import SEO from "../components/SEO";
import SiteFooter from "../components/SiteFooter";
import PageTopBar from "../components/PageTopBar";
import { MODE_ICONS } from "../assets/modeIcons";

/** English number words for small counts so the headline reads naturally
 *  ("All 11 modes" vs "Eleven modes"). Falls back to digits past 12. */
function spellOut(n: number): string {
  const words = [
    "Zero", "One", "Two", "Three", "Four", "Five", "Six",
    "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
  ];
  return n >= 0 && n < words.length ? words[n] : String(n);
}

/**
 * Public Game Modes page. Static content seeded from GAME_MODES; each mode
 * links to its playable route. Indexable, with a VideoGame JSON-LD blob so
 * the site qualifies for rich game results in search.
 *
 * Filters out admin-disabled modes via /api/settings/game-modes (same hook
 * pattern used by the lobby + Quick Play picker) so a turned-off mode
 * doesn't appear as playable to users or as indexable to crawlers. The
 * count in the H1 + intro paragraph + JSON-LD adapts to the live count.
 */
export default function GameModesPage() {
  const navigate = useNavigate();
  const [disabledModes, setDisabledModes] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/settings/game-modes")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.disabledModes) setDisabledModes(new Set(data.disabledModes));
      })
      .catch(() => {});
  }, []);

  const enabledModes = GAME_MODES.filter((m) => !disabledModes.has(m.mode));
  const enabledCount = enabledModes.length;
  const countWord = spellOut(enabledCount).toLowerCase();

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "VideoGame",
    name: "Price Games",
    url: "https://price.games/game-modes",
    description:
      `Free online price-guessing game with ${enabledCount} modes — including Higher or Lower, Comparison, Underbid, Price Match, Market Basket, and Budget Builder.`,
    genre: ["Trivia", "Casual", "Puzzle"],
    gamePlatform: "Web browser",
    operatingSystem: "Web",
    applicationCategory: "Game",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
  };

  return (
    <div className="app">
      <SEO jsonLd={jsonLd} />
      <PageTopBar />
      <main className="legal-page">
        <button className="btn btn-secondary legal-back-btn" onClick={() => navigate("/")}>
          &larr; Back
        </button>
        <h1 className="legal-page-title">All {enabledCount} Game Modes</h1>
        <p className="game-modes-intro">
          Price Games has {countWord} ways to test your pricing instincts — solo, against bots, or live
          against friends in multiplayer rooms. Every mode is free, with no signup required.
        </p>
        <nav className="game-modes-index" aria-label="Jump to a game mode" data-testid="game-modes-index">
          <h2 className="game-modes-index-title">Jump to a mode</h2>
          <ul className="game-modes-index-list">
            {enabledModes.map((m) => (
              <li key={m.mode} className="game-modes-index-item">
                <a className="game-modes-index-link" href={`#${m.mode}`}>
                  <img
                    className="game-modes-index-icon"
                    src={MODE_ICONS[m.mode]}
                    alt=""
                    draggable={false}
                  />
                  <span>{m.name}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <ul className="game-modes-list" data-testid="game-modes-list">
          {enabledModes.map((m) => {
            const detail = MODE_DETAILS[m.mode];
            const mpOnly = MULTIPLAYER_ONLY_MODES.has(m.mode);
            const playHref = mpOnly ? "/mp" : `/play/${encodeURIComponent(m.mode)}`;
            return (
              <li key={m.mode} className="game-mode-card" id={m.mode}>
                <div className="game-mode-card-header">
                  <img
                    className="game-mode-card-icon"
                    src={MODE_ICONS[m.mode]}
                    alt=""
                    draggable={false}
                  />
                  <h2 className="game-mode-card-title">{m.name}</h2>
                  <div className="game-mode-badges">
                    {mpOnly && <span className="game-mode-badge badge-mp">Multiplayer</span>}
                  </div>
                </div>
                <p className="game-mode-tagline">{m.description}</p>
                <div className="game-mode-body">
                  <p>
                    <strong>How to play:</strong> {detail.rules}
                  </p>
                  <p>
                    <strong>Strategy tip:</strong> {detail.strategy}
                  </p>
                </div>
                <div className="game-mode-card-actions">
                  <Link className="btn btn-primary game-mode-play" to={playHref}>
                    {mpOnly ? "Play in Multiplayer" : `Play ${m.name}`}
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      </main>
      <SiteFooter />
    </div>
  );
}
