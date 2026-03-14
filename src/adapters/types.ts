/**
 * Supported terminal protocol types.
 */
export type TerminalProtocol = 'tn5250' | 'tn3270' | 'vt' | 'hp6530';

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
  protocol: TerminalProtocol;
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
 * Field definition from the terminal data stream.
 * Describes an input or protected field on the terminal screen.
 */
export interface Field {
  /** 0-based row index */
  row: number;
  /** 0-based column index */
  col: number;
  /** Field length in characters */
  length: number;
  /** Whether the field accepts user input */
  is_input: boolean;
  /** Whether the field is protected (read-only) */
  is_protected: boolean;
  /** Whether the field is displayed with high intensity (bright/white) */
  is_highlighted?: boolean;
  /** Whether the field is displayed in reverse video */
  is_reverse?: boolean;
}

/**
 * Screen data returned by the adapter.
 * Represents the current state of the terminal screen.
 */
export interface ScreenData {
  /** Screen content as newline-separated text (e.g. 24 lines of 80 chars) */
  content: string;
  /** 0-based cursor row */
  cursor_row: number;
  /** 0-based cursor column */
  cursor_col: number;
  /** Number of rows (default 24) */
  rows?: number;
  /** Number of columns (default 80) */
  cols?: number;
  /** Field definitions on the current screen */
  fields?: Field[];
  /** Unique identifier for the current screen state */
  screen_signature?: string;
  /** ISO timestamp of when this screen was captured */
  timestamp?: string;
}

/**
 * Connection status information.
 */
export interface ConnectionStatus {
  /** Whether a TCP connection is established */
  connected: boolean;
  /** Current connection state */
  status: 'disconnected' | 'connecting' | 'connected' | 'authenticated' | 'error';
  /** Terminal protocol in use */
  protocol?: TerminalProtocol;
  /** Host address */
  host?: string;
  /** Authenticated username */
  username?: string;
  /** Error message if status is 'error' */
  error?: string;
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
  /** Establish a connection, optionally with sign-in config */
  connect(config?: ConnectConfig): Promise<SendResult>;
  /** Close the connection */
  disconnect(): Promise<SendResult>;
  /** Reconnect to the host */
  reconnect(): Promise<SendResult>;
}

/**
 * Configuration passed from the inline sign-in form to adapter.connect().
 */
export interface ConnectConfig {
  /** Target host address */
  host: string;
  /** Target port (optional, adapter/server can default per protocol) */
  port?: number;
  /** Terminal protocol */
  protocol: TerminalProtocol;
  /** Username for authentication */
  username: string;
  /** Password for authentication */
  password: string;
}

/** @deprecated Use `TerminalAdapter` instead */
export type TN5250Adapter = TerminalAdapter;
