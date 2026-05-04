import { describe, expect, it } from 'vitest';
import type { GatewayEvent } from '@/types';
import {
  createChatTimelineState,
  reduceTimelineEvent,
  selectTimelineMessages,
} from './reducer';
import { normalizeGatewayEvent } from './normalizeGatewayEvent';
import { projectTranscriptMessages } from './projectTranscript';

const sessionKey = 'agent:test:main';

describe('chat timeline reducer', () => {
  it('updates one streaming assistant item and replaces it with the final message', () => {
    let state = createChatTimelineState(sessionKey);

    const deltaOne: GatewayEvent = {
      type: 'event',
      event: 'chat',
      seq: 1,
      payload: {
        sessionKey,
        runId: 'run-1',
        seq: 1,
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hel' }], timestamp: 1 },
      },
    };
    const deltaTwo: GatewayEvent = {
      type: 'event',
      event: 'chat',
      seq: 2,
      payload: {
        sessionKey,
        runId: 'run-1',
        seq: 2,
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }], timestamp: 2 },
      },
    };
    const finalFrame: GatewayEvent = {
      type: 'event',
      event: 'chat',
      seq: 3,
      payload: {
        sessionKey,
        runId: 'run-1',
        seq: 3,
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello final' }], timestamp: 3 },
      },
    };

    for (const event of [...normalizeGatewayEvent(deltaOne), ...normalizeGatewayEvent(deltaTwo), ...normalizeGatewayEvent(finalFrame)]) {
      state = reduceTimelineEvent(state, event);
    }

    const messages = selectTimelineMessages(state);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      rawText: 'Hello final',
      streaming: false,
    });
  });

  it('keeps tool bubbles as timeline items and marks them complete', () => {
    let state = createChatTimelineState(sessionKey);

    const toolStart: GatewayEvent = {
      type: 'event',
      event: 'agent',
      seq: 1,
      payload: {
        sessionKey,
        runId: 'run-tool',
        seq: 1,
        stream: 'tool',
        data: { phase: 'start', toolCallId: 'tool-1', name: 'exec', args: { cmd: 'pwd' } },
      },
    };
    const toolResult: GatewayEvent = {
      type: 'event',
      event: 'agent',
      seq: 2,
      payload: {
        sessionKey,
        runId: 'run-tool',
        seq: 2,
        stream: 'tool',
        data: { phase: 'result', toolCallId: 'tool-1' },
      },
    };

    for (const event of [...normalizeGatewayEvent(toolStart), ...normalizeGatewayEvent(toolResult)]) {
      state = reduceTimelineEvent(state, event);
    }

    const [tool] = selectTimelineMessages(state);
    expect(tool.role).toBe('tool');
    expect(tool.rawText).toContain('exec');
    expect(tool.rawText).toContain('pwd');
    expect(state.items[0].status).toBe('completed');
  });

  it('groups consecutive live tool calls from the same run into one bubble', () => {
    let state = createChatTimelineState(sessionKey);

    const firstTool: GatewayEvent = {
      type: 'event',
      event: 'agent',
      seq: 1,
      payload: {
        sessionKey,
        runId: 'run-tools',
        seq: 1,
        stream: 'item',
        data: {
          phase: 'start',
          kind: 'tool',
          toolCallId: 'tool-1',
          name: 'exec',
          title: 'exec true',
        },
      },
    };
    const secondTool: GatewayEvent = {
      type: 'event',
      event: 'agent',
      seq: 2,
      payload: {
        sessionKey,
        runId: 'run-tools',
        seq: 2,
        stream: 'item',
        data: {
          phase: 'start',
          kind: 'tool',
          toolCallId: 'tool-2',
          name: 'cron',
          title: 'cron status',
        },
      },
    };

    for (const event of [...normalizeGatewayEvent(firstTool), ...normalizeGatewayEvent(secondTool)]) {
      state = reduceTimelineEvent(state, event);
    }

    const messages = selectTimelineMessages(state);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('tool');
    expect(messages[0].html).toBe('Used 2 tools');
    expect(messages[0].toolGroup?.map((entry) => entry.preview)).toEqual([
      'exec true',
      'cron status',
    ]);
  });

  it('merges a short recovered history tail without deleting older messages', () => {
    let state = createChatTimelineState(sessionKey);
    state = reduceTimelineEvent(state, {
      type: 'history_snapshot',
      sessionKey,
      source: 'history',
      messages: [
        { role: 'assistant', content: 'older answer', timestamp: 1 },
        { role: 'assistant', content: 'newer answer', timestamp: 2 },
      ],
    });

    state = reduceTimelineEvent(state, {
      type: 'history_snapshot',
      sessionKey,
      source: 'history',
      messages: [
        { role: 'assistant', content: 'newer answer', timestamp: 2 },
      ],
    });

    expect(selectTimelineMessages(state).map((m) => m.rawText)).toEqual([
      'older answer',
      'newer answer',
    ]);
  });

  it('keeps repeated transcript messages with the same text and timestamp distinct', () => {
    const messages = [
      { role: 'assistant' as const, content: 'same answer', timestamp: 1_000 },
      { role: 'assistant' as const, content: 'same answer', timestamp: 1_000 },
    ];
    const projected = projectTranscriptMessages({
      sessionKey,
      source: 'history',
      messages,
    });

    expect(new Set(projected.map((item) => item.id)).size).toBe(2);

    let state = createChatTimelineState(sessionKey);
    state = reduceTimelineEvent(state, {
      type: 'history_snapshot',
      sessionKey,
      source: 'history',
      messages,
    });

    expect(selectTimelineMessages(state).map((m) => m.rawText)).toEqual([
      'same answer',
      'same answer',
    ]);
  });

  it('deduplicates recovered history tool bubbles when a shorter tail shifts transcript indexes', () => {
    const toolMessage = {
      role: 'assistant' as const,
      timestamp: 2_000,
      content: [
        { type: 'toolCall' as const, name: 'exec', arguments: { command: 'pwd' } },
      ],
    };
    let state = createChatTimelineState(sessionKey);
    state = reduceTimelineEvent(state, {
      type: 'history_snapshot',
      sessionKey,
      source: 'history',
      messages: [
        { role: 'user', content: 'prompt', timestamp: 1_000 },
        toolMessage,
      ],
    });

    state = reduceTimelineEvent(state, {
      type: 'history_snapshot',
      sessionKey,
      source: 'history',
      messages: [toolMessage],
    });

    expect(selectTimelineMessages(state).map((m) => m.role)).toEqual(['user', 'tool']);
  });

  it('orders replayed assistant finals between their surrounding history messages', () => {
    let state = createChatTimelineState(sessionKey);
    state = reduceTimelineEvent(state, {
      type: 'history_snapshot',
      sessionKey,
      source: 'history',
      messages: [
        { role: 'user', content: 'first prompt', timestamp: 1_000 },
        { role: 'user', content: 'second prompt', timestamp: 3_000 },
      ],
    });

    state = reduceTimelineEvent(state, {
      type: 'assistant_final',
      sessionKey,
      runId: 'run-1',
      source: 'realtime',
      timestamp: 2_000,
      messages: [
        { role: 'assistant', content: 'first answer', timestamp: 2_000 },
      ],
    });
    state = reduceTimelineEvent(state, {
      type: 'assistant_final',
      sessionKey,
      runId: 'run-2',
      source: 'realtime',
      timestamp: 4_000,
      messages: [
        { role: 'assistant', content: 'second answer', timestamp: 4_000 },
      ],
    });

    expect(selectTimelineMessages(state).map((m) => m.rawText)).toEqual([
      'first prompt',
      'first answer',
      'second prompt',
      'second answer',
    ]);
  });

  it('does not stack replayed final assistant messages already present in history', () => {
    let state = createChatTimelineState(sessionKey);
    state = reduceTimelineEvent(state, {
      type: 'history_snapshot',
      sessionKey,
      source: 'history',
      messages: [
        { role: 'user', content: 'prompt', timestamp: 1_000 },
        { role: 'assistant', content: 'same answer', timestamp: 2_000 },
      ],
    });

    state = reduceTimelineEvent(state, {
      type: 'assistant_final',
      sessionKey,
      runId: 'run-1',
      source: 'realtime',
      timestamp: 2_000,
      messages: [
        { role: 'assistant', content: 'same answer', timestamp: 2_000 },
      ],
    });

    expect(selectTimelineMessages(state).map((m) => m.rawText)).toEqual([
      'prompt',
      'same answer',
    ]);
  });

  it('does not stack replayed final assistant messages when gateway history timestamps differ slightly', () => {
    let state = createChatTimelineState(sessionKey);
    state = reduceTimelineEvent(state, {
      type: 'history_snapshot',
      sessionKey,
      source: 'history',
      messages: [
        { role: 'user', content: 'prompt', timestamp: 1_000 },
        { role: 'assistant', content: 'same answer', timestamp: 2_000 },
      ],
    });

    state = reduceTimelineEvent(state, {
      type: 'assistant_final',
      sessionKey,
      runId: 'run-1',
      source: 'realtime',
      timestamp: 4_500,
      messages: [
        { role: 'assistant', content: 'same answer', timestamp: 4_500 },
      ],
    });

    expect(selectTimelineMessages(state).map((m) => m.rawText)).toEqual([
      'prompt',
      'same answer',
    ]);
  });

  it('keeps repeated final assistant replies when a later user prompt separates them', () => {
    let state = createChatTimelineState(sessionKey);
    state = reduceTimelineEvent(state, {
      type: 'history_snapshot',
      sessionKey,
      source: 'history',
      messages: [
        { role: 'user', content: 'first prompt', timestamp: 1_000 },
        { role: 'assistant', content: 'same answer', timestamp: 2_000 },
        { role: 'user', content: 'repeat prompt', timestamp: 3_000 },
      ],
    });

    state = reduceTimelineEvent(state, {
      type: 'assistant_final',
      sessionKey,
      runId: 'run-2',
      source: 'realtime',
      timestamp: 3_500,
      messages: [
        { role: 'assistant', content: 'same answer', timestamp: 3_500 },
      ],
    });

    expect(selectTimelineMessages(state).map((m) => m.rawText)).toEqual([
      'first prompt',
      'same answer',
      'repeat prompt',
      'same answer',
    ]);
  });

  it('does not add replayed live tool items when history already has the tool group', () => {
    let state = createChatTimelineState(sessionKey);
    state = reduceTimelineEvent(state, {
      type: 'history_snapshot',
      sessionKey,
      source: 'history',
      messages: [
        {
          role: 'assistant',
          timestamp: 2_000,
          content: [
            { type: 'toolCall', name: 'exec', arguments: { command: 'true' } },
            { type: 'toolCall', name: 'cron', arguments: { action: 'status' } },
          ],
        },
      ],
    });

    state = reduceTimelineEvent(state, {
      type: 'tool_started',
      sessionKey,
      runId: 'run-1',
      source: 'realtime',
      toolCallId: 'tool-1',
      name: 'exec',
      args: {},
      description: 'exec true (in ~/.openclaw/workspace)',
      timestamp: 2_500,
    });

    const messages = selectTimelineMessages(state);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('tool');
    expect(messages[0].toolGroup).toHaveLength(2);
  });

  it('keeps repeated live tool calls when a later user prompt separates them from history', () => {
    let state = createChatTimelineState(sessionKey);
    state = reduceTimelineEvent(state, {
      type: 'history_snapshot',
      sessionKey,
      source: 'history',
      messages: [
        { role: 'user', content: 'first prompt', timestamp: 1_000 },
        {
          role: 'assistant',
          timestamp: 2_000,
          content: [
            { type: 'toolCall', name: 'exec', arguments: { command: 'true' } },
            { type: 'toolCall', name: 'cron', arguments: { action: 'status' } },
          ],
        },
        { role: 'user', content: 'repeat prompt', timestamp: 3_000 },
      ],
    });

    state = reduceTimelineEvent(state, {
      type: 'tool_started',
      sessionKey,
      runId: 'run-2',
      source: 'realtime',
      toolCallId: 'tool-2',
      name: 'exec',
      args: { cmd: 'true' },
      description: 'exec true',
      timestamp: 3_500,
    });

    const messages = selectTimelineMessages(state);
    expect(messages.map((m) => m.role)).toEqual(['user', 'tool', 'user', 'tool']);
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(2);
    expect(messages[3].rawText).toContain('exec');
    expect(messages[3].rawText).toContain('true');
  });

  it('projects thinking blocks from transcript history', () => {
    const items = projectTranscriptMessages({
      sessionKey,
      source: 'history',
      messages: [
        {
          role: 'assistant',
          timestamp: 1,
          content: [
            { type: 'thinking', thinking: 'I should inspect state.' },
            { type: 'text', text: 'Done.' },
          ],
        },
      ],
    });

    expect(items.map((item) => item.kind)).toEqual(['thinking', 'assistant_message']);
    expect(items[0].chatMsg.isThinking).toBe(true);
  });

  it('ignores events for another session in a session-scoped reducer', () => {
    let state = createChatTimelineState(sessionKey);
    state = reduceTimelineEvent(state, {
      type: 'assistant_delta',
      sessionKey: 'agent:other:main',
      runId: 'run-other',
      source: 'realtime',
      text: 'wrong session',
      timestamp: 1,
    });

    expect(selectTimelineMessages(state)).toEqual([]);
  });
});
