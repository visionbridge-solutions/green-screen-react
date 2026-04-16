import type { TerminalAdapter, ScreenData, ConnectionStatus, SendResult, ConnectConfig, FieldValue } from './types';

export interface WebSocketAdapterOptions {
  /** URL of the green-screen proxy or worker. Auto-detected from env vars, defaults to http://localhost:3001 */
  workerUrl?: string;
  /** Send ping frames every N ms to keep the connection live and detect dead sockets. 0 disables. Default: 25000. */
  pingIntervalMs?: number;
  /** Close the socket if no message (including pong) received for this long. 0 disables. Default: 2× pingIntervalMs. */
  deadSocketTimeoutMs?: number;
  /** Reconnect automatically after an unintentional close. Default: true. */
  autoReconnect?: boolean;
  /** Max reconnect attempts (exponential backoff, 1s → 30s cap). Default: 20. */
  maxReconnectAttempts?: number;
}

/**
 * WebSocket adapter that connects to a green-screen proxy or Cloudflare Worker.
 * The backend holds the TCP connection to the legacy host and relays protocol data.
 *
 * Unlike RestAdapter (which polls over HTTP), this adapter receives real-time
 * screen updates via WebSocket push.
 *
 * workerUrl resolution order:
 *   1. Explicit `workerUrl` option
 *   2. VITE_GREEN_SCREEN_URL / VITE_WORKER_URL (Vite)
 *   3. NEXT_PUBLIC_GREEN_SCREEN_URL (Next.js)
 *   4. REACT_APP_GREEN_SCREEN_URL (CRA)
 *   5. http://localhost:3001
 */
export class WebSocketAdapter implements TerminalAdapter {
  private workerUrl: string;
  private ws: WebSocket | null = null;
  private screen: ScreenData | null = null;
  private status: ConnectionStatus = { connected: false, status: 'disconnected' };
  private pendingScreenResolver: ((value: ScreenData | null) => void) | null = null;
  private pendingConnectResolver: ((result: SendResult) => void) | null = null;
  private pendingMdtResolver: ((fields: FieldValue[]) => void) | null = null;
  private disconnectAckResolver: (() => void) | null = null;
  private connectingPromise: Promise<void> | null = null;
  private screenListeners: Set<(screen: ScreenData) => void> = new Set();
  private statusListeners: Set<(status: ConnectionStatus) => void> = new Set();
  private sessionLostListeners: Set<(sessionId: string, status: ConnectionStatus) => void> = new Set();
  private sessionResumedListeners: Set<(sessionId: string) => void> = new Set();
  private _sessionId: string | null = null;

  // Liveness + auto-reconnect.
  private pingIntervalMs: number;
  private deadSocketTimeoutMs: number;
  private autoReconnectEnabled: boolean;
  private maxReconnectAttempts: number;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private deadSocketTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts: number = 0;
  private intentionalClose: boolean = false;

  constructor(options: WebSocketAdapterOptions = {}) {
    this.workerUrl = (
      options.workerUrl
      || WebSocketAdapter.detectEnvUrl()
      || 'http://localhost:3001'
    ).replace(/\/+$/, '');
    this.pingIntervalMs = options.pingIntervalMs ?? 25000;
    this.deadSocketTimeoutMs = options.deadSocketTimeoutMs ?? this.pingIntervalMs * 2;
    this.autoReconnectEnabled = options.autoReconnect ?? true;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 20;
  }

  private static detectEnvUrl(): string | undefined {
    try {
      if (typeof import.meta !== 'undefined' && (import.meta as any).env) {
        const env = (import.meta as any).env;
        return env.VITE_GREEN_SCREEN_URL || env.VITE_WORKER_URL || undefined;
      }
    } catch { /* import.meta not available */ }
    try {
      // Use indirect eval to avoid static analysis picking up 'process' as a Node global
      const p = typeof globalThis !== 'undefined' && (globalThis as any).process;
      if (p && p.env) {
        return p.env.NEXT_PUBLIC_GREEN_SCREEN_URL
          || p.env.REACT_APP_GREEN_SCREEN_URL
          || undefined;
      }
    } catch { /* process not available */ }
    return undefined;
  }

  /** The proxy-side session ID (available after connect or reattach) */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /** Subscribe to real-time screen updates */
  onScreen(listener: (screen: ScreenData) => void): () => void {
    this.screenListeners.add(listener);
    return () => this.screenListeners.delete(listener);
  }

  /** Subscribe to status changes */
  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /**
   * Subscribe to session-lost notifications. Fires when the proxy detects
   * that the server-side session has terminated (host TCP drop, idle
   * timeout, explicit destroy). Integrators use this to prompt a reconnect
   * or swap to a "session expired" UI without relying on error-string
   * matching.
   */
  onSessionLost(listener: (sessionId: string, status: ConnectionStatus) => void): () => void {
    this.sessionLostListeners.add(listener);
    return () => this.sessionLostListeners.delete(listener);
  }

  /** Subscribe to session-resumed notifications (fires after a successful `reattach`). */
  onSessionResumed(listener: (sessionId: string) => void): () => void {
    this.sessionResumedListeners.add(listener);
    return () => this.sessionResumedListeners.delete(listener);
  }

  async getScreen(): Promise<ScreenData | null> {
    return this.screen;
  }

  async getStatus(): Promise<ConnectionStatus> {
    return this.status;
  }

  async sendText(text: string): Promise<SendResult> {
    return this.sendAndWaitForScreen({ type: 'text', text });
  }

  async sendKey(key: string): Promise<SendResult> {
    return this.sendAndWaitForScreen({ type: 'key', key });
  }

  async setCursor(row: number, col: number): Promise<SendResult> {
    return this.sendAndWaitForScreen({ type: 'setCursor', row, col });
  }

  async readMdt(modifiedOnly: boolean = true): Promise<FieldValue[]> {
    await this.ensureWebSocket();
    return new Promise((resolve) => {
      // Only one in-flight MDT read at a time — flush any prior resolver
      if (this.pendingMdtResolver) {
        const old = this.pendingMdtResolver;
        this.pendingMdtResolver = null;
        old([]);
      }
      const timeout = setTimeout(() => {
        this.pendingMdtResolver = null;
        resolve([]);
      }, 5000);
      this.pendingMdtResolver = (fields) => {
        clearTimeout(timeout);
        resolve(fields);
      };
      this.wsSend({ type: 'readMdt', modifiedOnly });
    });
  }

  async connect(config?: ConnectConfig): Promise<SendResult> {
    await this.ensureWebSocket();

    if (!config) {
      return { success: false, error: 'ConnectConfig required' };
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingConnectResolver = null;
        resolve({ success: false, error: 'Connection timeout' });
      }, 30000);

      this.pendingConnectResolver = (result: SendResult) => {
        clearTimeout(timeout);
        resolve(result);
      };

      this.wsSend({
        type: 'connect',
        host: config.host,
        port: config.port,
        protocol: config.protocol,
        username: config.username,
        password: config.password,
        terminalType: config.terminalType,
      });
    });
  }

  /**
   * Reattach to an existing proxy session (e.g. after page reload).
   * The proxy keeps the TCP connection alive; this just reconnects the
   * WebSocket and receives the current screen.
   */
  async reattach(sessionId: string): Promise<SendResult> {
    await this.ensureWebSocket();

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingConnectResolver = null;
        resolve({ success: false, error: 'Reattach timeout' });
      }, 10000);

      this.pendingConnectResolver = (result: SendResult) => {
        clearTimeout(timeout);
        resolve(result);
      };

      this.wsSend({ type: 'reattach', sessionId });
    });
  }

  async disconnect(): Promise<SendResult> {
    // Wait for the server to ack the disconnect before closing the socket.
    // The server's handler sends SIGNOFF to the host and then replies with
    // { type: 'disconnected' } — closing the WS earlier would race against
    // the server teardown and orphan the session on the proxy (and on the
    // host, for IBM i with LMTDEVSSN=*YES this triggers CPF1220 on the
    // next login).
    const acked = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000); // hard cap
      this.disconnectAckResolver = () => { clearTimeout(timer); resolve(); };
    });

    this.wsSend({ type: 'disconnect' });
    try { await acked; } finally {
      this.disconnectAckResolver = null;
    }

    this.status = { connected: false, status: 'disconnected' };
    this._sessionId = null;
    this.intentionalClose = true;
    this.stopPingLoop();
    this.clearDeadSocketTimer();
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    return { success: true };
  }

  async reconnect(): Promise<SendResult> {
    return { success: false, error: 'Use disconnect() then connect() instead' };
  }

  /** Close the WebSocket without sending disconnect (session stays alive on proxy).
   *  Also cancels any pending auto-reconnect — call ensureWebSocket() or
   *  reattach() later to re-establish the socket. */
  dispose(): void {
    this.intentionalClose = true;
    this.stopPingLoop();
    this.clearDeadSocketTimer();
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private async ensureWebSocket(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connectingPromise) return this.connectingPromise;

    this.intentionalClose = false;
    this.clearReconnectTimer();

    this.connectingPromise = new Promise<void>((resolve, reject) => {
      const wsUrl = this.workerUrl.replace(/^http/, 'ws') + '/ws';
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.startPingLoop();
        this.armDeadSocketTimer();
        // After a reconnect with a known session id, always reattach — the
        // socket may have dropped for reasons that don't change the id
        // (proxy restart, nginx blip). The integrator can't detect this, so
        // the adapter re-sends reattach unconditionally. Safe to do on the
        // first connect too: if _sessionId is still null, skipped.
        if (this._sessionId) {
          try {
            this.wsSend({ type: 'reattach', sessionId: this._sessionId });
          } catch { /* wsSend is no-op if socket not OPEN */ }
        }
        resolve();
      };
      this.ws.onerror = () => reject(new Error('WebSocket connection failed'));

      this.ws.onmessage = (event) => {
        // Any inbound message = socket is alive; reset the watchdog.
        this.armDeadSocketTimer();
        try {
          const msg = JSON.parse(event.data);
          this.handleMessage(msg);
        } catch { /* ignore non-JSON messages */ }
      };

      this.ws.onclose = () => {
        this.stopPingLoop();
        this.clearDeadSocketTimer();
        this.status = { connected: false, status: 'disconnected' };
        for (const listener of this.statusListeners) listener(this.status);
        this.scheduleReconnect();
      };
    }).finally(() => {
      this.connectingPromise = null;
    });

    return this.connectingPromise;
  }

  // ── Liveness ──────────────────────────────────────────────────

  private startPingLoop(): void {
    this.stopPingLoop();
    if (this.pingIntervalMs <= 0) return;
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.send(JSON.stringify({ type: 'ping' })); }
        catch { /* ignore; dead-socket timer will catch it */ }
      }
    }, this.pingIntervalMs);
  }

  private stopPingLoop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private armDeadSocketTimer(): void {
    this.clearDeadSocketTimer();
    if (this.deadSocketTimeoutMs <= 0) return;
    this.deadSocketTimer = setTimeout(() => {
      // No message (not even pong) for the whole window — treat the socket
      // as dead even if the TCP stack still thinks it's open. Closing will
      // fire onclose → scheduleReconnect.
      if (this.ws) {
        try { this.ws.close(4000, 'dead-socket-timeout'); } catch { /* noop */ }
      }
    }, this.deadSocketTimeoutMs);
  }

  private clearDeadSocketTimer(): void {
    if (this.deadSocketTimer) {
      clearTimeout(this.deadSocketTimer);
      this.deadSocketTimer = null;
    }
  }

  // ── Auto-reconnect ────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (!this.autoReconnectEnabled) return;
    if (this.intentionalClose) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Fire and forget — ensureWebSocket swallows errors via the
      // connectingPromise reject path; another onclose will schedule again.
      this.ensureWebSocket().catch(() => { /* scheduled again via onclose */ });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'screen': {
        this.screen = msg.data;
        for (const listener of this.screenListeners) listener(msg.data);
        if (this.pendingScreenResolver) {
          const resolver = this.pendingScreenResolver;
          this.pendingScreenResolver = null;
          resolver(msg.data);
        }
        break;
      }

      case 'cursor': {
        // Lightweight cursor-only response for local operations (Tab,
        // Backtab, arrows, Home, End). Update the cached screen's
        // cursor position AND notify screen listeners so the React
        // component re-renders the cursor in its new location.
        // Without the listener dispatch, Tab/arrows would update the
        // proxy's internal cursor but never reach the UI — the green
        // cursor block would stay stuck at the last full-screen update.
        if (this.screen) {
          this.screen = {
            ...this.screen,
            cursor_row: msg.data.cursor_row,
            cursor_col: msg.data.cursor_col,
          };
          for (const listener of this.screenListeners) listener(this.screen);
        }
        if (this.pendingScreenResolver) {
          const resolver = this.pendingScreenResolver;
          this.pendingScreenResolver = null;
          resolver({
            cursor_row: msg.data.cursor_row,
            cursor_col: msg.data.cursor_col,
            content: this.screen?.content ?? '',
            screen_signature: this.screen?.screen_signature ?? '',
          } as any);
        }
        break;
      }

      case 'mdt': {
        if (this.pendingMdtResolver) {
          const resolver = this.pendingMdtResolver;
          this.pendingMdtResolver = null;
          resolver(msg.data?.fields ?? []);
        }
        break;
      }

      case 'session.lost': {
        for (const listener of this.sessionLostListeners) listener(msg.sessionId, msg.status);
        break;
      }

      case 'session.resumed': {
        for (const listener of this.sessionResumedListeners) listener(msg.sessionId);
        break;
      }

      case 'status':
        this.status = msg.data;
        for (const listener of this.statusListeners) listener(msg.data);
        break;

      case 'connected':
        this._sessionId = msg.sessionId ?? null;
        if (this.pendingConnectResolver) {
          const resolver = this.pendingConnectResolver;
          this.pendingConnectResolver = null;
          resolver({ success: true });
        }
        break;

      case 'disconnected':
        // Server ack for our disconnect request — SIGNOFF has been sent
        // (or attempted) and the session has been destroyed server-side.
        if (this.disconnectAckResolver) {
          const resolver = this.disconnectAckResolver;
          this.disconnectAckResolver = null;
          resolver();
        }
        break;

      case 'error': {
        if (this.pendingConnectResolver) {
          const resolver = this.pendingConnectResolver;
          this.pendingConnectResolver = null;
          resolver({ success: false, error: msg.message });
        } else if (this.pendingScreenResolver) {
          const resolver = this.pendingScreenResolver;
          this.pendingScreenResolver = null;
          resolver(null);
        }
        break;
      }

      case 'pong':
        // Dead-socket timer already reset via armDeadSocketTimer() in onmessage.
        break;
    }
  }

  private sendAndWaitForScreen(msg: object): Promise<SendResult> {
    return new Promise((resolve) => {
      // Flush any existing pending resolver with current screen data
      if (this.pendingScreenResolver) {
        const old = this.pendingScreenResolver;
        this.pendingScreenResolver = null;
        old(this.screen);
      }

      const timeout = setTimeout(() => {
        this.pendingScreenResolver = null;
        resolve({ success: true, ...this.screenToResult() });
      }, 5000);

      this.pendingScreenResolver = (screen: ScreenData | null) => {
        clearTimeout(timeout);
        if (screen) {
          resolve({
            success: true,
            cursor_row: screen.cursor_row,
            cursor_col: screen.cursor_col,
            content: screen.content,
            screen_signature: screen.screen_signature,
          });
        } else {
          resolve({ success: false, error: 'No screen data received' });
        }
      };

      this.wsSend(msg);
    });
  }

  private screenToResult(): Partial<SendResult> {
    if (!this.screen) return {};
    return {
      cursor_row: this.screen.cursor_row,
      cursor_col: this.screen.cursor_col,
      content: this.screen.content,
      screen_signature: this.screen.screen_signature,
    };
  }

  private wsSend(data: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
}
