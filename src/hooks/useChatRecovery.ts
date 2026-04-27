/**
 * useChatRecovery — Recovery/retry logic extracted from ChatContext
 *
 * Manages stream recovery on disconnect, gap detection recovery via
 * snapshot reconcile plus guarded visible transcript repair, generation-based
 * stale-guard, and reconnect state tracking.
 */
import { useRef, useCallback, useEffect, useMemo } from 'react';
import { loadChatHistory, mergeRecoveredTail } from '@/features/chat/operations';
import type { RecoveryReason, RunState } from '@/features/chat/operations';
import type { ChatMsg } from '@/features/chat/types';
import type { ChatStreamState } from '@/contexts/ChatContext';
import type { ReconcileReason } from '@/features/realtime/types';

export const RECOVERY_LIMITS: Record<RecoveryReason, number> = {
  'unrenderable-final': 40,
  'frame-gap': 80,
  'chat-gap': 80,
  reconnect: 120,
  'subagent-complete': 500,
};

// ─── Internal types ─────────────────────────────────────────────────────────────

interface RecoveryState {
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  reason: RecoveryReason | null;
}

// ─── Hook ───────────────────────────────────────────────────────────────────────

interface UseChatRecoveryDeps {
  rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  requestSnapshot: (sessionId: string, reason: ReconcileReason) => Promise<void>;
  currentSessionRef: React.RefObject<string>;
  isGeneratingRef: React.RefObject<boolean>;
  activeRunIdRef: React.RefObject<string | null>;
  runsRef: React.RefObject<Map<string, RunState>>;
  getAllMessages: () => ChatMsg[];
  applyMessageWindow: (all: ChatMsg[], resetVisibleWindow?: boolean) => void;
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
  rpc,
  requestSnapshot,
  currentSessionRef,
  isGeneratingRef,
  activeRunIdRef,
  runsRef,
  getAllMessages,
  applyMessageWindow,
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
        const sessionId = currentSessionRef.current;
        try {
          await requestSnapshot(sessionId, toReconcileReason(reason));
        } catch (err) {
          console.debug('[ChatContext] Snapshot recovery failed, falling back to visible repair:', err);
        }

        if (capturedGeneration !== recoveryGenerationRef.current) return;

        const recovered = await loadChatHistory({
          rpc,
          sessionKey: sessionId,
          limit: RECOVERY_LIMITS[reason],
        });

        if (capturedGeneration !== recoveryGenerationRef.current) return;

        const activeRun = activeRunIdRef.current;
        const activeBuffer = activeRun
          ? runsRef.current.get(activeRun)?.bufferText || ''
          : '';
        const filtered = activeBuffer.length > 0
          ? recovered.filter((msg) => {
            if (msg.role !== 'assistant') return true;
            if (msg.isThinking) return true;
            if (msg.toolGroup || msg.intermediate) return true;

            const text = (msg.rawText || '').trim();
            if (text.length >= 20 && activeBuffer.includes(text)) return false;
            if (text && text.length < 20 && activeBuffer.trim() === text) return false;
            return true;
          })
          : recovered;

        const merged = mergeRecoveredTail(getAllMessages(), filtered);
        applyMessageWindow(merged, false);
      } catch (err) {
        console.debug('[ChatContext] Recovery failed:', err);
      } finally {
        recoveryRef.current.inFlight = false;
        recoveryRef.current.reason = null;
        setStream(prev => ({ ...prev, isRecovering: false, recoveryReason: null }));
      }
    }, 180);
  }, [
    activeRunIdRef,
    applyMessageWindow,
    clearRecoveryTimer,
    currentSessionRef,
    getAllMessages,
    requestSnapshot,
    rpc,
    runsRef,
    setStream,
  ]);

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
