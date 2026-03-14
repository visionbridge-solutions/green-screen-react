import { EventEmitter } from 'events';

/**
 * Screen data returned by protocol handlers.
 * Protocol-agnostic representation of the terminal screen.
 */
export interface ScreenData {
  content: string;
  cursor_row: number;
  cursor_col: number;
  rows: number;
  cols: number;
  fields: Array<{
    row: number;
    col: number;
    length: number;
    is_input: boolean;
    is_protected: boolean;
    is_highlighted?: boolean;
    is_reverse?: boolean;
  }>;
  screen_signature: string;
  timestamp: string;
}

export type ProtocolType = 'tn5250' | 'tn3270' | 'vt' | 'hp6530';

export interface ProtocolOptions {
  /** Terminal type string for negotiation */
  terminalType?: string;
  /** Screen dimensions */
  rows?: number;
  cols?: number;
  /** Protocol-specific options */
  [key: string]: unknown;
}

/**
 * Interface that all protocol handlers must implement.
 * Each protocol (TN5250, TN3270, VT, etc.) provides its own implementation.
 */
export abstract class ProtocolHandler extends EventEmitter {
  abstract readonly protocol: ProtocolType;

  /** Connect to a remote host */
  abstract connect(host: string, port: number, options?: ProtocolOptions): Promise<void>;

  /** Disconnect from the host */
  abstract disconnect(): void;

  /** Whether the connection is active */
  abstract get isConnected(): boolean;

  /** Get the current screen state */
  abstract getScreenData(): ScreenData;

  /** Send text input at the current cursor position */
  abstract sendText(text: string): boolean;

  /**
   * Send a key action (ENTER, F1-F24, TAB, etc.).
   * Returns raw bytes to send over the wire, or null if key is unknown.
   */
  abstract sendKey(keyName: string): boolean;

  /** Send raw bytes over the connection */
  abstract sendRaw(data: Buffer): void;

  /** Clean up resources */
  abstract destroy(): void;
}
