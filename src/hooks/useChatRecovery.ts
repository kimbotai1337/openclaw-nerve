/**
 * useChatRecovery — Recovery/retry logic extracted from ChatContext
 *
 * Manages stream recovery on disconnect, gap detection recovery via
 * snapshot reconcile, generation-based stale-guard, and reconnect state
 * tracking.
 */
import { useRef, useCallback, useEffect, useMemo } from 'react';
import type { RecoveryReason } from '@/features/chat/operations';
import type { ChatStreamState } from '@/contexts/ChatContext';
import type { ReconcileReason } from '@/features/realtime/types';

// ─── Internal types ─────────────────────────────────────────────────────────────

interface RecoveryState {
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  reason: RecoveryReason | null;
}

// ─── Hook ───────────────────────────────────────────────────────────────────────

interface UseChatRecoveryDeps {
  requestSnapshot: (sessionId: string, reason: ReconcileReason) => Promise<void>;
  currentSessionRef: React.RefObject<string>;
  isGeneratingRef: React.RefObject<boolean>;
  activeRunIdRef: React.RefObject<string | null>;
  setStream: React.Dispatch<React.SetStateAction<ChatStreamState>>;
}

function toReconcileReason(reason: RecoveryReason): ReconcileReason {
  switch (reason) {
    case 'frame-gap':
    case 'chat-gap':
    case 'reconnect':
    case 'subagent-complete':
      return reason;
    case 'unrenderable-final':
      return 'missing-run-activity';
  }
}

export function useChatRecovery({
  requestSnapshot,
  currentSessionRef,
  isGeneratingRef,
  activeRunIdRef,
  setStream,
}: UseChatRecoveryDeps) {
  const recoveryRef = useRef<RecoveryState>({ timer: null, inFlight: false, reason: null });
  // Generation counter: incremented on session switch and chat_final apply.
  // Recovery callbacks compare their captured generation to discard stale results.
  const recoveryGenerationRef = useRef(0);
  // Track whether we were generating at disconnect, for conditional reconnect recovery.
  const wasGeneratingOnDisconnectRef = useRef(false);

  const clearRecoveryTimer = useCallback(() => {
    if (recoveryRef.current.timer) {
      clearTimeout(recoveryRef.current.timer);
      recoveryRef.current.timer = null;
    }
  }, []);

  const triggerRecovery = useCallback((reason: RecoveryReason) => {
    if (recoveryRef.current.inFlight) return;

    clearRecoveryTimer();
    recoveryRef.current.reason = reason;
    setStream(prev => ({ ...prev, isRecovering: true, recoveryReason: reason }));

    const capturedGeneration = recoveryGenerationRef.current;

    recoveryRef.current.timer = setTimeout(async () => {
      recoveryRef.current.timer = null;
      if (recoveryRef.current.inFlight) return;

      // Discard stale recovery if generation changed (session switch or chat_final applied).
      if (capturedGeneration !== recoveryGenerationRef.current) {
        setStream(prev => ({ ...prev, isRecovering: false, recoveryReason: null }));
        return;
      }

      recoveryRef.current.inFlight = true;
      try {
        await requestSnapshot(currentSessionRef.current, toReconcileReason(reason));

        if (capturedGeneration !== recoveryGenerationRef.current) return;
      } catch (err) {
        console.debug('[ChatContext] Recovery failed:', err);
      } finally {
        recoveryRef.current.inFlight = false;
        recoveryRef.current.reason = null;
        setStream(prev => ({ ...prev, isRecovering: false, recoveryReason: null }));
      }
    }, 180);
  }, [clearRecoveryTimer, currentSessionRef, requestSnapshot, setStream]);

  /** Increment the recovery generation counter (invalidates in-flight recoveries). */
  const incrementGeneration = useCallback(() => {
    recoveryGenerationRef.current += 1;
  }, []);

  /** Get the current generation value for stale-guard comparisons. */
  const getGeneration = useCallback(() => recoveryGenerationRef.current, []);

  /** Capture generating state at disconnect time. */
  const captureDisconnectState = useCallback(() => {
    wasGeneratingOnDisconnectRef.current =
      isGeneratingRef.current || Boolean(activeRunIdRef.current);
  }, [isGeneratingRef, activeRunIdRef]);

  /** Check if we were generating at last disconnect. */
  const wasGeneratingOnDisconnect = useCallback(() => wasGeneratingOnDisconnectRef.current, []);

  /** Clear the disconnect-was-generating flag. */
  const clearDisconnectState = useCallback(() => {
    wasGeneratingOnDisconnectRef.current = false;
  }, []);

  /** Whether recovery is currently in flight. */
  const isRecoveryInFlight = useCallback(() => recoveryRef.current.inFlight, []);

  /** Whether a recovery timer is pending. */
  const isRecoveryPending = useCallback(() => recoveryRef.current.timer !== null, []);

  /** Reset all recovery state (for session switch). */
  const resetRecoveryState = useCallback(() => {
    clearRecoveryTimer();
    recoveryRef.current.inFlight = false;
    recoveryRef.current.reason = null;
    recoveryGenerationRef.current += 1;
    wasGeneratingOnDisconnectRef.current = false;
  }, [clearRecoveryTimer]);

  // Cleanup recovery timer on unmount
  useEffect(() => {
    return () => clearRecoveryTimer();
  }, [clearRecoveryTimer]);

  return useMemo(() => ({
    triggerRecovery,
    clearRecoveryTimer,
    incrementGeneration,
    getGeneration,
    captureDisconnectState,
    wasGeneratingOnDisconnect,
    clearDisconnectState,
    isRecoveryInFlight,
    isRecoveryPending,
    resetRecoveryState,
  }), [
    triggerRecovery,
    clearRecoveryTimer,
    incrementGeneration,
    getGeneration,
    captureDisconnectState,
    wasGeneratingOnDisconnect,
    clearDisconnectState,
    isRecoveryInFlight,
    isRecoveryPending,
    resetRecoveryState,
  ]);
}
