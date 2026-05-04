import type { ChatMsg } from '@/features/chat/types';
import type { ChatMessage } from '@/types';

export type TimelineSource = 'history' | 'realtime' | 'optimistic' | 'system';

export type ChatTimelineItemKind =
  | 'user_message'
  | 'assistant_message'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'system_event';

export type ChatTimelineItemStatus =
  | 'pending'
  | 'streaming'
  | 'running'
  | 'completed'
  | 'final'
  | 'error'
  | 'aborted';

export interface ChatTimelineItem {
  id: string;
  sessionKey: string;
  kind: ChatTimelineItemKind;
  source: TimelineSource;
  status: ChatTimelineItemStatus;
  chatMsg: ChatMsg;
  order: number;
  timestamp: number;
  runId?: string;
  seq?: number;
  frameSeq?: number;
  toolCallId?: string;
}

export interface ChatRunTimelineState {
  runId: string;
  sessionKey: string;
  status: 'active' | 'final' | 'error' | 'aborted';
  startedAt: number;
  updatedAt: number;
  stopReason?: string;
}

export interface ChatTimelineState {
  sessionKey: string;
  items: ChatTimelineItem[];
  activeRuns: Record<string, ChatRunTimelineState>;
  nextOrder: number;
  lastGatewaySeq: number | null;
  lastSeqByRun: Record<string, number>;
}

export type ChatTimelineEvent =
  | {
      type: 'history_snapshot';
      sessionKey: string;
      source: Extract<TimelineSource, 'history' | 'realtime'>;
      messages: ChatMessage[];
      runId?: string;
      timestamp?: number;
    }
  | {
      type: 'optimistic_message';
      sessionKey: string;
      source: Extract<TimelineSource, 'optimistic'>;
      chatMsg: ChatMsg;
      runId?: string;
      timestamp?: number;
    }
  | {
      type: 'run_started';
      sessionKey: string;
      runId: string;
      source: TimelineSource;
      seq?: number;
      frameSeq?: number;
      timestamp?: number;
    }
  | {
      type: 'assistant_delta';
      sessionKey: string;
      runId: string;
      source: TimelineSource;
      text: string;
      seq?: number;
      frameSeq?: number;
      timestamp?: number;
    }
  | {
      type: 'assistant_final';
      sessionKey: string;
      runId: string;
      source: TimelineSource;
      messages: ChatMessage[];
      seq?: number;
      frameSeq?: number;
      stopReason?: string;
      timestamp?: number;
    }
  | {
      type: 'tool_started';
      sessionKey: string;
      runId: string;
      source: TimelineSource;
      toolCallId: string;
      name: string;
      args: Record<string, unknown>;
      description?: string;
      seq?: number;
      frameSeq?: number;
      timestamp?: number;
    }
  | {
      type: 'tool_result';
      sessionKey: string;
      runId: string;
      source: TimelineSource;
      toolCallId: string;
      resultText?: string;
      seq?: number;
      frameSeq?: number;
      timestamp?: number;
    }
  | {
      type: 'run_error';
      sessionKey: string;
      runId: string;
      source: TimelineSource;
      error: string;
      seq?: number;
      frameSeq?: number;
      timestamp?: number;
    }
  | {
      type: 'run_aborted';
      sessionKey: string;
      runId: string;
      source: TimelineSource;
      stopReason?: string;
      seq?: number;
      frameSeq?: number;
      timestamp?: number;
    };
