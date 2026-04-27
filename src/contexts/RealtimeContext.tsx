/* eslint-disable react-refresh/only-export-components -- hooks and helpers intentionally co-located with provider */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import { useGateway } from './GatewayContext';
import { normalizeGatewayEvent, normalizeSnapshotLoaded } from '@/features/realtime/normalizedEvent';
import { createInitialRealtimeState, realtimeReducer } from '@/features/realtime/reducer';
import { selectRealtimeStatus } from '@/features/realtime/selectors';
import type { ReconcileReason, RealtimeEvent, RealtimeSnapshotPayload, RealtimeState } from '@/features/realtime/types';

interface SnapshotResponse {
  ok: boolean;
  snapshot?: RealtimeSnapshotPayload;
  error?: string;
}

interface RealtimeContextValue {
  state: RealtimeState;
  realtimeStatus: ReturnType<typeof selectRealtimeStatus>;
  dispatch: React.Dispatch<RealtimeEvent>;
  requestSnapshot: (sessionId: string, reason: ReconcileReason) => Promise<void>;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

function buildLocalEventId(prefix: string, sessionId: string, receivedAt: number) {
  return `${prefix}:${sessionId}:${receivedAt}`;
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { connectionState, reconnectAttempt, transportMeta, subscribe } = useGateway();
  const [state, dispatch] = useReducer(realtimeReducer, undefined, createInitialRealtimeState);

  useEffect(() => {
    const receivedAt = Date.now();

    if (connectionState === 'connected') {
      dispatch({
        type: 'connection.opened',
        eventId: buildLocalEventId('connection-opened', 'global', receivedAt),
        receivedAt,
        source: 'local',
        sessionId: 'global',
        reconnectAttempt,
      });
      return;
    }

    if (connectionState === 'reconnecting') {
      dispatch({
        type: 'connection.closed',
        eventId: buildLocalEventId('connection-closed', 'global', receivedAt),
        receivedAt,
        source: 'local',
        sessionId: 'global',
        reason: transportMeta.lastCloseReason || 'reconnecting',
        reconnectAttempt,
      });
      return;
    }

    if (connectionState === 'disconnected') {
      dispatch({
        type: 'connection.offline',
        eventId: buildLocalEventId('connection-offline', 'global', receivedAt),
        receivedAt,
        source: 'local',
        sessionId: 'global',
        reason: transportMeta.lastCloseReason,
      });
    }

  }, [
    connectionState,
    reconnectAttempt,
    transportMeta.lastCloseReason,
  ]);

  useEffect(() => {
    return subscribe((gatewayEvent) => {
      for (const realtimeEvent of normalizeGatewayEvent(gatewayEvent)) {
        dispatch(realtimeEvent);
      }
    });
  }, [subscribe]);

  const requestSnapshot = useCallback(async (sessionId: string, reason: ReconcileReason) => {
    const requestedAt = Date.now();
    dispatch({
      type: 'connection.reconcile_requested',
      eventId: buildLocalEventId('reconcile', sessionId, requestedAt),
      receivedAt: requestedAt,
      source: 'local',
      sessionId,
      reason,
    });

    try {
      const response = await fetch(`/api/realtime/snapshot?sessionKey=${encodeURIComponent(sessionId)}`);
      if (!response.ok) {
        throw new Error(`snapshot-request-failed:${response.status}`);
      }

      const payload = await response.json() as SnapshotResponse;
      if (!payload.ok || !payload.snapshot) {
        throw new Error(payload.error || 'snapshot-request-failed');
      }

      dispatch(normalizeSnapshotLoaded(payload.snapshot));
      dispatch({
        type: 'snapshot.merge_completed',
        eventId: buildLocalEventId('snapshot-merged', sessionId, Date.now()),
        receivedAt: Date.now(),
        source: 'local',
        sessionId,
      });
    } catch (error) {
      dispatch({
        type: 'connection.degraded',
        eventId: buildLocalEventId('reconcile-failed', sessionId, Date.now()),
        receivedAt: Date.now(),
        source: 'local',
        sessionId,
        reason: error instanceof Error ? error.message : 'snapshot-request-failed',
      });
      throw error;
    }
  }, []);

  const value = useMemo<RealtimeContextValue>(() => ({
    state,
    realtimeStatus: selectRealtimeStatus(state),
    dispatch,
    requestSnapshot,
  }), [state, requestSnapshot]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime() {
  const context = useContext(RealtimeContext);
  if (!context) throw new Error('useRealtime must be used within RealtimeProvider');
  return context;
}
