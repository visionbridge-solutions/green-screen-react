import type { TerminalAdapter, ScreenData, ConnectionStatus, SendResult } from './types';

export interface RestAdapterOptions {
  /** Base URL for the terminal API (e.g. "https://myhost.com/api/terminal") */
  baseUrl: string;
  /** Optional headers to include with every request (e.g. Authorization) */
  headers?: Record<string, string>;
  /** Optional function that returns headers (called per-request, useful for dynamic tokens) */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
}

/**
 * REST API adapter for terminal communication.
 *
 * Expects a backend that exposes these endpoints relative to `baseUrl`:
 * - GET  /screen       → ScreenData
 * - GET  /status       → ConnectionStatus
 * - POST /send-text    → SendResult  (body: { text })
 * - POST /send-key     → SendResult  (body: { key })
 * - POST /connect      → SendResult
 * - POST /disconnect   → SendResult
 * - POST /reconnect    → SendResult
 */
export class RestAdapter implements TerminalAdapter {
  private baseUrl: string;
  private staticHeaders: Record<string, string>;
  private getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;

  constructor(options: RestAdapterOptions) {
    // Remove trailing slash
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.staticHeaders = options.headers || {};
    this.getHeaders = options.getHeaders;
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const dynamic = this.getHeaders ? await this.getHeaders() : {};
    return {
      'Content-Type': 'application/json',
      ...this.staticHeaders,
      ...dynamic,
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers = await this.buildHeaders();
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail?.detail || `HTTP ${response.status}`);
    }

    return response.json();
  }

  async getScreen(): Promise<ScreenData | null> {
    try {
      return await this.request<ScreenData>('GET', '/screen');
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      // 503/404 expected when no active connection
      if (message.includes('503') || message.includes('404')) {
        return null;
      }
      throw e;
    }
  }

  async getStatus(): Promise<ConnectionStatus> {
    return this.request<ConnectionStatus>('GET', '/status');
  }

  async sendText(text: string): Promise<SendResult> {
    return this.request<SendResult>('POST', '/send-text', { text });
  }

  async sendKey(key: string): Promise<SendResult> {
    return this.request<SendResult>('POST', '/send-key', { key });
  }

  async connect(): Promise<SendResult> {
    return this.request<SendResult>('POST', '/connect');
  }

  async disconnect(): Promise<SendResult> {
    return this.request<SendResult>('POST', '/disconnect');
  }

  async reconnect(): Promise<SendResult> {
    return this.request<SendResult>('POST', '/reconnect');
  }
}
