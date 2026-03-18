import { HP6530Screen } from './screen.js';
import { CTRL, ATTR } from './constants.js';

const State = { NORMAL: 0, ESC: 1, CSI: 2, AMP: 3, AMP_D: 4 } as const;
type State = (typeof State)[keyof typeof State];

/**
 * Parses HP 6530 escape sequences from a data stream and applies
 * them to the screen buffer.
 *
 * The HP 6530 uses an escape-sequence protocol that is somewhat
 * similar to VT terminals but with HP-specific extensions for
 * block-mode operation, protected fields, and display attributes.
 */
export class HP6530Parser {
  private screen: HP6530Screen;
  private state: State = State.NORMAL;

  /** Accumulated numeric parameter for CSI sequences */
  private csiParams: string = '';

  constructor(screen: HP6530Screen) {
    this.screen = screen;
  }

  /**
   * Parse a chunk of data from the host.
   * Returns true if the screen was modified.
   */
  parse(data: Buffer): boolean {
    let modified = false;

    for (let i = 0; i < data.length; i++) {
      const byte = data[i];
      const changed = this.processByte(byte);
      if (changed) modified = true;
    }

    if (modified) {
      this.screen.buildFields();
    }

    return modified;
  }

  /**
   * Process a single byte through the state machine.
   * Returns true if the screen was modified.
   */
  private processByte(byte: number): boolean {
    switch (this.state) {

      case State.NORMAL:
        return this.processNormal(byte);

      case State.ESC:
        return this.processEsc(byte);

      case State.CSI:
        return this.processCsi(byte);

      case State.AMP:
        return this.processAmp(byte);

      case State.AMP_D:
        return this.processAmpD(byte);

      default:
        this.state = State.NORMAL;
        return false;
    }
  }

  /** Process a byte in NORMAL state */
  private processNormal(byte: number): boolean {
    // ESC starts an escape sequence
    if (byte === CTRL.ESC) {
      this.state = State.ESC;
      return false;
    }

    // Control characters
    switch (byte) {
      case CTRL.CR:
        this.screen.cursorCol = 0;
        return true;

      case CTRL.LF:
        this.screen.cursorRow++;
        if (this.screen.cursorRow >= this.screen.rows) {
          this.screen.cursorRow = this.screen.rows - 1;
          // In a real terminal this would scroll; for block mode we stay put
        }
        return true;

      case CTRL.BS:
        if (this.screen.cursorCol > 0) {
          this.screen.cursorCol--;
        }
        return true;

      case CTRL.HT:
        // Tab: advance to next tab stop (every 8 columns) or next unprotected field
        this.handleTab();
        return true;

      case CTRL.BEL:
        // Bell — no screen change
        return false;

      case CTRL.FF:
        // Form feed — clear screen
        this.screen.clear();
        return true;

      case CTRL.NUL:
        // Ignore NULs
        return false;
    }

    // Printable ASCII (0x20–0x7E)
    if (byte >= 0x20 && byte <= 0x7E) {
      this.screen.putChar(String.fromCharCode(byte));
      return true;
    }

    // High-bit characters (0x80–0xFF) — pass through as-is
    if (byte >= 0x80) {
      this.screen.putChar(String.fromCharCode(byte));
      return true;
    }

    // Other control chars: ignore
    return false;
  }

  /** Process a byte after ESC */
  private processEsc(byte: number): boolean {
    this.state = State.NORMAL;

    switch (byte) {
      // ESC [ — CSI (cursor addressing)
      case 0x5B: // '['
        this.state = State.CSI;
        this.csiParams = '';
        return false;

      // ESC & — start of attribute sequence
      case 0x26: // '&'
        this.state = State.AMP;
        return false;

      // ESC J — Clear to end of display
      case 0x4A: // 'J'
        this.screen.clearToEndOfScreen();
        return true;

      // ESC K — Clear to end of line
      case 0x4B: // 'K'
        this.screen.clearToEndOfLine();
        return true;

      // ESC ) — Start protected field
      case 0x29: // ')'
        this.screen.startProtected();
        return true;

      // ESC ( — End protected field (start unprotected)
      case 0x28: // '('
        this.screen.endProtected();
        return true;

      default:
        // Unknown ESC sequence — ignore
        return false;
    }
  }

  /**
   * Process bytes inside a CSI sequence: ESC [ param ; param H
   * We accumulate digits and ';' until we see the final character.
   */
  private processCsi(byte: number): boolean {
    // Digits and semicolons are parameter characters
    if ((byte >= 0x30 && byte <= 0x39) || byte === 0x3B) {
      this.csiParams += String.fromCharCode(byte);
      return false;
    }

    // Final byte determines the command
    this.state = State.NORMAL;

    switch (byte) {
      case 0x48: // 'H' — Cursor Position (CUP)
        return this.handleCursorPosition();

      case 0x4A: // 'J' — Erase in Display (ED)
        return this.handleEraseDisplay();

      case 0x4B: // 'K' — Erase in Line (EL)
        this.screen.clearToEndOfLine();
        return true;

      default:
        // Unknown CSI command
        return false;
    }
  }

  /** Process a byte after ESC & */
  private processAmp(byte: number): boolean {
    if (byte === 0x64) { // 'd'
      this.state = State.AMP_D;
      return false;
    }

    // Unknown ESC & X sequence
    this.state = State.NORMAL;
    return false;
  }

  /** Process the attribute code byte after ESC & d */
  private processAmpD(byte: number): boolean {
    this.state = State.NORMAL;
    this.screen.setAttrFromCode(byte);
    return true;
  }

  /** Handle CSI cursor position: ESC [ row ; col H */
  private handleCursorPosition(): boolean {
    const parts = this.csiParams.split(';');
    // Parameters are 1-based; default to 1 if missing
    const row = (parts[0] ? parseInt(parts[0], 10) : 1) - 1;
    const col = (parts[1] ? parseInt(parts[1], 10) : 1) - 1;
    this.screen.setCursor(row, col);
    return true;
  }

  /** Handle CSI erase display: ESC [ n J */
  private handleEraseDisplay(): boolean {
    const param = this.csiParams ? parseInt(this.csiParams, 10) : 0;

    switch (param) {
      case 0:
        // Clear from cursor to end of screen
        this.screen.clearToEndOfScreen();
        return true;
      case 1: {
        // Clear from start of screen to cursor
        const end = this.screen.offset(this.screen.cursorRow, this.screen.cursorCol) + 1;
        for (let i = 0; i < end && i < this.screen.size; i++) {
          this.screen.buffer[i] = ' ';
        }
        return true;
      }
      case 2:
        // Clear entire screen
        this.screen.clear();
        return true;
      default:
        return false;
    }
  }

  /** Handle tab: move to next unprotected field or next tab stop */
  private handleTab(): void {
    // If we have fields, tab to the next unprotected field
    if (this.screen.fields.length > 0) {
      const curOff = this.screen.offset(this.screen.cursorRow, this.screen.cursorCol);
      // Find the next unprotected field after cursor
      let best: { row: number; col: number } | null = null;
      let bestOff = Infinity;
      let wrapBest: { row: number; col: number } | null = null;
      let wrapBestOff = Infinity;

      for (const field of this.screen.fields) {
        if (field.isProtected) continue;
        const fOff = this.screen.offset(field.row, field.col);
        if (fOff > curOff && fOff < bestOff) {
          bestOff = fOff;
          best = { row: field.row, col: field.col };
        }
        if (fOff < wrapBestOff) {
          wrapBestOff = fOff;
          wrapBest = { row: field.row, col: field.col };
        }
      }

      const target = best || wrapBest;
      if (target) {
        this.screen.setCursor(target.row, target.col);
        return;
      }
    }

    // No fields — use tab stops every 8 columns
    const nextTab = (Math.floor(this.screen.cursorCol / 8) + 1) * 8;
    if (nextTab < this.screen.cols) {
      this.screen.cursorCol = nextTab;
    } else {
      this.screen.cursorCol = 0;
      this.screen.cursorRow = (this.screen.cursorRow + 1) % this.screen.rows;
    }
  }
}
