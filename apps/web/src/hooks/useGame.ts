import { useState, useEffect, useCallback, useRef } from "react";
import type { GameSession, Product, RoundResult, DailyCompletionPayload } from "@price-game/shared";
import { ROUND_TIME_SECONDS } from "@price-game/shared";
import * as api from "../api/client";
import { useTimer } from "./useTimer";
import { soundEngine } from "../audio/SoundEngine";

interface UseGameOptions {
  session: GameSession;
  onRoundComplete: (result: RoundResult, session: GameSession, dailyPayload?: DailyCompletionPayload) => void;
}

export function useGame({ session, onRoundComplete }: UseGameOptions) {
  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(false);
  const [roundResult, setRoundResult] = useState<RoundResult | null>(null);
  const [currentRound, setCurrentRound] = useState(session.currentRound);
  const [hasGuessed, setHasGuessed] = useState(false);
  const [hintRange, setHintRange] = useState<{ min: number; max: number } | null>(null);
  const [hintUsed, setHintUsed] = useState(false);
  const [hintLoading, setHintLoading] = useState(false);
  const [timerStarted, setTimerStarted] = useState(false);

  // Use refs to avoid stale closures in timer callback
  const hasGuessedRef = useRef(hasGuessed);
  hasGuessedRef.current = hasGuessed;
  const sessionIdRef = useRef(session.id);
  sessionIdRef.current = session.id;

  const handleTimerExpire = useCallback(() => {
    if (!hasGuessedRef.current) {
      soundEngine.play("timer_expire");
      doSubmitGuess(0, true);
    }
  }, []);

  const timer = useTimer(ROUND_TIME_SECONDS, handleTimerExpire);

  // Called when user first interacts with the price input
  const activateTimer = useCallback(() => {
    if (!timerStarted && !hasGuessed && !roundResult) {
      setTimerStarted(true);
      timer.start();
    }
  }, [timerStarted, hasGuessed, roundResult, timer.start]);

  const fetchProduct = useCallback(async (round: number) => {
    setLoading(true);
    setRoundResult(null);
    setHasGuessed(false);
    setHintRange(null);
    setHintUsed(false);
    setTimerStarted(false);
    timer.reset();
    try {
      const p = await api.getProduct(session.id);
      setProduct(p);
      // Auto-start timer on rounds after the first; round 1 waits for interaction
      if (round > 1) {
        setTimerStarted(true);
        timer.start();
      }
    } catch (err) {
      console.error("Failed to fetch product:", err);
    } finally {
      setLoading(false);
    }
  }, [session.id, timer.reset, timer.start]);

  useEffect(() => {
    fetchProduct(currentRound);
  }, [currentRound]);

  // Core submit function using refs to always have fresh state
  const doSubmitGuess = useCallback(async (guessedPriceCents: number, timedOut?: boolean) => {
    if (hasGuessedRef.current) return;
    hasGuessedRef.current = true;
    setHasGuessed(true);
    timer.stop();
    if (!timedOut) soundEngine.play("guess_submit");
    try {
      const response = await api.submitGuess(sessionIdRef.current, guessedPriceCents, timedOut);
      setRoundResult(response.result);
      onRoundComplete(response.result, response.session, response.daily);
    } catch (err) {
      console.error("Failed to submit guess:", err);
      hasGuessedRef.current = false;
      setHasGuessed(false);
    }
  }, [timer.stop, onRoundComplete]);

  async function submitGuess(guessedPriceCents: number) {
    doSubmitGuess(guessedPriceCents);
  }

  async function useHint() {
    if (hintUsed || hintLoading || hasGuessed) return;
    activateTimer();
    setHintLoading(true);
    try {
      const data = await api.getHint(session.id);
      setHintRange(data.hintRange);
      setHintUsed(true);
    } catch (err) {
      console.error("Failed to get hint:", err);
    } finally {
      setHintLoading(false);
    }
  }

  function nextRound() {
    soundEngine.play("next_round");
    setCurrentRound((r) => r + 1);
  }

  return {
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
  };
}
