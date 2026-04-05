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
  /** Whether the field is non-display (hidden input, e.g. password fields) */
  is_non_display?: boolean;
  /** 5250 display color derived from the field attribute byte */
  color?: FieldColor;
  /**
   * Highlight-on-entry attribute byte (FCW 0x89xx). When the cursor is
   * inside this field, the frontend should apply this attribute instead of
   * the field's base attribute. Reverts on cursor exit. Per lib5250
   * session.c:1647-1649.
   */
  highlight_entry_attr?: number;
  /**
   * Resequence number (FCW 0x80xx) — non-zero gives a custom tab-order
   * index. Fields are visited in ascending resequence order before
   * falling back to spatial order. Per lib5250 session.c:1577-1579.
   */
  resequence?: number;
  /**
   * Cursor progression id (FCW 0x88xx) — alternate cursor-progression
   * target ID. Per lib5250 session.c:1643-1645.
   */
  progression_id?: number;
  /**
   * Pointer AID (FCW 0x8Axx) — AID byte sent on mouse click inside this
   * field, as an alternative to requiring a function key.
   */
  pointer_aid?: number;
  /** Field requires DBCS (double-byte) input — e.g. Japanese Kanji. */
  is_dbcs?: boolean;
  /** Field allows DBCS or SBCS input (FCW 0x8240). */
  is_dbcs_either?: boolean;
  /** Field has MOD10 self-check validation (FCW 0xB1A0). */
  self_check_mod10?: boolean;
  /** Field has MOD11 self-check validation (FCW 0xB140). */
  self_check_mod11?: boolean;
  /**
   * 5250 shift-type (lower 3 bits of FFW1) — constrains what characters
   * the operator may type into this input field. Per 5250 Functions Reference:
   *   'alpha'         — alpha shift, any char allowed
   *   'alpha_only'    — letters + comma/dash/period/space only
   *   'numeric_shift' — numeric shift (display), any char still allowed
   *   'numeric_only'  — digits + sign + comma/period/dash/space
   *   'katakana'      — katakana shift (Japanese)
   *   'digits_only'   — digits 0-9 only, no sign
   *   'io'            — I/O field (unused on display)
   *   'signed_num'    — signed numeric, last position is sign indicator
   */
  shift_type?: 'alpha' | 'alpha_only' | 'numeric_shift' | 'numeric_only' | 'katakana' | 'digits_only' | 'io' | 'signed_num';
  /** Monocase field (FFW2 bit 0x20) — input is auto-converted to upper case. */
  monocase?: boolean;
  /**
   * Modified Data Tag (MDT) — true when the operator has typed into this
   * input field since the last host read. Mirrors the 5250 per-field MDT bit
   * (set on any keystroke into the field, cleared by CC1 `reset MDT` mask or
   * a host-driven MDT reset). Useful for:
   *   - cheap post-write verification (read only the fields the client just
   *     wrote to instead of diffing the entire screen)
   *   - diagnostic inspection of which fields actually captured input before
   *     an AID was sent
   * Only meaningful for input fields; absent on protected fields.
   */
  modified?: boolean;
}

/**
 * A single (row,col) → value readout used by the MDT read primitive.
 * The `value` is the current text content of the field's cell range after
 * any monocase/validation transforms the proxy may have applied.
 */
export interface FieldValue {
  /** Field row (0-based) */
  row: number;
  /** Field col (0-based) */
  col: number;
  /** Field length in characters */
  length: number;
  /** Current text content of the field (length chars, may be padded). */
  value: string;
  /** Whether the field has its MDT bit set at read time. */
  modified: boolean;
}

/** Window metadata from CREATE_WINDOW or synthesized from SAVE_SCREEN */
export interface Window {
  /** 0-based row of border top-left */
  row: number;
  /** 0-based col of border top-left */
  col: number;
  /** Content height (rows inside border) */
  height: number;
  /** Content width (columns inside border) */
  width: number;
  /** Title text from Window Title minor structure (if provided by host) */
  title?: string;
  /** Footer text from Window Footer minor structure (if provided by host) */
  footer?: string;
}

/** A single choice within a selection field */
export interface SelectionChoice {
  text: string;
  row: number;
  col: number;
}

/**
 * Per-cell extended attribute from WEA (Write Extended Attribute) orders.
 * Any field can be undefined meaning "inherit from the base field attribute".
 * Per 5250 Functions Reference WEA order types.
 */
export interface CellExtAttr {
  /** Extended color byte (0 = inherit). */
  color?: number;
  /** Extended highlight byte (underscore/reverse/blink/col-sep). */
  highlight?: number;
  /** Character set id. */
  char_set?: number;
}

/** Selection field from DEFINE_SELECTION_FIELD (menus, radio buttons, choice lists) */
export interface SelectionField {
  row: number;
  col: number;
  /** Number of visible rows for this selection field */
  num_rows: number;
  /** Width of each choice text */
  num_cols: number;
  choices: SelectionChoice[];
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
  /** Whether insert mode is active (vs overwrite mode) */
  insert_mode?: boolean;
  /** Active popup windows (from CREATE_WINDOW or synthesized); absent when no popup */
  windows?: Window[];
  /** Selection fields defined by host (menus, radio buttons, choice lists); absent when none */
  selection_fields?: SelectionField[];
  /** Number of screens on the save/restore stack (0 = no popup) */
  screen_stack_depth?: number;
  /** True when a popup window is active (screen_stack_depth > 0) */
  is_popup?: boolean;
  /**
   * Per-cell extended attributes set via WEA (Write Extended Attribute)
   * orders. Sparse — only cells with non-default extended attributes are
   * present (keyed by `row * cols + col`).
   */
  ext_attrs?: Record<number, CellExtAttr>;
  /**
   * Offsets of cells holding the second half of a DBCS (double-byte) Kanji
   * character. The preceding cell contains the rendered glyph; these cells
   * are blank and should be rendered as spacers to preserve layout.
   */
  dbcs_cont?: number[];
  /** EBCDIC single-byte code page in use (e.g. 'cp37', 'cp290'). */
  code_page?: string;
}

/**
 * Connection status sent from the proxy to the client.
 */
export interface ConnectionStatus {
  /** Whether a TCP connection is established */
  connected: boolean;
  /** Current connection state */
  status: 'disconnected' | 'connecting' | 'connected' | 'authenticated' | 'error' | 'loading';
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
  /** Terminal type for negotiation (e.g. 'IBM-3179-2', 'IBM-3477-FC', 'IBM-5555-C01') */
  terminalType?: string;
  /**
   * EBCDIC single-byte code page for character translation.
   * - 'cp37'  (default) — US/Canada/Brazil/AU/NZ
   * - 'cp290' — Japan Katakana (paired with SO/SI for full DBCS Kanji)
   * If omitted, the proxy derives it from the terminal type.
   */
  codePage?: 'cp37' | 'cp290';
}
