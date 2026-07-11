import { VTScreenBuffer } from './screen.js';
import { VT_KEYS } from './constants.js';

/**
 * Encodes client input into VT terminal wire-format data.
 *
 * VT terminals are character-at-a-time (stream mode): each keystroke
 * is sent immediately to the host. No block-mode buffering.
 */
export class VTEncoder {
  private screen: VTScreenBuffer;

  /** Whether BACKSPACE sends DEL (0x7F) or BS (0x08). Default: DEL */
  backspaceIsDel = true;

  /** Whether ENTER sends CR (0x0D) or CRLF. Default: CR only */
  enterIsCR = true;

  constructor(screen: VTScreenBuffer) {
    this.screen = screen;
  }

  /**
   * Encode a key name into the VT escape sequence to send over the wire.
   * Returns null if the key is unknown.
   */
  encodeKey(keyName: string): Buffer | null {
    const upper = keyName.toUpperCase();

    // DECCKM: application cursor keys send SS3 (ESC O x) instead of CSI.
    if (this.screen.applicationCursorKeys) {
      const app: Record<string, string> = {
        UP: '\x1bOA', DOWN: '\x1bOB', RIGHT: '\x1bOC', LEFT: '\x1bOD',
        ARROWUP: '\x1bOA', ARROWDOWN: '\x1bOB', ARROWRIGHT: '\x1bOC', ARROWLEFT: '\x1bOD',
      };
      if (app[upper]) return Buffer.from(app[upper], 'binary');
    }

    const seq = VT_KEYS[upper];
    if (seq) {
      return Buffer.from(seq, 'binary');
    }

    // Ctrl+letter (Ctrl+C = 0x03, Ctrl+A = 0x01, etc.)
    if (upper.startsWith('CTRL+') && upper.length === 6) {
      const letter = upper.charAt(5);
      const code = letter.charCodeAt(0) - 0x40; // A=1, B=2, ...
      if (code >= 1 && code <= 26) {
        return Buffer.from([code]);
      }
    }

    return null;
  }

  /**
   * Encode plain text for sending to the host.
   * Each character is sent as its ASCII byte.
   */
  encodeText(text: string): Buffer {
    return Buffer.from(text, 'utf-8');
  }

  /**
   * Insert text at the current cursor position (local echo + wire output).
   * Returns true if text was encoded successfully.
   */
  insertText(text: string): boolean {
    if (!text) return false;
    // VT is stream mode — no local screen buffering needed.
    // The host will echo characters back and the parser will render them.
    return true;
  }
}
