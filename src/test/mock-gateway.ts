/**
 * Mock OpenClaw gateway WebSocket server for testing.
 *
 * Simulates the gateway WS protocol: challenge/response handshake,
 * chat message streaming, session CRUD, and error injection.
 */
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type Server } from 'node:http';
import type { ChatMessage, Session } from '@/types';

export interface MockGatewayOptions {
  /** Port to listen on (0 = random) */
  port?: number;
  /** Reject connections with invalid tokens */
  requireToken?: string;
  /** Nonce sent in connect.challenge */
  challengeNonce?: string;
  /** Initial sessions returned by sessions.list */
  sessions?: Session[];
}

export interface ReceivedMessage {
  data: unknown;
  raw: string;
  timestamp: number;
}

/**
 * A mock WebSocket server that mimics the OpenClaw gateway protocol.
 */
export class MockGateway {
  private httpServer: Server;
  private wss: WebSocketServer;
  private connections: Set<WebSocket> = new Set();
  private _received: ReceivedMessage[] = [];
  private _port = 0;
  private _options: MockGatewayOptions;
  private histories: Map<string, ChatMessage[]> = new Map();
  private sessions: Map<string, Session> = new Map();
  private gatewaySeq = 0;
  private runCounter = 0;

  constructor(options: MockGatewayOptions = {}) {
    this._options = {
      challengeNonce: 'test-nonce-123',
      ...options,
    };
    for (const session of options.sessions || []) {
      const key = session.sessionKey || session.key || session.id;
      if (key) this.sessions.set(key, session);
    }
    this.httpServer = createServer();
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws: WebSocket) => {
      this.connections.add(ws);

      // Send connect.challenge immediately
      ws.send(JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: this._options.challengeNonce },
      }));

      ws.on('message', (data: Buffer | string) => {
        const raw = data.toString();
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        this._received.push({ data: parsed, raw, timestamp: Date.now() });

        // Handle JSON-RPC request
        if (typeof parsed === 'object' && parsed !== null) {
          const msg = parsed as Record<string, unknown>;
          if (msg.type === 'req') {
            this.handleRequest(ws, msg);
            return;
          }
        }
      });

      ws.on('close', () => {
        this.connections.delete(ws);
      });
    });
  }

  private sendResponse(
    ws: WebSocket,
    id: unknown,
    payload: unknown,
  ): void {
    ws.send(JSON.stringify({
      type: 'res',
      id,
      ok: true,
      payload,
    }));
  }

  private sendErrorResponse(
    ws: WebSocket,
    id: unknown,
    code: number,
    message: string,
  ): void {
    ws.send(JSON.stringify({
      type: 'res',
      id,
      ok: false,
      error: { code, message },
    }));
  }

  private handleRequest(ws: WebSocket, msg: Record<string, unknown>): void {
    if (msg.method === 'connect') {
      this.handleConnect(ws, msg);
      return;
    }

    const params = (msg.params || {}) as Record<string, unknown>;
    switch (msg.method) {
      case 'chat.send': {
        const sessionKey = String(params.sessionKey || 'agent:test:main');
        this.ensureSession(sessionKey, { state: 'running', busy: true });
        const message = typeof params.message === 'string' ? params.message : '';
        if (message.trim()) {
          this.appendHistory(sessionKey, [{
            role: 'user',
            content: message,
            timestamp: Date.now(),
          }]);
        }
        const runId = `mock-run-${++this.runCounter}`;
        this.sendResponse(ws, msg.id, { runId, status: 'started' });
        return;
      }
      case 'chat.history': {
        const sessionKey = String(params.sessionKey || 'agent:test:main');
        const limit = typeof params.limit === 'number' ? params.limit : 100;
        const messages = this.getHistory(sessionKey).slice(-limit);
        this.sendResponse(ws, msg.id, { messages });
        return;
      }
      case 'chat.abort': {
        const sessionKey = String(params.sessionKey || 'agent:test:main');
        this.ensureSession(sessionKey, { state: 'aborted', busy: false });
        this.sendResponse(ws, msg.id, { ok: true });
        return;
      }
      case 'sessions.list': {
        this.sendResponse(ws, msg.id, { sessions: [...this.sessions.values()] });
        return;
      }
      case 'sessions.patch': {
        const key = String(params.key || params.sessionKey || '');
        if (key) {
          const patch = (params.patch || params) as Partial<Session>;
          this.ensureSession(key, patch);
        }
        this.sendResponse(ws, msg.id, { ok: true });
        return;
      }
      default:
        this.sendErrorResponse(ws, msg.id, 404, `Unhandled mock RPC method: ${String(msg.method)}`);
    }
  }

  private handleConnect(ws: WebSocket, msg: Record<string, unknown>): void {
    const params = (msg.params || {}) as Record<string, unknown>;
    const auth = (params.auth || {}) as Record<string, unknown>;
    const token = auth.token as string | undefined;

    // Token validation
    if (this._options.requireToken && token !== this._options.requireToken) {
      this.sendErrorResponse(ws, msg.id, 4001, 'Invalid token');
      ws.close(1008, 'authentication failed');
      return;
    }

    // Successful connect
    this.sendResponse(ws, msg.id, {
      session: { id: 'test-session-1' },
      scopes: ['operator.read', 'operator.write'],
    });
  }

  /** Start listening. Returns the assigned port. */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.httpServer.listen(this._options.port || 0, '127.0.0.1', () => {
        const addr = this.httpServer.address();
        if (typeof addr === 'object' && addr) {
          this._port = addr.port;
          resolve(this._port);
        } else {
          reject(new Error('Failed to get address'));
        }
      });
      this.httpServer.on('error', reject);
    });
  }

  /** Get the WS URL of this mock gateway. */
  get url(): string {
    return `ws://127.0.0.1:${this._port}`;
  }

  /** Get the HTTP URL of this mock gateway. */
  get httpUrl(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  /** Port the server is listening on. */
  get port(): number {
    return this._port;
  }

  /** All received messages. */
  get received(): ReceivedMessage[] {
    return this._received;
  }

  /** Clear received messages. */
  clearReceived(): void {
    this._received = [];
  }

  /** Replace transcript history for a session. */
  setHistory(sessionKey: string, messages: ChatMessage[]): void {
    this.histories.set(sessionKey, [...messages]);
    this.ensureSession(sessionKey);
  }

  /** Append transcript messages for a session. */
  appendHistory(sessionKey: string, messages: ChatMessage[]): void {
    this.histories.set(sessionKey, [...this.getHistory(sessionKey), ...messages]);
    this.ensureSession(sessionKey);
  }

  /** Read transcript history for a session. */
  getHistory(sessionKey: string): ChatMessage[] {
    return [...(this.histories.get(sessionKey) || [])];
  }

  /** Insert or update a mock session row. */
  ensureSession(sessionKey: string, patch: Partial<Session> = {}): Session {
    const current = this.sessions.get(sessionKey) || { sessionKey, state: 'idle' };
    const next = {
      ...current,
      ...patch,
      sessionKey,
      updatedAt: Date.now(),
    };
    this.sessions.set(sessionKey, next);
    return next;
  }

  /** Wait until at least `count` messages are received, with a timeout. */
  async expectMessages(count: number, timeoutMs = 3000): Promise<ReceivedMessage[]> {
    const start = Date.now();
    while (this._received.length < count) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timed out waiting for ${count} messages (got ${this._received.length})`,
        );
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return this._received.slice(0, count);
  }

  /** Send a streaming chunk to all connected clients. */
  sendChunk(requestId: string, text: string): void {
    const msg = JSON.stringify({
      type: 'event',
      event: 'chat.chunk',
      payload: { requestId, text },
    });
    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  /** Send a completion event to all connected clients. */
  sendComplete(requestId: string): void {
    const msg = JSON.stringify({
      type: 'event',
      event: 'chat.complete',
      payload: { requestId },
    });
    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  /** Send a current OpenClaw-style chat delta event. */
  sendChatDelta(params: {
    sessionKey: string;
    runId: string;
    text: string;
    seq?: number;
    timestamp?: number;
  }): void {
    this.broadcastGatewayEvent('chat', {
      sessionKey: params.sessionKey,
      runId: params.runId,
      seq: params.seq,
      state: 'delta',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: params.text }],
        timestamp: params.timestamp || Date.now(),
      },
    });
  }

  /** Send a current OpenClaw-style final chat event and append it to history. */
  sendChatFinal(params: {
    sessionKey: string;
    runId: string;
    text?: string;
    message?: ChatMessage;
    messages?: ChatMessage[];
    seq?: number;
    timestamp?: number;
    stopReason?: string;
  }): void {
    const message = params.message || (params.text !== undefined ? {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: params.text }],
      timestamp: params.timestamp || Date.now(),
    } : undefined);
    const messages = params.messages || (message ? [message] : []);
    if (messages.length > 0) this.appendHistory(params.sessionKey, messages);
    this.ensureSession(params.sessionKey, { state: 'idle', busy: false });
    this.broadcastGatewayEvent('chat', {
      sessionKey: params.sessionKey,
      runId: params.runId,
      seq: params.seq,
      state: 'final',
      ...(message ? { message } : {}),
      ...(params.stopReason ? { stopReason: params.stopReason } : {}),
    });
  }

  /** Send a current OpenClaw-style tool start event. */
  sendAgentToolStart(params: {
    sessionKey: string;
    runId: string;
    toolCallId: string;
    name: string;
    args?: Record<string, unknown>;
    seq?: number;
    timestamp?: number;
  }): void {
    this.broadcastGatewayEvent('agent', {
      sessionKey: params.sessionKey,
      runId: params.runId,
      seq: params.seq,
      stream: 'tool',
      ts: params.timestamp || Date.now(),
      data: {
        phase: 'start',
        toolCallId: params.toolCallId,
        name: params.name,
        args: params.args || {},
      },
    });
  }

  /** Send a current OpenClaw-style tool result event. */
  sendAgentToolResult(params: {
    sessionKey: string;
    runId: string;
    toolCallId: string;
    seq?: number;
    timestamp?: number;
  }): void {
    this.broadcastGatewayEvent('agent', {
      sessionKey: params.sessionKey,
      runId: params.runId,
      seq: params.seq,
      stream: 'tool',
      ts: params.timestamp || Date.now(),
      data: {
        phase: 'result',
        toolCallId: params.toolCallId,
      },
    });
  }

  /** Send a current OpenClaw-style lifecycle event. */
  sendAgentLifecycle(params: {
    sessionKey: string;
    runId: string;
    phase: 'start' | 'end' | 'error';
    seq?: number;
    timestamp?: number;
  }): void {
    this.broadcastGatewayEvent('agent', {
      sessionKey: params.sessionKey,
      runId: params.runId,
      seq: params.seq,
      stream: 'lifecycle',
      ts: params.timestamp || Date.now(),
      data: { phase: params.phase },
    });
  }

  /** Send an error to all connected clients. */
  sendError(code: number, message: string): void {
    const msg = JSON.stringify({
      type: 'event',
      event: 'error',
      payload: { code, message },
    });
    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  /** Disconnect all clients with an optional code/reason. */
  disconnectAll(code = 1000, reason = 'mock disconnect'): void {
    for (const ws of this.connections) {
      ws.close(code, reason);
    }
  }

  /** Send a raw message to all connected clients. */
  broadcast(data: string | Buffer): void {
    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  private broadcastGatewayEvent(event: string, payload: unknown): void {
    const msg = JSON.stringify({
      type: 'event',
      event,
      seq: ++this.gatewaySeq,
      payload,
    });
    this.broadcast(msg);
  }

  /** Number of currently connected clients. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** Gracefully shut down the mock server. */
  async close(): Promise<void> {
    for (const ws of this.connections) {
      ws.close(1001, 'server closing');
    }
    this.connections.clear();
    this.wss.close();
    return new Promise((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }
}

/**
 * Create, start, and return a MockGateway. Convenience for tests.
 */
export async function createMockGateway(
  options?: MockGatewayOptions,
): Promise<MockGateway> {
  const gw = new MockGateway(options);
  await gw.start();
  return gw;
}
