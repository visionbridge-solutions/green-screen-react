import { EventEmitter } from 'events';

// Re-export shared wire-format types from the shared package
export type { ScreenData, ProtocolType, Field, FieldValue } from 'green-screen-types';

// Import for use in this file
import type { ScreenData, ProtocolType, FieldValue } from 'green-screen-types';

export interface ProtocolOptions {
  /** Terminal type string for negotiation */
  terminalType?: string;
  /** Screen dimensions */
  rows?: number;
  cols?: number;
  /**
   * EBCDIC single-byte code page for character translation. For IBM i:
   *   - 'cp37'  — US/Canada/Brazil/AU/NZ (default)
   *   - 'cp290' — Japan Katakana (use with SO/SI DBCS for full Kanji support)
   * If omitted, the handler derives it from the terminal-type string
   * (e.g. 'IBM-5555-C01' for Japanese) or defaults to 'cp37'.
   */
  codePage?: 'cp37' | 'cp290';
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

  /**
   * Read the current text content of input fields on the screen, optionally
   * restricted to fields whose per-field modified-data-tag (MDT) bit is set.
   * Used by the `/read-mdt` primitive as a cheap post-write verification
   * path — much smaller payload than `getScreenData()` when only a few
   * fields were modified. Protocols without a per-field modified concept
   * (VT, HP6530) return an empty array.
   */
  readFieldValues(_modifiedOnly: boolean = true): FieldValue[] {
    return [];
  }

  /**
   * Wait until the next screen change satisfies `minFields` input fields,
   * or the timeout elapses. Used by integrators building robust sign-on
   * cascades (or any flow that first needs to see a form). Default
   * implementation falls back to a plain timed wait for one `screenChange`
   * event — protocol handlers with richer semantics (e.g. TN5250) should
   * override to short-circuit when the current screen already satisfies.
   */
  waitForScreenWithFields(_minFields: number, timeoutMs: number): Promise<ScreenData> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.getScreenData()), timeoutMs);
      this.once('screenChange', (data: ScreenData) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  /** Send raw bytes over the connection */
  abstract sendRaw(data: Buffer): void;

  /** Clean up resources */
  abstract destroy(): void;
}
