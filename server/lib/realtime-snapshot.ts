import { gatewayRpcCall } from './gateway-rpc.js';

const SESSIONS_ACTIVE_MINUTES = 24 * 60;
const SESSIONS_LIMIT = 200;

const ACTIVE_RUN_STATUSES = new Set([
  'running',
  'thinking',
  'processing',
  'streaming',
  'started',
  'busy',
  'working',
  'tool_use',
  'executing',
  'delta',
]);
const QUEUED_RUN_STATUSES = new Set(['queued', 'pending']);
const FAILED_RUN_STATUSES = new Set(['error', 'failed']);
const INTERRUPTED_RUN_STATUSES = new Set(['aborted', 'interrupted', 'stopped', 'cancelled']);
const COMPLETED_RUN_SESSION_STATUSES = new Set(['done', 'idle', 'completed']);
const INTERNAL_CONTROL_REPLY_RE = /^(?:NO_REPLY|HEARTBEAT_OK)$/;
const SYSTEM_EVENT_LINE = /^System(?: \(untrusted\))?: \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})? [^\]]*\]/;
const SYSTEM_EVENT_FOLLOWUP_LINE = /^(?:An async command you ran earlier has completed\.|A scheduled reminder has been triggered\.|A scheduled cron event was triggered(?:, but no event content was found)?\.|Handle this reminder internally\.|Handle this internally\.|Handle the result internally\.?|Do not relay it to the user unless explicitly requested\.|Please relay the command output to the user in a helpful way\.|Please relay this reminder to the user in a helpful and friendly way\.|Current time:)/i;
const CHART_PREFIX = '[chart:';
const TTS_SYSTEM_HINT_RE = /\s*\[system: User sent a voice message\.[\s\S]*$/;
const WEBCHAT_ENVELOPE_RE = /Conversation info \(untrusted metadata\):[\s\S]*?"sender":\s*"[^"]*"\s*\}\s*\n?(?:```\s*\n?)?(?:\n?\[[\w, ]+ \d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})? [^\]]*\]\s*)?/g;
const UPLOAD_MANIFEST_RE = /\s*<nerve-upload-manifest>([\s\S]*?)<\/nerve-upload-manifest>\s*$/;
const ACTIVE_SNAPSHOT_ASSISTANT_REVISION = -1;

interface BuildRealtimeSnapshotArgs {
  sessionKey: string;
  limit: number;
}

interface ChartData {
  type: 'bar' | 'line' | 'pie' | 'area' | 'candle' | 'tv';
  title?: string;
  symbol?: string;
  interval?: string;
  data: {
    labels: string[];
    values?: number[];
    series?: {
      name: string;
      values: number[];
    }[];
    candles?: Array<{ open: number; high: number; low: number; close: number }>;
  };
}

interface RealtimeMessagePart {
  type: 'text';
  text: string;
}

interface UploadAttachmentPolicy {
  forwardToSubagents: boolean;
}

interface UploadAttachmentDescriptor {
  id: string;
  origin: 'upload' | 'server_path';
  mode: 'inline' | 'file_reference';
  name: string;
  mimeType: string;
  sizeBytes: number;
  inline?: Record<string, unknown>;
  reference?: Record<string, unknown>;
  preparation?: Record<string, unknown>;
  policy: UploadAttachmentPolicy;
}

interface RealtimeSessionEntity {
  sessionId: string;
  status: string;
  agentId: string | null;
  updatedAt: number;
  sourceVersion: string;
}

interface RealtimeRunEntity {
  runId: string;
  sessionId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  messageIds: string[];
  lastEventAt: number;
  finalized: boolean;
}

interface RealtimeMessageEntity {
  messageId: string;
  sessionId: string;
  runId: string | null;
  role: 'user' | 'assistant' | 'system';
  contentParts: RealtimeMessagePart[];
  charts?: ChartData[];
  uploadAttachments?: UploadAttachmentDescriptor[];
  status: 'streaming' | 'committed' | 'superseded';
  revision: number;
  createdAt: number;
}

interface RealtimeAgentPresence {
  sessionId: string;
  agentId: string | null;
  phase: string | null;
  lastSeenAt: number;
}

interface RealtimeSnapshotPayload {
  session: RealtimeSessionEntity;
  runs: RealtimeRunEntity[];
  messages: RealtimeMessageEntity[];
  agentPresence: RealtimeAgentPresence | null;
  recoveredAt: number;
  source: 'server-reconcile';
}

interface GatewaySessionSummary {
  key?: string;
  sessionKey?: string;
  id?: string;
  status?: string;
  state?: string;
  agentState?: string;
  busy?: boolean;
  processing?: boolean;
  updatedAt?: number | string;
  lastActivity?: number | string;
  runId?: string;
  currentRunId?: string;
  latestRunId?: string;
  abortedLastRun?: boolean;
}

interface GatewayMessageContentBlock {
  type?: string;
  text?: string;
}

interface GatewayHistoryMessage {
  role?: string;
  content?: string | GatewayMessageContentBlock[];
  text?: string;
  timestamp?: number | string;
  createdAt?: number | string;
  ts?: number | string;
  runId?: string;
  currentRunId?: string;
  latestRunId?: string;
  messageId?: string;
  id?: string;
  meta?: { runId?: string };
  metadata?: { runId?: string };
}

interface GatewaySessionsListResponse {
  sessions?: GatewaySessionSummary[];
}

interface GatewayChatHistoryResponse {
  messages?: GatewayHistoryMessage[];
}

interface NormalizedHistoryMessage extends RealtimeMessageEntity {
  _sortIndex: number;
}

interface RunAccumulator {
  runId: string;
  messageIds: string[];
  lastEventAt: number;
}

function trimToNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim().length === 0) return null;

  const numericValue = Number(value);
  if (Number.isFinite(numericValue)) return numericValue;

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function getSessionKey(session: GatewaySessionSummary): string | null {
  return trimToNull(session.sessionKey)
    ?? trimToNull(session.key)
    ?? trimToNull(session.id);
}

function getAgentIdFromSessionKey(sessionKey: string): string | null {
  const match = sessionKey.match(/^agent:([^:]+):/);
  return match?.[1] || null;
}

function resolveSessionStatus(session: GatewaySessionSummary | null): string {
  const normalized = trimToNull(session?.status)?.toLowerCase()
    ?? trimToNull(session?.state)?.toLowerCase()
    ?? trimToNull(session?.agentState)?.toLowerCase();
  if (normalized) return normalized;
  if (session?.busy || session?.processing) return 'running';
  if (session?.abortedLastRun) return 'interrupted';
  return 'unknown';
}

function resolvePresencePhase(session: GatewaySessionSummary | null): string | null {
  const explicit = trimToNull(session?.agentState)?.toLowerCase()
    ?? trimToNull(session?.state)?.toLowerCase()
    ?? trimToNull(session?.status)?.toLowerCase();
  if (explicit) return explicit;
  if (session?.busy || session?.processing) return 'running';
  if (session?.abortedLastRun) return 'interrupted';
  return null;
}

function getSessionUpdatedAt(session: GatewaySessionSummary | null): number {
  return parseTimestamp(session?.updatedAt)
    ?? parseTimestamp(session?.lastActivity)
    ?? 0;
}

function getMessageCreatedAt(message: GatewayHistoryMessage): number | null {
  return parseTimestamp(message.createdAt)
    ?? parseTimestamp(message.timestamp)
    ?? parseTimestamp(message.ts);
}

function getMessageRunId(message: GatewayHistoryMessage): string | null {
  return trimToNull(message.runId)
    ?? trimToNull(message.currentRunId)
    ?? trimToNull(message.latestRunId)
    ?? trimToNull(message.meta?.runId)
    ?? trimToNull(message.metadata?.runId);
}

function extractMessageText(message: GatewayHistoryMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (part?.type === 'text' && typeof part.text === 'string') ? part.text : null)
      .filter((part): part is string => Boolean(part))
      .join('\n');
  }
  return typeof message.text === 'string' ? message.text : '';
}

function extractTtsMarkers(text: string): { cleaned: string; ttsText: string | null } {
  let ttsText: string | null = null;
  const cleaned = text.replace(/\[tts:([^\]]+)\]/g, (_match, value: string) => {
    if (ttsText === null) ttsText = value;
    return '';
  });
  return { cleaned: cleaned.trim(), ttsText };
}

function extractUploadAttachments(rawText: string): {
  cleanedText: string;
  uploadAttachments?: UploadAttachmentDescriptor[];
} {
  const match = rawText.match(UPLOAD_MANIFEST_RE);
  if (!match) return { cleanedText: rawText };

  const cleanedText = rawText.replace(UPLOAD_MANIFEST_RE, '').trimEnd();

  try {
    const parsed = JSON.parse(match[1]) as { attachments?: UploadAttachmentDescriptor[] };
    if (!Array.isArray(parsed.attachments) || parsed.attachments.length === 0) {
      return { cleanedText };
    }
    return {
      cleanedText,
      uploadAttachments: parsed.attachments,
    };
  } catch {
    return { cleanedText: rawText };
  }
}

function normalizeUserHistoryText(rawText: string): {
  cleanedText: string;
  uploadAttachments?: UploadAttachmentDescriptor[];
} {
  const withoutTtsHint = rawText.replace(TTS_SYSTEM_HINT_RE, '');
  const withoutEnvelope = withoutTtsHint.replace(WEBCHAT_ENVELOPE_RE, '');
  const withoutVoicePrefix = withoutEnvelope.replace(/^\[voice\]\s*/, '');
  return extractUploadAttachments(withoutVoicePrefix);
}

function buildAssistantHistoryFallbackMessageId(
  sessionKey: string,
  runId: string,
  createdAt: number,
  index: number,
): string {
  return `${sessionKey}:${runId}:assistant:${createdAt}:${index}`;
}

function assignAssistantFallbackIds(messages: NormalizedHistoryMessage[]): void {
  const assistantMessagesByRun = new Map<string, NormalizedHistoryMessage[]>();

  for (const message of messages) {
    if (message.role !== 'assistant' || !message.runId) continue;
    const group = assistantMessagesByRun.get(message.runId) ?? [];
    group.push(message);
    assistantMessagesByRun.set(message.runId, group);
  }

  for (const [runId, group] of assistantMessagesByRun) {
    group.sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
      return left._sortIndex - right._sortIndex;
    });

    const latest = group[group.length - 1];
    if (!latest) continue;
    const liveCompatibleMessageId = `${runId}:assistant`;
    const assignedIds = new Set<string>([liveCompatibleMessageId]);

    latest.messageId = liveCompatibleMessageId;

    for (const message of group) {
      if (message === latest) continue;

      if (assignedIds.has(message.messageId)) {
        message.messageId = buildAssistantHistoryFallbackMessageId(
          message.sessionId,
          runId,
          message.createdAt,
          message._sortIndex,
        );
      }

      assignedIds.add(message.messageId);
    }
  }
}

function isValidChartData(value: unknown): value is ChartData {
  if (!value || typeof value !== 'object') return false;
  const chart = value as Record<string, unknown>;
  if (!['bar', 'line', 'pie', 'area', 'candle', 'tv'].includes(String(chart.type))) return false;

  if (chart.type === 'tv') {
    return typeof chart.symbol === 'string' && chart.symbol.length > 0;
  }

  if (!chart.data || typeof chart.data !== 'object') return false;
  const data = chart.data as Record<string, unknown>;
  if (!Array.isArray(data.labels)) return false;
  if (data.values !== undefined && !Array.isArray(data.values)) return false;
  if (data.series !== undefined && !Array.isArray(data.series)) return false;
  if (data.candles !== undefined && !Array.isArray(data.candles)) return false;
  if (!data.values && !data.series && !data.candles) return false;
  return true;
}

function extractChartMarkers(text: string): { cleaned: string; charts: ChartData[] } {
  const charts: ChartData[] = [];
  let cleaned = '';
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf(CHART_PREFIX, cursor);
    if (start === -1) {
      cleaned += text.slice(cursor);
      break;
    }

    cleaned += text.slice(cursor, start);

    const jsonStart = start + CHART_PREFIX.length;
    if (text[jsonStart] !== '{') {
      cleaned += CHART_PREFIX;
      cursor = jsonStart;
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let jsonEnd = -1;

    for (let index = jsonStart; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === '{' || char === '[') depth += 1;
      if (char === '}' || char === ']') depth -= 1;
      if (depth === 0 && char === '}' && text[index + 1] === ']') {
        jsonEnd = index + 1;
        break;
      }
    }

    if (jsonEnd === -1) {
      cleaned += CHART_PREFIX;
      cursor = jsonStart;
      continue;
    }

    const jsonText = text.slice(jsonStart, jsonEnd);
    cursor = jsonEnd + 1;

    try {
      const parsed = JSON.parse(jsonText);
      if (isValidChartData(parsed)) charts.push(parsed);
    } catch {
      // Ignore malformed chart markers; the cleaned text already omits them.
    }
  }

  return { cleaned: cleaned.trim(), charts };
}

function isInternalWakeBundle(text: string): boolean {
  let sawSystemEvent = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (SYSTEM_EVENT_LINE.test(line)) {
      sawSystemEvent = true;
      continue;
    }
    if (sawSystemEvent) {
      if (SYSTEM_EVENT_FOLLOWUP_LINE.test(line)) continue;
      return false;
    }
    return false;
  }

  return sawSystemEvent;
}

function normalizeHistoryMessage(
  message: GatewayHistoryMessage,
  sessionKey: string,
  recoveredAt: number,
  index: number,
): NormalizedHistoryMessage | null {
  const role = trimToNull(message.role)?.toLowerCase();
  if (role !== 'user' && role !== 'assistant' && role !== 'system') return null;

  const normalizedUserPayload = role === 'user'
    ? normalizeUserHistoryText(extractMessageText(message))
    : null;
  const rawText = normalizedUserPayload?.cleanedText ?? extractMessageText(message);
  const uploadAttachments = normalizedUserPayload?.uploadAttachments;
  const { cleaned: ttsStripped } = extractTtsMarkers(rawText);
  const { cleaned, charts } = extractChartMarkers(ttsStripped);
  const trimmed = cleaned.trim();

  if (role === 'assistant' && INTERNAL_CONTROL_REPLY_RE.test(trimmed)) return null;
  if (role === 'user' && isInternalWakeBundle(trimmed)) return null;
  if (!trimmed && charts.length === 0 && (!uploadAttachments || uploadAttachments.length === 0)) return null;

  const createdAt = getMessageCreatedAt(message) ?? recoveredAt + index;
  const runId = getMessageRunId(message);
  const explicitMessageId = trimToNull(message.messageId)
    ?? trimToNull(message.id);
  const fallbackMessageId = role === 'assistant' && runId
    ? buildAssistantHistoryFallbackMessageId(sessionKey, runId, createdAt, index)
    : `${sessionKey}:${runId ?? 'norun'}:${role}:${createdAt}:${index}`;
  const messageId = explicitMessageId ?? fallbackMessageId;

  return {
    messageId,
    sessionId: sessionKey,
    runId,
    role,
    contentParts: trimmed ? [{ type: 'text', text: trimmed }] : [],
    ...(charts.length > 0 ? { charts } : {}),
    ...(uploadAttachments && uploadAttachments.length > 0 ? { uploadAttachments } : {}),
    status: 'committed',
    revision: createdAt,
    createdAt,
    _sortIndex: index,
  };
}

function isOpenRunSession(session: GatewaySessionSummary | null): boolean {
  const sessionStatus = resolveSessionStatus(session);
  return Boolean(session?.busy || session?.processing || ACTIVE_RUN_STATUSES.has(sessionStatus));
}

function isQueuedRunSession(session: GatewaySessionSummary | null): boolean {
  return QUEUED_RUN_STATUSES.has(resolveSessionStatus(session));
}

function getActiveRunId(session: GatewaySessionSummary | null): string | null {
  const currentRunId = trimToNull(session?.currentRunId);
  if (currentRunId) return currentRunId;

  const directRunId = trimToNull(session?.runId);
  if (directRunId) return directRunId;

  if (isOpenRunSession(session) || isQueuedRunSession(session)) {
    return trimToNull(session?.latestRunId);
  }

  return null;
}

function getLastKnownRunId(session: GatewaySessionSummary | null): string | null {
  return trimToNull(session?.latestRunId)
    ?? trimToNull(session?.runId)
    ?? trimToNull(session?.currentRunId);
}

function isTerminalPlaceholderSession(session: GatewaySessionSummary | null): boolean {
  const sessionStatus = resolveSessionStatus(session);
  if (session?.abortedLastRun || INTERRUPTED_RUN_STATUSES.has(sessionStatus)) return true;
  if (FAILED_RUN_STATUSES.has(sessionStatus)) return true;
  return COMPLETED_RUN_SESSION_STATUSES.has(sessionStatus);
}

function resolveRunState(
  session: GatewaySessionSummary | null,
  runId: string,
  hasMessages: boolean,
  activeRunId: string | null,
  terminalPlaceholderRunId: string | null,
): Pick<RealtimeRunEntity, 'status' | 'finalized'> {
  const sessionStatus = resolveSessionStatus(session);
  const isActiveRun = runId === activeRunId;
  const isTerminalPlaceholder = runId === terminalPlaceholderRunId;

  if (isActiveRun) {
    if (isOpenRunSession(session)) {
      return { status: 'running', finalized: false };
    }
    if (isQueuedRunSession(session)) {
      return { status: 'queued', finalized: false };
    }
    if (session?.abortedLastRun || INTERRUPTED_RUN_STATUSES.has(sessionStatus)) {
      return { status: 'interrupted', finalized: true };
    }
    if (FAILED_RUN_STATUSES.has(sessionStatus)) {
      return { status: 'failed', finalized: true };
    }
    if (!hasMessages && COMPLETED_RUN_SESSION_STATUSES.has(sessionStatus)) {
      return { status: 'completed', finalized: true };
    }
    if (!hasMessages) {
      return { status: 'unknown', finalized: false };
    }
  }

  if (!hasMessages && isTerminalPlaceholder) {
    if (session?.abortedLastRun || INTERRUPTED_RUN_STATUSES.has(sessionStatus)) {
      return { status: 'interrupted', finalized: true };
    }
    if (FAILED_RUN_STATUSES.has(sessionStatus)) {
      return { status: 'failed', finalized: true };
    }
    if (COMPLETED_RUN_SESSION_STATUSES.has(sessionStatus)) {
      return { status: 'completed', finalized: true };
    }
  }

  return { status: 'completed', finalized: true };
}

function buildSourceVersion(
  session: GatewaySessionSummary | null,
  updatedAt: number,
  messages: RealtimeMessageEntity[],
): string {
  if (!session) {
    const latestMessageAt = messages.reduce((max, message) => Math.max(max, message.createdAt), 0);
    return `missing|${updatedAt}|${latestMessageAt}|${messages.length}`;
  }

  return [
    updatedAt,
    resolveSessionStatus(session),
    trimToNull(session.agentState)?.toLowerCase() ?? '',
    trimToNull(session.runId) ?? '',
    trimToNull(session.currentRunId) ?? '',
    trimToNull(session.latestRunId) ?? '',
    session.busy ? 1 : 0,
    session.processing ? 1 : 0,
    session.abortedLastRun ? 1 : 0,
  ].join('|');
}

export async function buildRealtimeSnapshot(
  { sessionKey, limit }: BuildRealtimeSnapshotArgs,
): Promise<RealtimeSnapshotPayload> {
  const recoveredAt = Date.now();
  const [sessionsResult, historyResult] = await Promise.all([
    gatewayRpcCall('sessions.list', {
      activeMinutes: SESSIONS_ACTIVE_MINUTES,
      limit: SESSIONS_LIMIT,
    }) as Promise<GatewaySessionsListResponse>,
    gatewayRpcCall('chat.history', { sessionKey, limit }) as Promise<GatewayChatHistoryResponse>,
  ]);

  const sessions = Array.isArray(sessionsResult.sessions) ? sessionsResult.sessions : [];
  const session = sessions.find((entry) => getSessionKey(entry) === sessionKey) ?? null;

  const rawMessages = Array.isArray(historyResult.messages) ? historyResult.messages : [];
  const normalizedMessages = rawMessages
    .map((message, index) => normalizeHistoryMessage(message, sessionKey, recoveredAt, index))
    .filter((message): message is NormalizedHistoryMessage => Boolean(message));
  assignAssistantFallbackIds(normalizedMessages);

  const runAccumulators = new Map<string, RunAccumulator>();
  for (const message of normalizedMessages) {
    if (!message.runId) continue;
    const existing = runAccumulators.get(message.runId);
    if (existing) {
      if (!existing.messageIds.includes(message.messageId)) {
        existing.messageIds.push(message.messageId);
      }
      existing.lastEventAt = Math.max(existing.lastEventAt, message.createdAt);
      continue;
    }
    runAccumulators.set(message.runId, {
      runId: message.runId,
      messageIds: [message.messageId],
      lastEventAt: message.createdAt,
    });
  }

  const activeRunId = getActiveRunId(session);
  if (activeRunId && !runAccumulators.has(activeRunId)) {
    runAccumulators.set(activeRunId, {
      runId: activeRunId,
      messageIds: [],
      lastEventAt: 0,
    });
  }

  const terminalPlaceholderRunId = !activeRunId && isTerminalPlaceholderSession(session)
    ? getLastKnownRunId(session)
    : null;
  if (terminalPlaceholderRunId && !runAccumulators.has(terminalPlaceholderRunId)) {
    runAccumulators.set(terminalPlaceholderRunId, {
      runId: terminalPlaceholderRunId,
      messageIds: [],
      lastEventAt: 0,
    });
  }

  const latestMessageAt = normalizedMessages.reduce((max, message) => Math.max(max, message.createdAt), 0);
  const sessionUpdatedAt = Math.max(
    getSessionUpdatedAt(session),
    latestMessageAt,
    0,
  ) || recoveredAt;

  const runs: RealtimeRunEntity[] = [...runAccumulators.values()].map((run) => {
    const { status, finalized } = resolveRunState(
      session,
      run.runId,
      run.messageIds.length > 0,
      activeRunId,
      terminalPlaceholderRunId,
    );
    const isSessionScopedRun = run.runId === activeRunId || run.runId === terminalPlaceholderRunId;
    return {
      runId: run.runId,
      sessionId: sessionKey,
      status,
      messageIds: run.messageIds,
      lastEventAt: isSessionScopedRun
        ? Math.max(run.lastEventAt, sessionUpdatedAt)
        : run.lastEventAt,
      finalized,
    };
  });

  const presencePhase = resolvePresencePhase(session);
  const agentPresence: RealtimeAgentPresence | null = presencePhase
    ? {
      sessionId: sessionKey,
      agentId: getAgentIdFromSessionKey(sessionKey),
      phase: presencePhase,
      lastSeenAt: sessionUpdatedAt,
    }
    : null;

  const liveUpdatableAssistantMessageId = runs.some((run) => run.runId === activeRunId && !run.finalized)
    ? `${activeRunId}:assistant`
    : null;

  const messages: RealtimeMessageEntity[] = normalizedMessages
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
      return left._sortIndex - right._sortIndex;
    })
    .map((entry) => {
      const { _sortIndex, ...message } = entry;
      void _sortIndex;
      return liveUpdatableAssistantMessageId
        && message.role === 'assistant'
        && message.runId === activeRunId
        && message.messageId === liveUpdatableAssistantMessageId
          ? { ...message, revision: ACTIVE_SNAPSHOT_ASSISTANT_REVISION }
          : message;
    });

  return {
    session: {
      sessionId: sessionKey,
      status: resolveSessionStatus(session),
      agentId: getAgentIdFromSessionKey(sessionKey),
      updatedAt: sessionUpdatedAt,
      sourceVersion: buildSourceVersion(session, sessionUpdatedAt, messages),
    },
    runs,
    messages,
    agentPresence,
    recoveredAt,
    source: 'server-reconcile',
  };
}
