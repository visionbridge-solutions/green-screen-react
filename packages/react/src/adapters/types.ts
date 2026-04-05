// Re-export shared wire-format types
export type {
  ProtocolType,
  Field,
  FieldColor,
  FieldValue,
  Window,
  SelectionChoice,
  SelectionField,
  CellExtAttr,
  ScreenData,
  ConnectionStatus,
  ConnectConfig,
} from 'green-screen-types';

// Import for use in this file
import type { ScreenData, ConnectionStatus, ConnectConfig, FieldValue } from 'green-screen-types';

/**
 * Alias for backward compatibility — consumers may import TerminalProtocol.
 */
export type { ProtocolType as TerminalProtocol } from 'green-screen-types';

/**
 * Protocol-specific color/rendering conventions.
 */
export interface ProtocolColorProfile {
  /** CSS class for a row based on its index and content */
  getRowColorClass(rowIndex: number, rowContent: string, totalRows: number): string;
  /** Parse the header row into colored segments, or null for default rendering */
  parseHeaderRow(line: string): { text: string; colorClass: string }[] | null;
}

/**
 * Protocol profile — configures terminal behavior per legacy system type.
 */
export interface ProtocolProfile {
  /** Protocol identifier */
  protocol: string;
  /** Human-readable name */
  displayName: string;
  /** Default terminal dimensions */
  defaultRows: number;
  defaultCols: number;
  /** Color/rendering profile */
  colors: ProtocolColorProfile;
  /** Header label shown in terminal chrome */
  headerLabel: string;
  /** Boot loader default text */
  bootText: string;
}

/**
 * Result from a send operation (text or key).
 */
export interface SendResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Updated cursor row after the operation */
  cursor_row?: number;
  /** Updated cursor column after the operation */
  cursor_col?: number;
  /** Updated screen content after the operation (for key presses that change screens) */
  content?: string;
  /** Updated screen signature */
  screen_signature?: string;
  /** Error message on failure */
  error?: string;
}

/**
 * Adapter interface for terminal communication.
 *
 * Implement this interface to connect the terminal component to your backend.
 * The package ships a `RestAdapter` for HTTP-based backends.
 */
export interface TerminalAdapter {
  /** Fetch the current screen content */
  getScreen(): Promise<ScreenData | null>;
  /** Fetch the current connection status */
  getStatus(): Promise<ConnectionStatus>;
  /** Send text input to the terminal */
  sendText(text: string): Promise<SendResult>;
  /** Send a special key (ENTER, F1-F24, TAB, etc.) */
  sendKey(key: string): Promise<SendResult>;
  /** Set cursor position (click-to-position) */
  setCursor?(row: number, col: number): Promise<SendResult>;
  /**
   * Read the current values of input fields, optionally restricted to the
   * ones whose per-field modified-data-tag (MDT) bit is set. Used for cheap
   * post-write verification: after entering a batch of field values, the
   * caller can confirm what actually landed without re-reading the entire
   * screen. Protocols without per-field MDT (VT, HP6530) return an empty
   * array. Optional — adapters without this capability may omit it.
   */
  readMdt?(modifiedOnly?: boolean): Promise<FieldValue[]>;
  /** Establish a connection, optionally with sign-in config */
  connect(config?: ConnectConfig): Promise<SendResult>;
  /** Close the connection */
  disconnect(): Promise<SendResult>;
  /** Reconnect to the host */
  reconnect(): Promise<SendResult>;
}
