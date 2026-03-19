/**
 * green-screen-types
 *
 * Shared type definitions for the wire protocol between
 * green-screen-proxy and green-screen-react.
 */

/**
 * Supported terminal protocol types.
 */
export type ProtocolType = 'tn5250' | 'tn3270' | 'vt' | 'hp6530';

/**
 * Field definition from the terminal data stream.
 * Describes an input or protected field on the terminal screen.
 */
/** 5250 display color derived from field attribute byte */
export type FieldColor = 'green' | 'white' | 'red' | 'turquoise' | 'yellow' | 'pink' | 'blue';

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
  /** Whether the field has the underscore display attribute (visible underline) */
  is_underscored?: boolean;
  /** 5250 display color derived from the field attribute byte */
  color?: FieldColor;
}

/**
 * Screen data — the canonical representation of the terminal screen
 * sent from the proxy to the client over WebSocket/REST.
 */
export interface ScreenData {
  /** Screen content as newline-separated text (e.g. 24 lines of 80 chars) */
  content: string;
  /** 0-based cursor row */
  cursor_row: number;
  /** 0-based cursor column */
  cursor_col: number;
  /** Number of rows */
  rows: number;
  /** Number of columns */
  cols: number;
  /** Field definitions on the current screen */
  fields: Field[];
  /** Unique identifier for the current screen state */
  screen_signature: string;
  /** ISO timestamp of when this screen was captured */
  timestamp: string;
  /** Whether the keyboard is locked by the host (X SYSTEM indicator) */
  keyboard_locked?: boolean;
  /** Whether the message waiting indicator is set */
  message_waiting?: boolean;
  /** Whether the host requested an audible alarm (beep) */
  alarm?: boolean;
}

/**
 * Connection status sent from the proxy to the client.
 */
export interface ConnectionStatus {
  /** Whether a TCP connection is established */
  connected: boolean;
  /** Current connection state */
  status: 'disconnected' | 'connecting' | 'connected' | 'authenticated' | 'error';
  /** Terminal protocol in use */
  protocol?: ProtocolType;
  /** Host address */
  host?: string;
  /** Authenticated username */
  username?: string;
  /** Error message if status is 'error' */
  error?: string;
}

/**
 * Configuration sent from the client to the proxy to establish a connection.
 */
export interface ConnectConfig {
  /** Target host address */
  host: string;
  /** Target port (optional, proxy defaults per protocol) */
  port?: number;
  /** Terminal protocol */
  protocol: ProtocolType;
  /** Username for authentication (optional — skips autoSignIn if empty) */
  username?: string;
  /** Password for authentication (optional — skips autoSignIn if empty) */
  password?: string;
  /** Terminal type for negotiation (e.g. 'IBM-3179-2', 'IBM-3477-FC') */
  terminalType?: string;
}
