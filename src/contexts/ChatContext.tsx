/**
 * ChatContext — Thin orchestrator that composes chat hooks
 *
 * Business logic is distributed across composable hooks:
 * - useChatMessages: message CRUD, dedup, history, infinite scroll
 * - useChatStreaming: stream rendering, processing stage, activity log
 * - useChatRecovery: recovery/retry, gap detection, generation guards
 * - useChatTTS: TTS playback, voice fallback, sound feedback
 *
 * This file handles:
 * - React context creation and provider
 * - Session-level state (isGenerating, showResetConfirm)
 * - Run state management (runsRef, activeRunIdRef, sequence tracking)
 * - Gateway event subscription (delegating to hook methods)
 * - Wiring hook outputs into the context value
 */
import { createContext, useContext, useCallback, useRef, useEffect, useState, useMemo, type ReactNode } from 'react';
import { useGateway } from './GatewayContext';
import { useRealtime } from './RealtimeContext';
import { useSessionContext } from './SessionContext';
import { useSettings } from './SettingsContext';
import type { GatewayEvent } from '@/types';
import {
  getRootAgentSessionKey,
  isRootChildSession,
  isSubagentSessionKey,
  isTopLevelAgentSessionKey,
} from '@/features/sessions/sessionKeys';
import {
  processChatMessages,
  buildUserMessage,
  sendChatMessage,
  loadChatHistory,
  classifyStreamEvent,
  extractStreamDelta,
  extractFinalMessage,
  extractFinalMessages,
  deriveProcessingStage,
  isActiveAgentState,
  mergeRecoveredTail,
  getOrCreateRunState,
  hasSeqGap,
  pruneRunRegistry,
  resolveRunId,
  createFallbackRunId,
  updateHighestSeq,
} from '@/features/chat/operations';
import { normalizeLocalRunCreated } from '@/features/realtime/normalizedEvent';
import {
  isTerminalAgentPhase,
  selectSessionAgentPresence,
  selectSessionIsGenerating,
} from '@/features/realtime/selectors';
import { generateMsgId } from '@/features/chat/types';
import type { ImageAttachment, ChatMsg, OutgoingUploadPayload } from '@/features/chat/types';
import type { RecoveryReason, RunState } from '@/features/chat/operations';
import type { RealtimeMessageEntity } from '@/features/realtime/types';
import { renderMarkdown, renderToolResults } from '@/utils/helpers';

import {
  useChatMessages,
  isLikelyDuplicateMessage,
  mergeFinalMessages,
  normalizeComparableText,
  patchThinkingDuration,
} from '@/hooks/useChatMessages';
import { useChatStreaming } from '@/hooks/useChatStreaming';
import { useChatRecovery } from '@/hooks/useChatRecovery';
import { useChatTTS } from '@/hooks/useChatTTS';

// ─── Exported types (consumed by features/chat components) ──────────────────────

/** Processing stages for enhanced thinking indicator */
export type ProcessingStage = 'thinking' | 'tool_use' | 'streaming' | null;

/** A single entry in the activity log */
export interface ActivityLogEntry {
  id: string;           // toolCallId or generated unique id
  toolName: string;     // raw tool name (e.g., 'read', 'exec')
  description: string;  // human-friendly from describeToolUse()
  startedAt: number;    // Date.now() when tool started
  completedAt?: number; // Date.now() when result received
  phase: 'running' | 'completed';
}

export interface ChatStreamState {
  html: string;
  runId?: string;
  isRecovering?: boolean;
  recoveryReason?: RecoveryReason | null;
}

interface ChatContextValue {
  messages: ChatMsg[];
  isGenerating: boolean;
  stream: ChatStreamState;
  processingStage: ProcessingStage;
  lastEventTimestamp: number;
  activityLog: ActivityLogEntry[];
  currentToolDescription: string | null;
  handleSend: (text: string, images?: ImageAttachment[]) => Promise<void>;
  handleAbort: () => Promise<void>;
  handleReset: () => void;
  loadHistory: (session?: string) => Promise<void>;
  /** Load more (older) messages — returns true if there are still more to show */
  loadMore: () => boolean;
  /** Whether there are older messages available to load */
  hasMore: boolean;
  /** Reset confirmation dialog state — rendered by the consumer, not the provider */
  showResetConfirm: boolean;
  confirmReset: () => Promise<void>;
  cancelReset: () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

function findHistoryMetadataSource(
  existingMessages: ChatMsg[],
  message: ChatMsg,
  claimedSourceIndices: Set<number>,
): { index: number; message: ChatMsg } | null {
  const normalizedText = normalizeComparableText(message.rawText);
  const messageTimestamp = message.timestamp.getTime();
  let bestMatch: { index: number; message: ChatMsg } | null = null;
  let bestTimeDiff = Number.POSITIVE_INFINITY;

  existingMessages.forEach((candidate, index) => {
    if (claimedSourceIndices.has(index)) return;
    if (candidate.pending || candidate.failed || candidate.toolGroup || candidate.intermediate || candidate.isThinking) {
      return;
    }
    if (candidate.role !== message.role) return;
    if (normalizeComparableText(candidate.rawText) !== normalizedText) return;

    const timeDiff = Math.abs(candidate.timestamp.getTime() - messageTimestamp);
    if (timeDiff > 60_000 || timeDiff > bestTimeDiff) return;

    bestMatch = { index, message: candidate };
    bestTimeDiff = timeDiff;
  });

  return bestMatch;
}

function buildComparableRealtimeChatMsg(message: RealtimeMessageEntity): ChatMsg {
  return {
    msgId: message.messageId,
    role: message.role,
    html: '',
    rawText: message.contentParts.map((part) => part.text).join(''),
    timestamp: new Date(message.createdAt),
  };
}

function isDurableAssistantHistoryMessage(message: ChatMsg): boolean {
  if (message.role !== 'assistant') return false;
  if (message.pending || message.failed || message.toolGroup || message.intermediate || message.isThinking) {
    return false;
  }
  return true;
}

function shouldDeferRealtimeProjection(
  existingMessages: ChatMsg[],
  visibleRealtimeMessages: RealtimeMessageEntity[],
  reconcileNeeded: boolean,
): boolean {
  if (!reconcileNeeded) return false;

  const existingAssistantHistory = existingMessages.filter(isDurableAssistantHistoryMessage);
  if (existingAssistantHistory.length === 0) return false;

  const visibleRealtimeAssistants = visibleRealtimeMessages.filter((message) => message.role === 'assistant');
  if (visibleRealtimeAssistants.length < existingAssistantHistory.length) return true;

  const claimedHistorySourceIndices = new Set<number>();
  let overlapCount = 0;
  for (const message of visibleRealtimeAssistants) {
    const historyMatch = findHistoryMetadataSource(
      existingAssistantHistory,
      buildComparableRealtimeChatMsg(message),
      claimedHistorySourceIndices,
    );
    if (!historyMatch) continue;
    claimedHistorySourceIndices.add(historyMatch.index);
    overlapCount += 1;
  }

  return overlapCount < Math.min(existingAssistantHistory.length, visibleRealtimeAssistants.length);
}

function mapRealtimeMessageToChatMsg(
  message: RealtimeMessageEntity,
  existingMessages: ChatMsg[],
  claimedSourceIndices: Set<number>,
): ChatMsg {
  const comparableMessage = buildComparableRealtimeChatMsg(message);
  const rawText = comparableMessage.rawText;
  const baseMessage: ChatMsg = {
    ...comparableMessage,
    html: rawText.length > 0 ? renderToolResults(renderMarkdown(rawText)) : '',
    streaming: false,
    charts: message.charts,
    uploadAttachments: message.uploadAttachments,
  };
  const metadataMatch = findHistoryMetadataSource(existingMessages, baseMessage, claimedSourceIndices);
  if (!metadataMatch) return baseMessage;

  claimedSourceIndices.add(metadataMatch.index);
  const metadataSource = metadataMatch.message;

  return {
    ...baseMessage,
    msgId: metadataSource.msgId ?? baseMessage.msgId,
    collapsed: metadataSource.collapsed,
    charts: baseMessage.charts ?? metadataSource.charts,
    uploadAttachments: baseMessage.uploadAttachments ?? metadataSource.uploadAttachments,
    images: metadataSource.images,
    extractedImages: metadataSource.extractedImages,
    isVoice: metadataSource.isVoice,
    isSystemNotification: metadataSource.isSystemNotification,
    systemLabel: metadataSource.systemLabel,
  };
}

function shouldPreserveOverlayMessage(message: ChatMsg, realtimeMessages: ChatMsg[]): boolean {
  if (message.pending || message.failed) return true;
  if (message.role === 'tool' || message.role === 'toolResult' || message.role === 'event') return true;
  if (message.toolGroup || message.intermediate || message.isThinking) return true;

  if (message.role === 'user' || message.role === 'system') {
    return !realtimeMessages.some((candidate) => isLikelyDuplicateMessage(candidate, message));
  }

  return false;
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const { connectionState, rpc, subscribe } = useGateway();
  const { state: realtimeState, dispatch: realtimeDispatch, requestSnapshot } = useRealtime();
  const { currentSession } = useSessionContext();
  const { soundEnabled, speak } = useSettings();

  // ─── Shared state ─────────────────────────────────────────────────────────
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSendPending, setIsSendPending] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // ─── Refs for stable callback references ──────────────────────────────────
  const currentSessionRef = useRef(currentSession);
  const isGeneratingRef = useRef(isGenerating);
  const soundEnabledRef = useRef(soundEnabled);
  const speakRef = useRef(speak);

  useEffect(() => {
    currentSessionRef.current = currentSession;
    soundEnabledRef.current = soundEnabled;
    speakRef.current = speak;
  }, [currentSession, soundEnabled, speak]);

  // ─── Run state management ─────────────────────────────────────────────────
  const runsRef = useRef<Map<string, RunState>>(new Map());
  const activeRunIdRef = useRef<string | null>(null);
  const lastGatewaySeqRef = useRef<number | null>(null);
  const lastChatSeqRef = useRef<number | null>(null);
  const toolResultRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Compose hooks ────────────────────────────────────────────────────────
  const msgHook = useChatMessages({ rpc, currentSessionRef });
  const streamHook = useChatStreaming();
  const ttsHook = useChatTTS({ soundEnabled: soundEnabledRef, speak: speakRef });

  const {
    loadHistory,
    getAllMessages,
    applyMessageWindow,
  } = msgHook;

  const recoveryHook = useChatRecovery({
    rpc,
    requestSnapshot,
    currentSessionRef,
    isGeneratingRef,
    activeRunIdRef,
    runsRef,
    getAllMessages,
    applyMessageWindow,
    setStream: streamHook.setStream,
  });
  const {
    triggerRecovery,
    clearDisconnectState,
    captureDisconnectState,
    wasGeneratingOnDisconnect,
    isRecoveryInFlight,
    isRecoveryPending,
    incrementGeneration,
    getGeneration,
  } = recoveryHook;
  const {
    lastEventTimestamp,
    setProcessingStage,
    setLastEventTimestamp,
    setActivityLog,
    addActivityEntry,
    completeActivityEntry,
    startThinking,
    captureThinkingDuration,
    scheduleStreamingUpdate,
    clearStreamBuffer,
    getThinkingDuration,
    resetThinking,
  } = streamHook;
  const {
    playCompletionPing,
    resetPlayedSounds,
    handleFinalTTS,
  } = ttsHook;
  const lastSessionSnapshotRequestRef = useRef<string | null>(null);
  const inFlightSessionSnapshotRequestRef = useRef<string | null>(null);
  const previousSubagentPhaseRef = useRef<{ sessionId: string; phase: string | null } | null>(null);
  const realtimePresence = currentSession
    ? selectSessionAgentPresence(realtimeState, currentSession)
    : null;
  const realtimeIsGenerating = currentSession
    ? selectSessionIsGenerating(realtimeState, currentSession)
    : false;
  const visibleIsGenerating = isGenerating || isSendPending || realtimeIsGenerating;

  useEffect(() => {
    isGeneratingRef.current = isGenerating || visibleIsGenerating;
  }, [isGenerating, visibleIsGenerating]);

  // ─── Reset transient state on session switch ──────────────────────────────
  useEffect(() => {
    setIsGenerating(false);
    setIsSendPending(false);
    msgHook.resetMessageState();
    streamHook.resetStreamState();
    recoveryHook.resetRecoveryState();
    runsRef.current.clear();
    activeRunIdRef.current = null;
    lastGatewaySeqRef.current = null;
    lastChatSeqRef.current = null;
    lastSessionSnapshotRequestRef.current = null;
    inFlightSessionSnapshotRequestRef.current = null;
    reconnectRecoveryOwnsHistoryRef.current = false;
    if (toolResultRefreshRef.current) {
      clearTimeout(toolResultRefreshRef.current);
      toolResultRefreshRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSession]);

  // ─── Load history on connect / recover on reconnect ───────────────────────
  const previousConnectionStateRef = useRef(connectionState);
  const historyLoadConnectionStateRef = useRef<typeof connectionState>('disconnected');
  const reconnectRecoveryOwnsHistoryRef = useRef(false);
  useEffect(() => {
    const prevConnection = previousConnectionStateRef.current;

    if (connectionState === 'connected') {
      const shouldRecoverReconnect =
        prevConnection === 'reconnecting' && wasGeneratingOnDisconnect();
      reconnectRecoveryOwnsHistoryRef.current = shouldRecoverReconnect;

      if (shouldRecoverReconnect) {
        triggerRecovery('reconnect');
      }
      clearDisconnectState();
    }

    if (connectionState === 'reconnecting' && prevConnection === 'connected') {
      reconnectRecoveryOwnsHistoryRef.current = false;
      captureDisconnectState();
    }

    previousConnectionStateRef.current = connectionState;
  }, [
    connectionState,
    wasGeneratingOnDisconnect,
    triggerRecovery,
    clearDisconnectState,
    captureDisconnectState,
  ]);

  useEffect(() => {
    const prevConnection = historyLoadConnectionStateRef.current;
    historyLoadConnectionStateRef.current = connectionState;

    if (connectionState !== 'connected' || !currentSession) return;
    if (prevConnection === 'reconnecting' && reconnectRecoveryOwnsHistoryRef.current) {
      reconnectRecoveryOwnsHistoryRef.current = false;
      return;
    }

    void loadHistory(currentSession);
    reconnectRecoveryOwnsHistoryRef.current = false;
  }, [connectionState, currentSession, loadHistory]);

  useEffect(() => {
    if (connectionState !== 'connected' || !currentSession) return;
    if (lastSessionSnapshotRequestRef.current === currentSession) return;
    if (inFlightSessionSnapshotRequestRef.current === currentSession) return;

    const requestedSession = currentSession;
    inFlightSessionSnapshotRequestRef.current = requestedSession;
    void requestSnapshot(requestedSession, 'session-switch')
      .then(() => {
        if (currentSessionRef.current === requestedSession) {
          lastSessionSnapshotRequestRef.current = requestedSession;
        }
      })
      .catch(() => {
        if (lastSessionSnapshotRequestRef.current === requestedSession) {
          lastSessionSnapshotRequestRef.current = null;
        }
      })
      .finally(() => {
        if (inFlightSessionSnapshotRequestRef.current === requestedSession) {
          inFlightSessionSnapshotRequestRef.current = null;
        }
      });
  }, [connectionState, currentSession, requestSnapshot]);

  const visibleRealtimeMessages = useMemo(
    () => currentSession
      ? Object.values(realtimeState.messages)
        .filter((message) => message.sessionId === currentSession && message.status !== 'superseded')
        .sort((left, right) => {
          if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
          if (left.revision !== right.revision) return left.revision - right.revision;
          return left.messageId.localeCompare(right.messageId);
        })
      : [],
    [currentSession, realtimeState.messages],
  );

  useEffect(() => {
    if (!currentSession) return;
    if (visibleRealtimeMessages.length === 0) return;

    const existingMessages = getAllMessages();
    if (shouldDeferRealtimeProjection(
      existingMessages,
      visibleRealtimeMessages,
      realtimeState.connection.reconcileNeeded,
    )) {
      return;
    }

    const claimedHistorySourceIndices = new Set<number>();
    const durableMessages = visibleRealtimeMessages.map((message) =>
      mapRealtimeMessageToChatMsg(message, existingMessages, claimedHistorySourceIndices),
    );
    const overlayMessages = existingMessages.filter((message) =>
      shouldPreserveOverlayMessage(message, durableMessages),
    );
    const mergedMessages = mergeFinalMessages(durableMessages, overlayMessages);

    applyMessageWindow(mergedMessages, false);
  }, [
    applyMessageWindow,
    currentSession,
    getAllMessages,
    realtimeState.connection.reconcileNeeded,
    visibleRealtimeMessages,
  ]);

  // ─── Watchdog: if stream stalls, recover once ─────────────────────────────
  useEffect(() => {
    if (!isGenerating || !lastEventTimestamp) return;

    const timer = setTimeout(() => {
      const elapsed = Date.now() - lastEventTimestamp;
      if (elapsed >= 12_000 && !isRecoveryInFlight() && !isRecoveryPending()) {
        triggerRecovery('chat-gap');
      }
    }, 12_000);

    return () => clearTimeout(timer);
  }, [
    isGenerating,
    lastEventTimestamp,
    isRecoveryInFlight,
    isRecoveryPending,
    triggerRecovery,
  ]);

  useEffect(() => {
    if (!currentSession || !isSubagentSessionKey(currentSession)) {
      previousSubagentPhaseRef.current = null;
      return;
    }

    const phase = realtimePresence?.phase ?? null;
    const previous = previousSubagentPhaseRef.current;
    previousSubagentPhaseRef.current = { sessionId: currentSession, phase };

    const previousPhase = previous?.sessionId === currentSession ? previous.phase : null;
    const enteredTerminalPhase =
      isTerminalAgentPhase(phase)
      && previousPhase !== null
      && !isTerminalAgentPhase(previousPhase);

    if (!enteredTerminalPhase) return;
    void requestSnapshot(currentSession, 'subagent-complete');
  }, [currentSession, realtimePresence?.phase, requestSnapshot]);

  // ─── Subscribe to streaming events ────────────────────────────────────────
  useEffect(() => {
    return subscribe((msg: GatewayEvent) => {
      let recoveryTriggeredThisEvent = false;
      const triggerRecoveryOnce = (reason: RecoveryReason) => {
        if (recoveryTriggeredThisEvent) return;
        recoveryTriggeredThisEvent = true;
        triggerRecovery(reason);
      };

      const classified = classifyStreamEvent(msg);
      if (!classified) return;

      const currentSk = currentSessionRef.current;
      if (classified.sessionKey !== currentSk) {
        if (
          isTopLevelAgentSessionKey(currentSk) &&
          classified.sessionKey &&
          isSubagentSessionKey(classified.sessionKey) &&
          isRootChildSession(classified.sessionKey, getRootAgentSessionKey(currentSk) || currentSk) &&
          (classified.type === 'chat_final' || classified.type === 'lifecycle_end')
        ) {
          triggerRecovery('subagent-complete');
        }
        return;
      }

      // Track gateway frame sequence
      if (typeof msg.seq === 'number') {
        if (hasSeqGap(lastGatewaySeqRef.current, msg.seq) && (isGeneratingRef.current || Boolean(activeRunIdRef.current))) {
          triggerRecoveryOnce('frame-gap');
        }
        lastGatewaySeqRef.current = updateHighestSeq(lastGatewaySeqRef.current, msg.seq);
      }

      const { type } = classified;

      // ── Agent events ────────────────────────────────────────────────────
      if (classified.source === 'agent') {
        const ap = classified.agentPayload!;

        if (type === 'lifecycle_start') {
          setIsGenerating(true);
          setProcessingStage('thinking');
          setLastEventTimestamp(Date.now());
          return;
        }

        if (type === 'lifecycle_end') {
          setIsGenerating(false);
          setProcessingStage(null);
          setActivityLog([]);
          setLastEventTimestamp(0);
          playCompletionPing();

          incrementGeneration();

          const activeRun = activeRunIdRef.current;
          const runFinalized = activeRun ? runsRef.current.get(activeRun)?.finalized : false;
          if (!runFinalized) {
            triggerRecovery('reconnect');
          }
          activeRunIdRef.current = null;
          return;
        }

        if (type === 'assistant_stream') {
          setProcessingStage('streaming');
          setLastEventTimestamp(Date.now());
          return;
        }

        const agentState = ap.state || ap.agentState;
        if (!isGeneratingRef.current && agentState && isActiveAgentState(agentState)) {
          setIsGenerating(true);
        }

        setLastEventTimestamp(Date.now());

        if (type === 'agent_tool_start') {
          setProcessingStage('tool_use');
          addActivityEntry(ap);
          return;
        }

        if (type === 'agent_tool_result') {
          const completedId = ap.data?.toolCallId;
          if (completedId) completeActivityEntry(completedId);

          if (toolResultRefreshRef.current) clearTimeout(toolResultRefreshRef.current);
          const capturedSession = currentSessionRef.current;
          const capturedGeneration = getGeneration();
          toolResultRefreshRef.current = setTimeout(async () => {
            toolResultRefreshRef.current = null;
            try {
              const recovered = await loadChatHistory({ rpc, sessionKey: capturedSession, limit: 100 });
              if (capturedSession !== currentSessionRef.current) return;
              if (capturedGeneration !== getGeneration()) return;
              if (recovered.length > 0) {
                const merged = mergeRecoveredTail(getAllMessages(), recovered);
                applyMessageWindow(merged, false);
              }
            } catch { /* best-effort */ }
          }, 300);
          return;
        }

        if (type === 'agent_state' && agentState) {
          const stage = deriveProcessingStage(agentState);
          if (stage) setProcessingStage(stage);
        }
        return;
      }

      // ── Chat events ─────────────────────────────────────────────────────
      const cp = classified.chatPayload!;
      const activeRunBefore = activeRunIdRef.current;
      const runId = resolveRunId(classified.runId, activeRunBefore)
        ?? createFallbackRunId(currentSessionRef.current);

      const run = getOrCreateRunState(runsRef.current, runId, currentSessionRef.current);
      run.lastFrameSeq = updateHighestSeq(run.lastFrameSeq, classified.frameSeq);

      if (hasSeqGap(lastChatSeqRef.current, classified.chatSeq)) {
        triggerRecoveryOnce('chat-gap');
      }
      lastChatSeqRef.current = updateHighestSeq(lastChatSeqRef.current, classified.chatSeq);

      if (hasSeqGap(run.lastChatSeq, classified.chatSeq)) {
        triggerRecoveryOnce('chat-gap');
      }
      const prevRunSeq = run.lastChatSeq;
      run.lastChatSeq = updateHighestSeq(run.lastChatSeq, classified.chatSeq);

      setLastEventTimestamp(Date.now());

      if (type === 'chat_started') {
        activeRunIdRef.current = runId;
        run.startedAt = Date.now();
        run.finalized = false;
        run.status = 'started';
        run.stopReason = undefined;
        run.bufferRaw = '';
        run.bufferText = '';

        setIsGenerating(true);
        resetPlayedSounds();
        setProcessingStage('thinking');
        setActivityLog([]);
        startThinking(runId);
        return;
      }

      if (type === 'chat_delta') {
        if (run.finalized) return;
        if (typeof classified.chatSeq === 'number' && prevRunSeq !== null && classified.chatSeq <= prevRunSeq) return;

        if (!isGeneratingRef.current) setIsGenerating(true);
        if (!activeRunIdRef.current) activeRunIdRef.current = runId;

        captureThinkingDuration();

        const delta = extractStreamDelta(cp);
        if (delta) {
          run.bufferRaw = delta.text;
          run.bufferText = delta.cleaned;
          scheduleStreamingUpdate(runId, run.bufferText);
          setProcessingStage('streaming');
        }
        return;
      }

      if (type === 'chat_final') {
        const isActiveRun = activeRunBefore !== null
          ? activeRunBefore === runId
          : isGeneratingRef.current;

        run.finalized = true;
        run.status = 'ok';
        run.stopReason = cp.stopReason;
        run.bufferRaw = '';
        run.bufferText = '';

        if (activeRunIdRef.current === runId) activeRunIdRef.current = null;
        incrementGeneration();

        if (isActiveRun) {
          setIsGenerating(false);
          setProcessingStage(null);
          setActivityLog([]);
          setLastEventTimestamp(0);
          clearStreamBuffer();
        }

        const finalData = extractFinalMessage(cp);
        const finalMessages = processChatMessages(extractFinalMessages(cp));

        if (finalMessages.length > 0) {
          const merged = mergeFinalMessages(getAllMessages(), finalMessages);
          const thinkingDuration = getThinkingDuration(runId);
          const withDuration = thinkingDuration
            ? patchThinkingDuration(merged, thinkingDuration)
            : merged;
          applyMessageWindow(withDuration, false);
        } else {
          triggerRecovery('unrenderable-final');
        }

        handleFinalTTS(finalData, isActiveRun);
        resetThinking();
        pruneRunRegistry(runsRef.current, activeRunIdRef.current);
        return;
      }

      if (type === 'chat_aborted') {
        const isActiveRun = activeRunBefore !== null
          ? activeRunBefore === runId
          : isGeneratingRef.current;

        run.finalized = true;
        run.status = undefined;
        run.stopReason = cp.stopReason || 'aborted';
        run.bufferRaw = '';
        run.bufferText = '';

        if (activeRunIdRef.current === runId) activeRunIdRef.current = null;
        incrementGeneration();

        const partialMessagesRaw = extractFinalMessages(cp);
        if (partialMessagesRaw.length > 0) {
          const partialMessages = processChatMessages(partialMessagesRaw);
          if (partialMessages.length > 0) {
            const merged = mergeFinalMessages(getAllMessages(), partialMessages);
            applyMessageWindow(merged, false);
          }
        }

        if (isActiveRun) {
          setIsGenerating(false);
          setProcessingStage(null);
          setActivityLog([]);
          setLastEventTimestamp(0);
          clearStreamBuffer();
          playCompletionPing();
        }

        resetThinking();
        pruneRunRegistry(runsRef.current, activeRunIdRef.current);
        return;
      }

      if (type === 'chat_error') {
        const isActiveRun = activeRunBefore !== null
          ? activeRunBefore === runId
          : isGeneratingRef.current;

        run.finalized = true;
        run.status = undefined;
        run.stopReason = cp.stopReason || cp.errorMessage || cp.error || 'error';
        run.bufferRaw = '';
        run.bufferText = '';

        if (activeRunIdRef.current === runId) activeRunIdRef.current = null;
        incrementGeneration();

        if (isActiveRun) {
          setIsGenerating(false);
          setProcessingStage(null);
          setActivityLog([]);
          setLastEventTimestamp(0);
          clearStreamBuffer();
        }

        if (isActiveRun) {
          triggerRecovery('unrenderable-final');
        }

        resetThinking();
        pruneRunRegistry(runsRef.current, activeRunIdRef.current);
      }
    });
  }, [
    getAllMessages,
    applyMessageWindow,
    setProcessingStage,
    setLastEventTimestamp,
    setActivityLog,
    addActivityEntry,
    completeActivityEntry,
    startThinking,
    captureThinkingDuration,
    scheduleStreamingUpdate,
    clearStreamBuffer,
    getThinkingDuration,
    resetThinking,
    triggerRecovery,
    incrementGeneration,
    getGeneration,
    playCompletionPing,
    resetPlayedSounds,
    handleFinalTTS,
    subscribe,
    rpc,
  ]);

  // ─── Send message ─────────────────────────────────────────────────────────
  const handleSend = useCallback(async (text: string, images?: ImageAttachment[], uploadPayload?: OutgoingUploadPayload) => {
    ttsHook.trackVoiceMessage(text);
    const sessionKey = currentSessionRef.current;

    const { msg: userMsg, tempId } = buildUserMessage({ text, images, uploadPayload });

    incrementGeneration();

    // Optimistic insert (functional updater to avoid read-then-write race)
    msgHook.setAllMessages(prev => [...prev, userMsg]);
    msgHook.setMessages((prev: ChatMsg[]) => [...prev, userMsg]);
    setIsGenerating(true);
    setIsSendPending(true);
    streamHook.setStream((prev: ChatStreamState) => ({ ...prev, html: '', runId: undefined }));
    setProcessingStage('thinking');

    const idempotencyKey = crypto.randomUUID ? crypto.randomUUID() : 'ik-' + Date.now();
    try {
      const ack = await sendChatMessage({
        rpc,
        sessionKey,
        text,
        images,
        uploadPayload,
        idempotencyKey,
      });

      if (ack.runId) {
        realtimeDispatch(normalizeLocalRunCreated(sessionKey, ack.runId, Date.now()));
      }

      if (currentSessionRef.current !== sessionKey) {
        setIsSendPending(false);
        return;
      }

      if (ack.runId) {
        const run = getOrCreateRunState(runsRef.current, ack.runId, sessionKey);
        run.status = ack.status;
        run.finalized = false;
        activeRunIdRef.current = ack.runId;
        startThinking(ack.runId);
      }

      // Confirm the message (functional updater to avoid race after await)
      const confirmMsg = (m: ChatMsg) => m.tempId === tempId ? { ...m, pending: false } : m;
      msgHook.setAllMessages(prev => prev.map(confirmMsg));
      msgHook.setMessages((prev: ChatMsg[]) => prev.map(confirmMsg));
      setIsSendPending(false);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);

      if (currentSessionRef.current !== sessionKey) {
        setIsSendPending(false);
        return;
      }

      const failMsg = (m: ChatMsg) => m.tempId === tempId ? { ...m, pending: false, failed: true } : m;
      msgHook.setAllMessages(prev => prev.map(failMsg));
      msgHook.setMessages((prev: ChatMsg[]) => prev.map(failMsg));

      const errMsgBubble: ChatMsg = {
        msgId: generateMsgId(),
        role: 'system',
        html: 'Send error: ' + errMsg,
        rawText: '',
        timestamp: new Date(),
      };
      msgHook.setAllMessages(prev => [...prev, errMsgBubble]);
      msgHook.setMessages((prev: ChatMsg[]) => [...prev, errMsgBubble]);
      setIsGenerating(false);
      setIsSendPending(false);
    }
  }, [rpc, msgHook, streamHook, ttsHook, incrementGeneration, realtimeDispatch, setProcessingStage, startThinking]);

  // ─── Abort / Reset ────────────────────────────────────────────────────────
  const handleAbort = useCallback(async () => {
    try {
      await rpc('chat.abort', { sessionKey: currentSessionRef.current });
    } catch (err) {
      console.debug('[ChatContext] Abort request failed:', err);
    }
  }, [rpc]);

  const handleReset = useCallback(() => {
    setShowResetConfirm(true);
  }, []);

  const confirmReset = useCallback(async () => {
    setShowResetConfirm(false);
    try {
      await rpc('sessions.reset', { key: currentSessionRef.current });
      const msg: ChatMsg = {
        msgId: generateMsgId(),
        role: 'system',
        html: '⚙️ Session reset. Starting fresh.',
        rawText: '',
        timestamp: new Date(),
      };
      msgHook.setAllMessages([msg]);
      msgHook.applyMessageWindow([msg], true);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const msg: ChatMsg = {
        msgId: generateMsgId(),
        role: 'system',
        html: `⚙️ Reset failed: ${errMsg}`,
        rawText: '',
        timestamp: new Date(),
      };
      msgHook.setAllMessages(prev => [...prev, msg]);
      msgHook.setMessages((prev: ChatMsg[]) => [...prev, msg]);
    }
  }, [msgHook, rpc]);

  const cancelReset = useCallback(() => {
    setShowResetConfirm(false);
  }, []);

  // ─── Context value ────────────────────────────────────────────────────────
  const value = useMemo<ChatContextValue>(() => ({
    messages: msgHook.messages,
    isGenerating: visibleIsGenerating,
    stream: streamHook.stream,
    processingStage: streamHook.processingStage,
    lastEventTimestamp: lastEventTimestamp,
    activityLog: streamHook.activityLog,
    currentToolDescription: streamHook.currentToolDescription,
    handleSend,
    handleAbort,
    handleReset,
    loadHistory: loadHistory,
    loadMore: msgHook.loadMore,
    hasMore: msgHook.hasMore,
    showResetConfirm,
    confirmReset,
    cancelReset,
  }), [
    msgHook.messages,
    visibleIsGenerating,
    streamHook.stream,
    streamHook.processingStage,
    lastEventTimestamp,
    streamHook.activityLog,
    streamHook.currentToolDescription,
    handleSend,
    handleAbort,
    handleReset,
    loadHistory,
    msgHook.loadMore,
    msgHook.hasMore,
    showResetConfirm,
    confirmReset,
    cancelReset,
  ]);

  return (
    <ChatContext.Provider value={value}>
      {children}
    </ChatContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- hook export is intentional
export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used within ChatProvider');
  return ctx;
}
