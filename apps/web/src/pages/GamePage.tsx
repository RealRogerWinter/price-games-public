import type { GameSession, RoundResult as RoundResultType, DailyCompletionPayload } from "@price-game/shared";
import { useGame } from "../hooks/useGame";
import ProductCard from "../components/ProductCard";
import PriceInput from "../components/PriceInput";
import Timer from "../components/Timer";
import Scoreboard from "../components/Scoreboard";
import RoundResultComponent from "../components/RoundResult";

interface GamePageProps {
  session: GameSession;
  onRoundComplete: (result: RoundResultType, session: GameSession, dailyPayload?: DailyCompletionPayload) => void;
  onGameEnd: () => void;
}

export default function GamePage({
  session,
  onRoundComplete,
  onGameEnd,
}: GamePageProps) {
  const {
    product,
    loading,
    roundResult,
    currentRound,
    submitGuess,
    nextRound,
    timer,
    timerStarted,
    activateTimer,
    hasGuessed,
    hintRange,
    hintUsed,
    hintLoading,
    useHint,
  } = useGame({ session, onRoundComplete });

  const isLastRound = currentRound >= session.totalRounds;
  const runningScore = session.totalScore;

  function handleNextRound() {
    if (isLastRound) {
      onGameEnd();
    } else {
      nextRound();
    }
  }

  if (loading || !product) {
    return (
      <div className="page game-page" data-testid="game-page-classic" data-mode="classic">
        <Scoreboard
          currentRound={currentRound}
          totalRounds={session.totalRounds}
          score={runningScore}
        />
        <div className="loading">Loading product...</div>
      </div>
    );
  }

  return (
    <div className="page game-page" data-testid="game-page-classic" data-mode="classic">
      <div className="game-header">
        <Scoreboard
          currentRound={currentRound}
          totalRounds={session.totalRounds}
          score={runningScore}
        />
        <Timer
          secondsLeft={timer.secondsLeft}
          isRunning={timer.isRunning}
          paused={!timerStarted && !hasGuessed && !roundResult}
        />
      </div>

      <ProductCard key={product.id} product={product} hideAmazonLink />

      {!timerStarted && !hasGuessed && currentRound === 1 && !roundResult && (
        <div className="timer-hint">Timer starts when you interact</div>
      )}

      <PriceInput
        category={product.category}
        priceRange={hintRange ?? product.priceRange}
        onSubmit={submitGuess}
        disabled={hasGuessed}
        onInteract={activateTimer}
      />
      {!hintUsed && !hasGuessed && !roundResult && (
        <button
          className="btn btn-hint"
          onClick={useHint}
          disabled={hintLoading}
          data-testid="btn-hint"
        >
          {hintLoading ? "Getting hint..." : "Use Hint"}
        </button>
      )}
      {hintRange && !roundResult && (
        <div className="hint-badge">
          Hint active — price narrowed to a tighter range
        </div>
      )}

      {roundResult && (
        <div className="result-overlay">
          <RoundResultComponent
            result={roundResult}
            isLastRound={isLastRound}
            onNextRound={handleNextRound}
            usedHint={hintUsed}
          />
        </div>
      )}
    </div>
  );
}
