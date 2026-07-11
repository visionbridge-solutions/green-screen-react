import { EventEmitter } from 'events';

// Re-export shared wire-format types from the shared package
export type { ScreenData, ProtocolType, Field, FieldValue } from 'green-screen-types';

// Import for use in this file
import type { ScreenData, ProtocolType, FieldValue } from 'green-screen-types';
import type { EbcdicCodePage } from '../encoding/ebcdic.js';
import { LOCAL_KEYS } from '../local-keys.js';

/**
 * Static, protocol-level traits the transport layers (controller, routes,
 * session) branch on. Kept deliberately tiny — anything invocable is an
 * optional method on ProtocolHandler instead (capability = the method
 * exists), so call sites never need `instanceof` checks.
 */
export interface ProtocolTraits {
  /**
   * 'block'  — screen-at-a-time protocols (TN5250, TN3270, HP6530 block
   *            mode): editing keys mutate the local buffer, AID keys
   *            round-trip to the host.
   * 'stream' — character-at-a-time protocols (VT): every key goes to the
   *            host, which echoes; there is no local edit buffer.
   */
  inputModel: 'block' | 'stream';
  /** Protocol has a real per-field modified-data-tag (read-mdt is meaningful). */
  hasMdt: boolean;
}

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
   *   - 'cp273'/'cp1141' — Germany/Austria (1141 adds euro)
   *   - 'cp500'/'cp1148' — International Latin-1 (1148 adds euro)
   *   - 'cp1140' — US/Canada + euro
   * If omitted, the handler derives it from the terminal-type string
   * (e.g. 'IBM-5555-C01' for Japanese) or defaults to 'cp37'.
   */
  codePage?: EbcdicCodePage;
  /** Protocol-specific options */
  [key: string]: unknown;
}

/**
 * Interface that all protocol handlers must implement.
 * Each protocol (TN5250, TN3270, VT, etc.) provides its own implementation.
 */
export abstract class ProtocolHandler extends EventEmitter {
  abstract readonly protocol: ProtocolType;

  /** Static protocol traits — see ProtocolTraits. Block-mode by default. */
  get traits(): ProtocolTraits {
    return { inputModel: 'block', hasMdt: false };
  }

  /**
   * Whether a key is resolved locally in the screen buffer with no host
   * round-trip. Default: the block-mode editing-key set (Tab/arrows/
   * Backspace/…). Stream protocols (VT) override to false for everything —
   * the host owns the echo. The transports (controller/routes) MUST route
   * through this instead of consulting LOCAL_KEYS directly.
   */
  isLocalKey(key: string): boolean {
    return LOCAL_KEYS.has(key);
  }

  /**
   * OPTIONAL capability — autonomous sign-on: confirm the current screen
   * is a credential prompt, fill user/password, submit, and classify the
   * result. Present only on protocols with a safe, structural way to
   * confirm a sign-on screen before typing credentials (TN5250). Absent ⇒
   * the transports fall back to a plain screen wait and the integrator
   * drives sign-on through the generic primitives.
   */
  performAutoSignIn?(
    username: string,
    password: string,
  ): Promise<{ screen: ScreenData; authenticated: boolean } | null>;

  /**
   * OPTIONAL capability — best-effort host-side sign-off before the TCP
   * socket is dropped (TN5250 types SIGNOFF so IBM i reaps the interactive
   * job instead of tripping LMTDEVSSN/CPF1220). Absent ⇒ graceful
   * disconnect degrades to a plain destroy.
   */
  attemptGracefulExit?(timeoutMs?: number): Promise<boolean>;

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
   * Erase from cursor to end of current input field (TN5250 EraseEOF).
   * Used by integrators to clear stale residue in a field before typing a
   * shorter replacement value. Protocols without a field model return false.
   */
  eraseEOF(): boolean {
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

  /**
   * Liveness signal for the underlying TCP — wall-clock ms timestamps
   * of the most recent byte sent to the host and the most recent byte
   * received from the host. Either can be 0 for a freshly-constructed
   * handler that has never connected.
   *
   * The intended use is unambiguous half-open detection: if the caller
   * sent something at time T, but ``lastReceivedAtMs`` is still < T
   * after a reasonable RTT-plus-margin window, the host is silent and
   * the link is dead. No reading of screen state, no overlap with
   * "keyboard locked because the user typed an invalid menu option".
   *
   * Default returns zeros so non-socket protocols don't have to
   * implement anything. TN5250 overrides.
   */
  getLiveness(): { lastReceivedAtMs: number; lastSentAtMs: number } {
    return { lastReceivedAtMs: 0, lastSentAtMs: 0 };
  }

  /** Clean up resources */
  abstract destroy(): void;
}
