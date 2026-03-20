import { EventEmitter } from 'events';

// Re-export shared wire-format types from the shared package
export type { ScreenData, ProtocolType, Field } from 'green-screen-types';

// Import for use in this file
import type { ScreenData, ProtocolType } from 'green-screen-types';

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

  /** Set cursor position. Returns true if successful. */
  setCursor(row: number, col: number): boolean {
    return false;
  }

  /** Send raw bytes over the connection */
  abstract sendRaw(data: Buffer): void;

  /** Clean up resources */
  abstract destroy(): void;
}
