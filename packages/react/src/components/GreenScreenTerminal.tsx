import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import type { TerminalAdapter, ScreenData, ConnectionStatus, Field, TerminalProtocol, ProtocolProfile, ConnectConfig } from '../adapters/types';
import { RestAdapter } from '../adapters/RestAdapter';
import { WebSocketAdapter } from '../adapters/WebSocketAdapter';
import { useAutoReconnect } from '../hooks/useAutoReconnect';
import { useTerminalState } from '../hooks/useTerminalState';
import { getProtocolProfile } from '../protocols/registry';
import { TerminalBootLoader as DefaultBootLoader } from './TerminalBootLoader';
import { TerminalIcon, WifiIcon, WifiOffIcon, AlertTriangleIcon, RefreshIcon, KeyIcon, MinimizeIcon, KeyboardIcon, UnplugIcon } from './Icons';
import { InlineSignIn } from './InlineSignIn';
import { decodeAttrByte, decodeExtColor, decodeExtHighlight, cssVarForColor, mergeExtAttr, extColorIsReverse } from '../utils/attribute';
import { validateMod10, validateMod11, filterFieldInput } from '../utils/validation';

/** Format milliseconds as M:SS for the X CLOCK busy indicator. */
function formatBusyClock(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Map a 5250 AID byte (e.g. from a pointer-AID FCW) back to the key-name
 * token that `sendKey` understands. Covers Enter, F1-F24, Page Up/Down,
 * Clear, Help, and Print. Returns null for unknown/unsupported AIDs.
 */
function aidByteToKeyName(aid: number): string | null {
  if (aid === 0xF1) return 'ENTER';
  if (aid === 0xF3) return 'HELP';
  if (aid === 0xF4) return 'PAGEUP';
  if (aid === 0xF5) return 'PAGEDOWN';
  if (aid === 0xF6) return 'PRINT';
  if (aid === 0xBD) return 'CLEAR';
  // F1..F12 → 0x31..0x3C
  if (aid >= 0x31 && aid <= 0x3C) return `F${aid - 0x30}`;
  // F13..F24 → 0xB1..0xBC
  if (aid >= 0xB1 && aid <= 0xBC) return `F${aid - 0xB0 + 12}`;
  return null;
}

/**
 * Compute the portion of a field that falls on a given row, handling
 * wrap-around for multi-row fields (common on IBM i command lines where a
 * single field spans 2-3 rows). Returns null if the field doesn't touch
 * this row. Otherwise returns { col, length } for the slice on this row.
 *
 * Example: field at (row 19, col 7, length 153) with cols=80:
 *   row 19 → { col: 7, length: 73 }   (73 chars: col 7..79)
 *   row 20 → { col: 0, length: 80 }   (next 80 chars: col 0..79)
 *   row 21 → null (len 73+80=153 exhausted)
 */
function fieldSliceForRow(
  field: { row: number; col: number; length: number },
  rowIndex: number,
  cols: number,
): { col: number; length: number } | null {
  const rowDelta = rowIndex - field.row;
  if (rowDelta < 0) return null;
  const offsetFromStart = rowDelta === 0 ? 0 : (cols - field.col) + (rowDelta - 1) * cols;
  if (offsetFromStart >= field.length) return null;
  const sliceCol = rowDelta === 0 ? field.col : 0;
  const sliceLen = Math.min(cols - sliceCol, field.length - offsetFromStart);
  if (sliceLen <= 0) return null;
  return { col: sliceCol, length: sliceLen };
}

/* ── No-op adapter (placeholder before connection) ───────────────── */

const noopResult = { success: false, error: 'No adapter configured' };
const noopAdapter: TerminalAdapter = {
  getScreen: async () => null,
  getStatus: async () => ({ connected: false, status: 'disconnected' }),
  sendText: async () => noopResult,
  sendKey: async () => noopResult,
  setCursor: async () => noopResult,
  connect: async () => noopResult,
  disconnect: async () => noopResult,
  reconnect: async () => noopResult,
};

/* ── Component Props ──────────────────────────────────────────────── */

/** State passed to the header render prop */
export interface TerminalHeaderState {
  connectionStatus: ConnectionStatus | null;
  keyboardLocked: boolean;
  insertMode: boolean;
  isFocused: boolean;
  reconnect: () => void;
  reconnecting: boolean;
}

export interface GreenScreenTerminalProps {
  /** Adapter for communicating with the terminal backend (optional — auto-created from sign-in form or baseUrl) */
  adapter?: TerminalAdapter;
  /** Base URL for the terminal API — convenience shorthand that auto-creates a RestAdapter */
  baseUrl?: string;
  /** Worker/proxy WebSocket URL — convenience shorthand that auto-creates a WebSocketAdapter */
  workerUrl?: string;
  /** Terminal protocol (determines color conventions, header label, etc.) */
  protocol?: TerminalProtocol;
  /** Custom protocol profile (overrides protocol param) */
  protocolProfile?: ProtocolProfile;
  /** Direct screen data injection (bypasses polling) */
  screenData?: ScreenData | null;
  /** Direct connection status injection */
  connectionStatus?: ConnectionStatus | null;

  /** Whether the terminal is read-only (no keyboard input) */
  readOnly?: boolean;
  /** Polling interval in ms (0 to disable polling; default 2000) */
  pollInterval?: number;
  /** Whether to auto-reconnect on disconnect (default true) */
  autoReconnect?: boolean;
  /** Max auto-reconnect attempts (default 5) */
  maxReconnectAttempts?: number;

  /** Compact embedded mode */
  embedded?: boolean;
  /** Show the header bar (default true) */
  showHeader?: boolean;
  /** Custom header: ReactNode, render prop with terminal state, or false to hide.
   *  When provided, overrides showHeader/embedded/headerRight/statusActions. */
  header?: React.ReactNode | ((state: TerminalHeaderState) => React.ReactNode) | false;
  /** Enable typing animation (default false) */
  typingAnimation?: boolean;
  /** Typing animation budget in ms (default 60) */
  typingBudgetMs?: number;

  /** Auto-create a default WebSocketAdapter when no adapter/baseUrl/workerUrl is provided (default true) */
  autoConnect?: boolean;
  /** Show inline sign-in form when disconnected (default true) */
  inlineSignIn?: boolean;
  /** Default protocol for the sign-in form dropdown (default 'tn5250') */
  defaultProtocol?: TerminalProtocol;
  /** Callback when sign-in form is submitted */
  onSignIn?: (config: ConnectConfig) => void;
  /** Disable auto-focus on the terminal after connecting (default false) */
  autoFocusDisabled?: boolean;

  /** Custom boot loader element, or false to disable */
  bootLoader?: React.ReactNode | false;
  /** When true, dismiss the boot loader. If provided, overrides the default
   *  "dismiss when screen data arrives" behavior. Use to keep the boot loader
   *  visible during sign-in, startup command execution, etc. */
  bootLoaderReady?: boolean;
  /** Content for the right side of the header */
  headerRight?: React.ReactNode;
  /** Content rendered after the connection status groups (WiFi+host, Key+username) */
  statusActions?: React.ReactNode;
  /** Overlay content (e.g. "Extracting..." state) */
  overlay?: React.ReactNode;
  /** Callback for notifications (replaces toast) */
  onNotification?: (message: string, type: 'info' | 'error') => void;
  /** Callback when screen content changes */
  onScreenChange?: (screen: ScreenData) => void;
  /** Callback fired after the terminal's built-in disconnect button is clicked
   *  and the adapter has disconnected. Use to clean up external state
   *  (session storage, parent component state, etc.). */
  onDisconnect?: () => void;
  /** Callback for minimize action (embedded mode) */
  onMinimize?: () => void;
  /** Show the keyboard-shortcuts button in the header (default true) */
  showShortcutsButton?: boolean;

  /** Persist focus state to localStorage across page reloads (default true) */
  persistFocus?: boolean;

  /** When true, the terminal treats itself as always focused:
   *   (a) clicks outside the terminal don't unfocus it (click-outside
   *       handler is disabled);
   *   (b) any document-level keydown that lands on a non-form element
   *       refocuses the hidden input so keystrokes flow to the terminal.
   *
   *  Use this for single-terminal host pages where the user should never
   *  need to click back into the terminal to keep typing. When there are
   *  other editable controls on the page (form fields, editors), keep this
   *  off and let the regular click-to-focus model decide. */
  alwaysFocused?: boolean;

  /** Built-in visual theme preset. Applied as a `gs-theme-*` class on the
   *  root `.gs-terminal` element so CSS variables resolve to theme-specific
   *  values. Integrators can also override individual CSS variables directly
   *  on a parent element for fully custom palettes. Default: 'modern'. */
  theme?: 'modern' | 'classic';

  /** Additional CSS class name */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

/**
 * GreenScreenTerminal — Multi-protocol legacy terminal emulator component.
 *
 * Renders a terminal screen with:
 * - Green-on-black terminal aesthetic with protocol-specific color conventions
 * - Connection status indicator
 * - Keyboard input support (text, function keys, tab)
 * - Auto-reconnect with exponential backoff
 * - Typing animation for field entries
 * - Focus lock mode for keyboard capture
 *
 * Supports: TN5250 (IBM i), TN3270 (z/OS), VT (OpenVMS/Pick), HP 6530 (NonStop)
 */
export function GreenScreenTerminal({
  adapter: externalAdapter,
  baseUrl,
  workerUrl,
  protocol,
  protocolProfile: customProfile,
  screenData: externalScreenData,
  connectionStatus: externalStatus,
  readOnly = false,
  pollInterval = 2000,
  autoReconnect: autoReconnectEnabled = true,
  maxReconnectAttempts: maxAttempts = 5,
  embedded = false,
  showHeader = true,
  header,
  typingAnimation = false,
  typingBudgetMs = 60,
  autoConnect = true,
  inlineSignIn = true,
  defaultProtocol: signInDefaultProtocol,
  onSignIn,
  autoFocusDisabled = false,
  bootLoader,
  bootLoaderReady,
  headerRight,
  statusActions,
  overlay,
  onNotification,
  onScreenChange,
  onDisconnect,
  onMinimize,
  showShortcutsButton = true,
  persistFocus = true,
  alwaysFocused = false,
  theme = 'modern',
  className,
  style,
}: GreenScreenTerminalProps) {
  const profile = customProfile ?? getProtocolProfile(protocol);

  // --- Resolve adapter: explicit > baseUrl > workerUrl > default WebSocket > noop ---
  const baseUrlAdapter = useMemo(
    () => baseUrl ? new RestAdapter({ baseUrl }) : null,
    [baseUrl],
  );
  const workerUrlAdapter = useMemo(
    () => workerUrl ? new WebSocketAdapter({ workerUrl }) : null,
    [workerUrl],
  );
  // Default WebSocketAdapter (auto-detects env vars, falls back to localhost:3001) when no adapter is configured
  const defaultWsAdapter = useMemo(
    () => (autoConnect && !externalAdapter && !baseUrl && !workerUrl) ? new WebSocketAdapter() : null,
    [autoConnect, externalAdapter, baseUrl, workerUrl],
  );
  const adapter = externalAdapter ?? baseUrlAdapter ?? workerUrlAdapter ?? defaultWsAdapter ?? noopAdapter;
  const isUsingDefaultAdapter = adapter === defaultWsAdapter;

  // --- Core terminal state (screen data, connection, busy overlay) ---
  const {
    screenData,
    rawScreenData,
    connectionStatus: connStatus,
    sendText,
    sendKey,
    connect,
    reconnect,
    reconnecting,
    connectError,
    screenError,
    showBusyOverlay,
    busyElapsedMs: lockElapsedMs,
    animatedCursorPos,
  } = useTerminalState({
    adapter,
    pollInterval,
    externalScreenData,
    externalStatus,
    typingAnimation,
    typingBudgetMs,
    onScreenChange,
  });

  // --- Optimistic edits ---
  // Characters typed by the user are applied optimistically to the displayed
  // content before the proxy responds. Cleared on full screen updates.
  const [optimisticEdits, setOptimisticEdits] = useState<Array<{ row: number; col: number; ch: string }>>([]);
  const prevScreenContentForEdits = useRef<string | undefined>(undefined);
  useEffect(() => {
    // Clear optimistic edits whenever the screen content changes (not just signature).
    // This prevents stale keystrokes from persisting across screen transitions when
    // the adapter talks to the proxy directly and the WS broadcast hasn't caught up.
    const content = rawScreenData?.content;
    if (content && content !== prevScreenContentForEdits.current) {
      prevScreenContentForEdits.current = content;
      setOptimisticEdits([]);
    }
  }, [rawScreenData?.content]);

  // --- UI State ---
  const [inputText, setInputText] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [fkeyPage, setFkeyPage] = useState(0); // 0 = F1-F12, 1 = F13-F24
  // Draggable shortcuts panel: position is viewport-relative (position: fixed).
  // Null until the panel first opens; then seeded from terminal bottom-right.
  const [shortcutsPos, setShortcutsPos] = useState<{ x: number; y: number } | null>(null);
  const [isDraggingShortcuts, setIsDraggingShortcuts] = useState(false);
  const shortcutsDragOffsetRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const shortcutsPanelRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [syncedCursor, setSyncedCursor] = useState<{ row: number; col: number } | null>(null);
  // Optimistic keyboard lock — set instantly when the user presses a submit
  // key (Enter/F-key/PageUp/PageDown) so the X II badge appears without
  // waiting for the proxy's round-trip. Cleared when rawScreenData content
  // changes (meaning the proxy has responded with a new screen).
  const [optimisticLock, setOptimisticLock] = useState(false);
  const prevRawContentRef = useRef('');

  useEffect(() => {
    const newContent = rawScreenData?.content || '';
    if (prevRawContentRef.current && newContent && newContent !== prevRawContentRef.current) {
      setSyncedCursor(null);
      setInputText('');
      setOptimisticLock(false);
    }
    prevRawContentRef.current = newContent;
  }, [rawScreenData?.content]);

  // --- Auto-reconnect ---
  const {
    attempt: autoReconnectAttempt,
    isReconnecting: isAutoReconnecting,
    reset: resetAutoReconnect,
  } = useAutoReconnect(
    connStatus?.connected ?? false,
    reconnecting,
    reconnect,
    { enabled: autoReconnectEnabled, maxAttempts: maxAttempts, onNotification },
  );

  // --- Inline sign-in ---
  const [connecting, setConnecting] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const handleSignIn = useCallback(async (config: ConnectConfig) => {
    // If the caller provided onSignIn, let them handle connection setup
    if (onSignIn) {
      onSignIn(config);
      return;
    }
    setConnecting(true);
    setSignInError(null);
    try {
      await connect(config);
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : String(err));
      setConnecting(false);
    }
    // Note: connecting is cleared by the screenData effect below, not here —
    // the connect() promise may resolve before the screen is actually ready.
  }, [connect, onSignIn]);

  // Clear connecting state when screen data arrives or connection is confirmed
  useEffect(() => {
    if (connecting && screenData?.content) setConnecting(false);
  }, [connecting, screenData?.content]);

  // --- Boot loader ---
  const [showBootLoader, setShowBootLoader] = useState(bootLoader !== false);
  const [bootFadingOut, setBootFadingOut] = useState(false);

  useEffect(() => {
    if (!showBootLoader) return;
    // If bootLoaderReady is provided, only dismiss when it becomes true.
    // Otherwise fall back to dismissing when screen data arrives.
    const shouldDismiss = bootLoaderReady !== undefined
      ? bootLoaderReady
      : !!screenData?.content;
    if (shouldDismiss) {
      setBootFadingOut(true);
      setShowBootLoader(false);
      const timer = setTimeout(() => setBootFadingOut(false), 400);
      return () => clearTimeout(timer);
    }
  }, [screenData?.content, showBootLoader, bootLoaderReady]);

  // --- Focus management ---
  const FOCUS_STORAGE_KEY = 'gs-terminal-focused';

  // Restore focus from localStorage on mount (if auto-focus enabled and persistence enabled)
  useEffect(() => {
    if (!autoFocusDisabled && !readOnly && persistFocus) {
      try {
        if (localStorage.getItem(FOCUS_STORAGE_KEY) === 'true') {
          setIsFocused(true);
        }
      } catch { /* localStorage unavailable */ }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist focus state to localStorage
  useEffect(() => {
    if (autoFocusDisabled || !persistFocus) return;
    try { localStorage.setItem(FOCUS_STORAGE_KEY, String(isFocused)); } catch { /* noop */ }
  }, [isFocused, autoFocusDisabled, persistFocus]);

  // Sync DOM focus with isFocused state
  useEffect(() => {
    if (isFocused) inputRef.current?.focus();
  }, [isFocused]);

  // Auto-focus terminal when screen data arrives (i.e. connected)
  const hadScreenData = useRef(false);
  useEffect(() => {
    if (screenData?.content && !hadScreenData.current && !autoFocusDisabled && !readOnly) {
      hadScreenData.current = true;
      setIsFocused(true);
    }
    if (!screenData?.content) hadScreenData.current = false;
  }, [screenData?.content, autoFocusDisabled, readOnly]);

  useEffect(() => {
    // Skip click-outside unfocus when alwaysFocused is on — the terminal
    // stays "focused" regardless of where the user clicks.
    if (alwaysFocused) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setIsFocused(false);
    };
    if (isFocused) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isFocused, alwaysFocused]);

  // alwaysFocused: aggressively steer keyboard focus to the terminal input.
  // Keeps typing flowing into the terminal even after the user clicks on a
  // non-form area of the page (e.g. the theme sticker, the demo footer,
  // or empty space around the terminal). Form controls (input/select/etc)
  // are whitelisted so the user can still interact with other UI — only
  // "inert" page clicks get hijacked.
  useEffect(() => {
    if (!alwaysFocused || readOnly) return;
    const isFormTarget = (el: Element | null): boolean => {
      if (!el) return false;
      return !!el.closest('input, select, textarea, button, a, [contenteditable="true"]');
    };
    const refocusInput = () => {
      const input = inputRef.current;
      if (input && document.activeElement !== input) input.focus();
      setIsFocused(true);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (isFormTarget(e.target as Element)) return;
      // setTimeout so the click event can still fire its own handlers first.
      setTimeout(refocusInput, 0);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isFormTarget(e.target as Element)) return;
      refocusInput();
    };
    // Initial focus on mount
    refocusInput();
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [alwaysFocused, readOnly]);

  useEffect(() => {
    if (readOnly && isFocused) { setIsFocused(false); inputRef.current?.blur(); }
  }, [readOnly, isFocused]);

  // --- Shortcuts panel: seed initial position & track drag ---
  // Seed position from the terminal's bottom-right corner on first open
  // (matches the prior absolute-positioned layout). Uses useLayoutEffect so
  // the panel paints in its final spot without a flash at (0,0).
  useLayoutEffect(() => {
    if (showShortcuts && !shortcutsPos && shortcutsPanelRef.current && containerRef.current) {
      const tRect = containerRef.current.getBoundingClientRect();
      const pRect = shortcutsPanelRef.current.getBoundingClientRect();
      const margin = 12;
      const x = Math.max(0, Math.min(tRect.right - pRect.width - margin, window.innerWidth - pRect.width));
      const y = Math.max(0, Math.min(tRect.bottom - pRect.height - margin, window.innerHeight - pRect.height));
      setShortcutsPos({ x, y });
    }
  }, [showShortcuts, shortcutsPos]);

  // Reset saved position when the panel closes so the next open re-seeds
  // from the current terminal location (handles layout changes between opens).
  useEffect(() => {
    if (!showShortcuts) setShortcutsPos(null);
  }, [showShortcuts]);

  // Track dragging — attach document-level listeners while a drag is active
  // so the drag continues even if the cursor leaves the panel.
  useEffect(() => {
    if (!isDraggingShortcuts) return;
    const onMove = (e: MouseEvent) => {
      const panel = shortcutsPanelRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      const nextX = e.clientX - shortcutsDragOffsetRef.current.dx;
      const nextY = e.clientY - shortcutsDragOffsetRef.current.dy;
      // Clamp inside viewport bounds
      const maxX = window.innerWidth - rect.width;
      const maxY = window.innerHeight - rect.height;
      setShortcutsPos({
        x: Math.max(0, Math.min(nextX, maxX)),
        y: Math.max(0, Math.min(nextY, maxY)),
      });
    };
    const onUp = () => setIsDraggingShortcuts(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [isDraggingShortcuts]);

  const startShortcutsDrag = useCallback((e: React.MouseEvent) => {
    const panel = shortcutsPanelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    shortcutsDragOffsetRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    setIsDraggingShortcuts(true);
    e.preventDefault();
  }, []);

  const screenContentRef = useRef<HTMLDivElement>(null);
  const charWidthRef = useRef<number>(0);

  const handleTerminalClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly) return;
    setIsFocused(true);
    inputRef.current?.focus();

    // Click-to-cursor: calculate which row/col was clicked
    const contentEl = screenContentRef.current;
    if (!contentEl || !screenData?.fields) return;

    // Measure 1ch width in current font
    if (!charWidthRef.current) {
      const span = document.createElement('span');
      span.style.cssText = 'position:absolute;visibility:hidden;font:inherit;white-space:pre';
      span.textContent = 'X';
      contentEl.appendChild(span);
      charWidthRef.current = span.getBoundingClientRect().width;
      contentEl.removeChild(span);
    }

    // .gs-screen-content has padding (12px top, 16px left). Subtract it so
    // (x, y) is measured from the first character cell, not the padded box
    // edge. Without this, clicking in the lower half of a visual row maps
    // to the next row down, and the column lands 1-2 cells to the right.
    const rect = contentEl.getBoundingClientRect();
    const cs = window.getComputedStyle(contentEl);
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padTop = parseFloat(cs.paddingTop) || 0;
    const x = e.clientX - rect.left - padLeft;
    const y = e.clientY - rect.top - padTop;
    const ROW_HEIGHT = 21;
    const charWidth = charWidthRef.current;
    if (!charWidth) return;

    const clickedRow = Math.floor(y / ROW_HEIGHT);
    const clickedCol = Math.floor(x / charWidth);

    if (clickedRow < 0 || clickedRow >= (screenData.rows || 24) ||
        clickedCol < 0 || clickedCol >= (screenData.cols || 80)) return;

    // Pointer AID (FCW 0x8Axx): if the clicked field declares a pointer AID,
    // send it as a key press and skip the normal cursor-move. Per IBM 5250
    // Functions Reference this is the defined "mouse click on field" behavior.
    const clickedField = screenData.fields.find(f => {
      const slice = fieldSliceForRow(f, clickedRow, screenData.cols || profile.defaultCols);
      return !!slice && clickedCol >= slice.col && clickedCol < slice.col + slice.length;
    });
    const ptrAid = clickedField && (clickedField as any).pointer_aid as number | undefined;
    if (ptrAid) {
      // Map AID byte back to a key name. Common cases: 0xF1 ENTER, 0x31-0x3C F1-F12.
      const keyName = aidByteToKeyName(ptrAid);
      if (keyName) {
        // First move the cursor into the field so the host sees the click location
        setSyncedCursor({ row: clickedRow, col: clickedCol });
        adapter.setCursor?.(clickedRow, clickedCol).then(() => sendKey(keyName));
        return;
      }
    }

    // Set the click position optimistically and fire the proxy request.
    // Intentionally fire-and-forget — do NOT chain .then() to update
    // syncedCursor from the response. WebSocketAdapter.sendAndWaitForScreen
    // has a single pending-resolver slot: when two setCursor calls overlap,
    // the second one flushes the first's resolver with stale this.screen,
    // then the first proxy cursor message resolves the second's resolver —
    // promises get cross-wired with responses. Since the proxy's setCursor
    // is a trivial clamp (no snapping), trust the optimistic value. The
    // proxy's cursor message still updates this.screen.cursor_col for the
    // next render's fallback.
    setSyncedCursor({ row: clickedRow, col: clickedCol });
    adapter.setCursor?.(clickedRow, clickedCol);
  }, [readOnly, screenData, adapter, sendKey]);

  // --- Field helpers ---
  const getCurrentField = useCallback(() => {
    const fields = screenData?.fields || [];
    const cols = screenData?.cols || profile.defaultCols;
    const cursorRow = syncedCursor?.row ?? screenData?.cursor_row ?? 0;
    const cursorCol = syncedCursor?.col ?? screenData?.cursor_col ?? 0;
    // Use fieldSliceForRow so multi-row wrapping input fields (e.g. IBM i
    // command lines) match a cursor sitting on any of their continuation
    // rows, not just the first row.
    for (const field of fields) {
      if (!field.is_input) continue;
      const slice = fieldSliceForRow(field, cursorRow, cols);
      if (!slice) continue;
      // Inclusive trailing bound — see note in cursorInInputField.
      if (cursorCol >= slice.col && cursorCol <= slice.col + slice.length) return field;
    }
    return null;
  }, [screenData, syncedCursor, profile.defaultCols]);

  /**
   * Extract the text content of a field from the current screen display.
   * Reads from `content` using row/col so it reflects both server-committed
   * data and optimistic edits rendered on the current frame.
   */
  const readFieldValue = useCallback((field: Field): string => {
    if (!screenData?.content) return '';
    const lines = screenData.content.split('\n');
    const line = lines[field.row] || '';
    return line.substring(field.col, field.col + field.length).replace(/\s+$/, '');
  }, [screenData?.content]);

  /** Client-side self-check validation for fields declaring MOD10/MOD11 FCWs. */
  const [validationError, setValidationError] = useState<string | null>(null);
  const runSelfCheck = useCallback((): boolean => {
    const fields = screenData?.fields || [];
    for (const f of fields) {
      if (!f.is_input) continue;
      const val = readFieldValue(f);
      if (!val) continue;
      if ((f as any).self_check_mod10 && !validateMod10(val)) {
        setValidationError(`Invalid check digit (MOD10) in field at row ${f.row + 1}, col ${f.col + 1}`);
        return false;
      }
      if ((f as any).self_check_mod11 && !validateMod11(val)) {
        setValidationError(`Invalid check digit (MOD11) in field at row ${f.row + 1}, col ${f.col + 1}`);
        return false;
      }
    }
    setValidationError(null);
    return true;
  }, [screenData?.fields, readFieldValue]);

  // --- Keyboard handling ---
  // Characters are sent immediately to the proxy (no client-side buffering).
  // This keeps the proxy screen buffer in sync so arrow keys, backspace,
  // delete, and insert mode all work correctly at any cursor position.
  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (readOnly) { e.preventDefault(); return; }

    if (e.key === 'Escape') { e.preventDefault(); setIsFocused(false); inputRef.current?.blur(); return; }

    // Ctrl+R: Reset (clear keyboard lock and error line)
    if (e.ctrlKey && e.key === 'r') {
      e.preventDefault();
      setSyncedCursor(null);
      sendKey('RESET');
      return;
    }

    // Ctrl+Enter: Field Exit (right-adjust and advance)
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      setSyncedCursor(null);
      sendKey('FIELD_EXIT');
      return;
    }

    const keyMap: Record<string, string> = {
      Enter: 'ENTER', Tab: 'TAB', Backspace: 'BACKSPACE', Delete: 'DELETE',
      ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
      PageUp: 'PAGEUP', PageDown: 'PAGEDOWN', Home: 'HOME', End: 'END', Insert: 'INSERT',
    };

    // F-keys. Match the *full* key name against the F1..F24 regex — if we
    // only tested startsWith('F'), a bare 'F' character would be swallowed
    // by preventDefault() without ever being sent as text, because the
    // inner regex would reject it and the handler would fall through with
    // nothing to dispatch. Making the regex the outer guard lets real
    // letter keys ('F', 'f', 'F1xyz', etc.) fall through to the text path.
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) {
      e.preventDefault();
      // Self-check any declared MOD10/MOD11 fields before submitting
      if (!runSelfCheck()) return;
      // Lock keyboard instantly so X II badge appears without waiting for proxy
      setOptimisticLock(true);
      const kr = await sendKey(e.key);
      if (kr.cursor_row !== undefined) setSyncedCursor({ row: kr.cursor_row, col: kr.cursor_col! });
      return;
    }

    // Action/navigation keys — self-check on submit-type keys (Enter, PageUp/Down)
    if (keyMap[e.key]) {
      e.preventDefault();
      const k = keyMap[e.key];
      const isSubmit = k === 'ENTER' || k === 'PAGEUP' || k === 'PAGEDOWN';
      if (isSubmit && !runSelfCheck()) return;

      // Arrow keys: optimistically predict the new cursor position locally so
      // the visual cursor moves immediately, matching typing's responsiveness.
      // Local prediction mirrors the proxy's simple grid-wrap arithmetic —
      // col±1 with column/row wrapping. The subsequent proxy 'cursor' push
      // message updates rawScreenData but is shadowed by syncedCursor here,
      // which is fine because our prediction matches the proxy's result.
      if (k === 'UP' || k === 'DOWN' || k === 'LEFT' || k === 'RIGHT') {
        const termRows = screenData?.rows || profile.defaultRows;
        const termColsLocal = screenData?.cols || profile.defaultCols;
        const curRow = syncedCursor?.row ?? screenData?.cursor_row ?? 0;
        const curCol = syncedCursor?.col ?? screenData?.cursor_col ?? 0;
        let newRow = curRow;
        let newCol = curCol;
        if (k === 'LEFT') {
          newCol = curCol - 1;
          if (newCol < 0) { newCol = termColsLocal - 1; newRow = (curRow - 1 + termRows) % termRows; }
        } else if (k === 'RIGHT') {
          newCol = curCol + 1;
          if (newCol >= termColsLocal) { newCol = 0; newRow = (curRow + 1) % termRows; }
        } else if (k === 'UP') {
          newRow = (curRow - 1 + termRows) % termRows;
        } else {
          newRow = (curRow + 1) % termRows;
        }
        setSyncedCursor({ row: newRow, col: newCol });
        sendKey(k);
        return;
      }

      // Non-arrow cursor movers (TAB, HOME, END, BACKSPACE, DELETE, INSERT):
      // outcome depends on field layout / host state, so local prediction
      // isn't trivial. Clear syncedCursor and let the proxy's pushed update
      // (via adapter.onScreen → rawScreenData) position the cursor.
      const isOtherMovement = k === 'TAB' || k === 'HOME' || k === 'END'
        || k === 'BACKSPACE' || k === 'DELETE' || k === 'INSERT';
      if (isOtherMovement) {
        setSyncedCursor(null);
        sendKey(k);
        return;
      }

      // AID/submit keys (ENTER, PAGEUP, PAGEDOWN) — await so self-check errors
      // can abort before the screen transitions.
      // Lock keyboard instantly so X II badge appears without waiting for proxy.
      setOptimisticLock(true);
      const kr = await sendKey(k);
      if (kr.cursor_row !== undefined) setSyncedCursor({ row: kr.cursor_row, col: kr.cursor_col! });
    }
  };

  const handleInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (readOnly) { e.target.value = ''; return; }
    const newText = e.target.value;
    if (newText.length > inputText.length) {
      let newChars = newText.substring(inputText.length);

      // 5250 shift-type filtering + monocase auto-uppercase.
      // If the cursor is inside an input field, apply the field's
      // character constraints (digits/alpha/numeric/katakana/signed-num)
      // and uppercase rule before sending to the host. Rejected chars
      // trigger a short visual bell via setValidationError.
      const curField = getCurrentField();
      if (curField && (curField.shift_type || curField.monocase)) {
        const curColAbs = syncedCursor?.col ?? screenData?.cursor_col ?? 0;
        const startOffset = Math.max(0, curColAbs - curField.col);
        const { out, rejected } = filterFieldInput(curField, newChars, startOffset);
        if (rejected) {
          const what = curField.shift_type === 'digits_only' || curField.shift_type === 'numeric_only' || curField.shift_type === 'signed_num'
            ? 'digits only'
            : curField.shift_type === 'alpha_only'
              ? 'letters only'
              : curField.shift_type === 'katakana'
                ? 'katakana only'
                : 'character not allowed';
          setValidationError(`Field accepts ${what}`);
          setTimeout(() => setValidationError(null), 1500);
        }
        newChars = out;
      }

      if (newChars.length > 0) {
        // Optimistic: show character immediately at cursor position
        const curRow = syncedCursor?.row ?? screenData?.cursor_row ?? 0;
        const curCol = syncedCursor?.col ?? screenData?.cursor_col ?? 0;
        const edits: Array<{ row: number; col: number; ch: string }> = [];
        for (let i = 0; i < newChars.length; i++) {
          edits.push({ row: curRow, col: curCol + i, ch: newChars[i] });
        }
        setOptimisticEdits(prev => [...prev, ...edits]);
        setSyncedCursor({ row: curRow, col: curCol + newChars.length });
        // Send to proxy in background (cursor-only response)
        sendText(newChars).then(r => {
          if (r.cursor_row !== undefined) setSyncedCursor({ row: r.cursor_row, col: r.cursor_col! });
        });
      }
    }
    setInputText('');
    e.target.value = '';
  };

  // --- Cursor ---
  const termCols = screenData?.cols || profile.defaultCols;
  const getCursorPos = () => {
    if (animatedCursorPos) return animatedCursorPos;
    let cursorRow = syncedCursor?.row ?? screenData?.cursor_row ?? 0;
    let cursorCol = syncedCursor?.col ?? screenData?.cursor_col ?? 0;
    while (cursorCol >= termCols) { cursorCol -= termCols; cursorRow += 1; }
    return { row: cursorRow, col: cursorCol };
  };

  // --- WDSF popup windows + heuristic plain-char popup detection ---
  // IBM i UIM popups (DSPMSG help, CRTLIB prompter, Exit Interactive SQL,
  // etc.) arrive in two flavors:
  //   (a) CREATE_WINDOW structured fields — proxy records metadata in
  //       screenData.windows. Easy: read the metadata.
  //   (b) Plain WRITE_TO_DISPLAY with literal `.` / `:` border characters
  //       painted into the buffer. No metadata. We detect these heuristically
  //       by scanning for rectangular patterns of `.` on top/bottom rows and
  //       `:` on left/right columns.
  // In either case we produce a unified window list, blank the underlying
  // ASCII border cells in renderRowWithFields, and draw styled .gs-window
  // overlays (Mocha/ACS-style rounded accent frame with title/footer).
  const detectedWindows = useMemo(() => {
    const wdsf = (screenData as any)?.windows as Array<{ row: number; col: number; height: number; width: number; title?: string; footer?: string }> | undefined;
    if (wdsf && wdsf.length > 0) return wdsf;
    const content = screenData?.content;
    const cols = screenData?.cols || profile.defaultCols;
    const termRows = screenData?.rows || profile.defaultRows;
    if (!content) return [];
    const lines = content.split('\n');
    const rowAt = (r: number) => (lines[r] || '').padEnd(cols, ' ');
    const DOT = '.';
    const COL = ':';
    // Heuristic: a run of 5+ consecutive `.` chars at the same col range on
    // two distinct rows, with `:` at both edges on every row between them.
    // MIN_WIDTH 5 rules out dotted separators ("........") used as filler in
    // label fields like "Option . . . . . . . . 1". MIN_HEIGHT 2 rules out
    // single-line patterns. We only keep the first rectangle that starts on
    // each row to avoid pathological nesting.
    const MIN_WIDTH = 20; // popups are typically wide; avoids matching "Selection . . . . . . ."
    const found: Array<{ row: number; col: number; height: number; width: number; title?: string; footer?: string }> = [];
    const claimedTop = new Set<number>();
    for (let rTop = 0; rTop < termRows - 2; rTop++) {
      if (claimedTop.has(rTop)) continue;
      const topLine = rowAt(rTop);
      // Find runs of dots (length >= MIN_WIDTH)
      let c = 0;
      while (c < cols) {
        if (topLine[c] !== DOT) { c++; continue; }
        let end = c;
        while (end < cols && topLine[end] === DOT) end++;
        const runLen = end - c;
        if (runLen >= MIN_WIDTH) {
          const startCol = c;
          const endCol = end - 1;
          // Scan downward: need `:` at startCol and endCol on subsequent rows
          // until we hit a row that doesn't match (bottom edge candidate).
          let r = rTop + 1;
          while (r < termRows) {
            const line = rowAt(r);
            if (line[startCol] !== COL || line[endCol] !== COL) break;
            r++;
          }
          const lastMidRow = r - 1; // last row with `:` at both edges
          const heightMid = lastMidRow - rTop; // rows between top edge and break
          if (heightMid < 2) { c = end; continue; }
          // Bottom-edge detection. Two shapes observed in IBM i:
          //   (a) The `:` pattern terminates, and row lastMidRow+1 is a
          //       horizontal `.` run (no corner chars). Top was pure dots;
          //       bottom is pure dots.
          //   (b) The LAST mid row itself is the bottom edge: `:` at
          //       startCol, dots in between, `:` at endCol. No separate
          //       bottom row.
          let bottomRow = -1;
          let title: string | undefined;
          let footer: string | undefined;
          // Try (b) first: is lastMidRow actually `:...:`?
          {
            const line = rowAt(lastMidRow);
            let dots = 0;
            for (let cc = startCol + 1; cc < endCol; cc++) if (line[cc] === DOT) dots++;
            const innerLen = Math.max(1, endCol - startCol - 1);
            if (dots >= innerLen * 0.8) {
              bottomRow = lastMidRow;
            }
          }
          // Try (a): row below lastMidRow is a `.` row
          if (bottomRow < 0 && lastMidRow + 1 < termRows) {
            const line = rowAt(lastMidRow + 1);
            let dots = 0;
            for (let cc = startCol; cc <= endCol; cc++) if (line[cc] === DOT) dots++;
            const span = Math.max(1, endCol - startCol + 1);
            if (dots >= span * 0.8) {
              bottomRow = lastMidRow + 1;
            }
          }
          if (bottomRow < 0) { c = end; continue; }
          // Extract title/footer: any non-dot non-space text on the border
          // rows. E.g. " Option - Help " embedded in the top row dots.
          const topInner = topLine.substring(startCol + 1, endCol)
            .replace(/\./g, ' ').trim();
          if (topInner.length > 0) title = topInner;
          const botLine = rowAt(bottomRow);
          const botInner = botLine.substring(startCol + 1, endCol)
            .replace(/\./g, ' ').trim();
          if (botInner.length > 0) footer = botInner;
          found.push({
            row: rTop,
            col: startCol,
            height: bottomRow - rTop - 1,
            width: endCol - startCol - 1,
            title,
            footer,
          });
          claimedTop.add(rTop);
          claimedTop.add(bottomRow);
          break;
        }
        c = end;
      }
    }
    return found;
  }, [screenData, profile.defaultCols, profile.defaultRows]);

  const windowBorderAddrs = useMemo(() => {
    const set = new Set<number>();
    if (!detectedWindows || detectedWindows.length === 0) return set;
    const cols = screenData?.cols || profile.defaultCols;
    for (const w of detectedWindows) {
      const topRow = w.row;
      const botRow = w.row + w.height + 1;
      const leftCol = w.col;
      const rightCol = w.col + w.width + 1;
      // Top + bottom edges (inclusive of corners)
      for (let c = leftCol; c <= rightCol; c++) {
        set.add(topRow * cols + c);
        set.add(botRow * cols + c);
      }
      // Left + right edges
      for (let r = topRow + 1; r < botRow; r++) {
        set.add(r * cols + leftCol);
        set.add(r * cols + rightCol);
      }
    }
    return set;
  }, [detectedWindows, screenData?.cols, profile.defaultCols]);

  // --- Rendering helpers ---
  const renderTextWithUnderlines = useCallback((text: string, keyPrefix: string): React.ReactNode => {
    const underscoreRegex = /_{2,}/g;
    const segments: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;
    let segmentIndex = 0;
    while ((match = underscoreRegex.exec(text)) !== null) {
      if (match.index > lastIndex) segments.push(<span key={`${keyPrefix}-t-${segmentIndex}`}>{text.substring(lastIndex, match.index)}</span>);
      const count = match[0].length;
      segments.push(<span key={`${keyPrefix}-u-${segmentIndex}`} style={{ borderBottom: '1px solid var(--gs-green, #a6e3a1)', display: 'inline-block', width: `${count}ch` }}>{' '.repeat(count)}</span>);
      lastIndex = match.index + match[0].length;
      segmentIndex++;
    }
    if (lastIndex < text.length) segments.push(<span key={`${keyPrefix}-e`}>{text.substring(lastIndex)}</span>);
    return segments.length > 0 ? <>{segments}</> : <>{text}</>;
  }, []);

  const renderRowWithFields = useCallback((
    line: string,
    rowIndex: number,
    fields: Field[],
    cursorRow: number,
    cursorCol: number,
  ): React.ReactNode => {
    const cols = screenData?.cols || profile.defaultCols;
    // Blank out WDSF window border cells — the host writes literal `.` and
    // `:` characters into the buffer for the popup border. We render a real
    // styled frame overlay (see .gs-window below) so the ASCII cells should
    // appear blank. Title/footer text lives on these rows too but is also
    // re-rendered via .gs-window-title / -footer overlays, so blank-all is
    // safe.
    if (windowBorderAddrs.size > 0) {
      const chars = line.split('');
      for (let c = 0; c < chars.length; c++) {
        if (windowBorderAddrs.has(rowIndex * cols + c)) chars[c] = ' ';
      }
      line = chars.join('');
    }
    // Multi-row input fields (IBM i command lines often span 2-3 rows) need
    // their underline rendered on every row they span, not just the starting
    // row. Build virtual field slices with row/col/length adjusted to the
    // current row's visible portion of each field.
    const inputFields: Field[] = [];
    for (const f of fields) {
      if (!f.is_input) continue;
      const slice = fieldSliceForRow(f, rowIndex, cols);
      if (!slice) continue;
      inputFields.push({ ...f, row: rowIndex, col: slice.col, length: slice.length });
    }
    const highlightedFields = fields.filter(f => f.row === rowIndex && f.is_protected && f.is_highlighted);
    const reverseFields = fields.filter(f => f.row === rowIndex && f.is_protected && f.is_reverse);
    const colorFields = fields.filter(f => f.row === rowIndex && f.is_protected && (f as any).color && !f.is_highlighted && !f.is_reverse);
    const allRowFields = [...inputFields, ...highlightedFields, ...reverseFields, ...colorFields];
    const extAttrs = (screenData as any)?.ext_attrs as Record<number, { color?: number; highlight?: number; char_set?: number }> | undefined;
    const dbcsCont = (screenData as any)?.dbcs_cont as number[] | undefined;
    const dbcsContSet = dbcsCont && dbcsCont.length > 0 ? new Set(dbcsCont) : null;

    // Has any extended attribute affecting this row?
    const hasExtOnRow = !!extAttrs && (() => {
      for (let c = 0; c < cols; c++) {
        if (extAttrs[rowIndex * cols + c]) return true;
      }
      return false;
    })();
    const hasDbcsOnRow = !!dbcsContSet && (() => {
      for (let c = 0; c < cols; c++) {
        if (dbcsContSet.has(rowIndex * cols + c)) return true;
      }
      return false;
    })();

    if (allRowFields.length === 0 && !hasExtOnRow && !hasDbcsOnRow) return <span>{line}</span>;

    const sorted = [...allRowFields].sort((a, b) => a.col - b.col);
    const segs: React.ReactNode[] = [];
    let lastEnd = 0;

    // Render a run of plain text while respecting ext_attrs and DBCS
    // continuation cells. Splits into per-cell spans only when necessary.
    const renderPlainRun = (runStart: number, runEnd: number, keyPrefix: string) => {
      if (runStart >= runEnd) return;
      if (!hasExtOnRow && !hasDbcsOnRow) {
        segs.push(<span key={keyPrefix}>{line.substring(runStart, runEnd)}</span>);
        return;
      }
      // Split into runs of cells that share visual state
      let pos = runStart;
      while (pos < runEnd) {
        const addr = rowIndex * cols + pos;
        const ext = extAttrs?.[addr];
        const isContCell = dbcsContSet?.has(addr);

        if (isContCell) {
          // DBCS continuation: the previous cell holds the glyph; this cell
          // is an empty string in the source but must occupy 1ch to keep
          // layout. Render as a zero-content full-width spacer.
          segs.push(
            <span
              key={`${keyPrefix}-dc${pos}`}
              style={{ display: 'inline-block', width: '1ch' }}
              aria-hidden="true"
            />,
          );
          pos++;
          continue;
        }

        if (ext) {
          const color = ext.color !== undefined ? decodeExtColor(ext.color) : undefined;
          const colorReverse = ext.color !== undefined && extColorIsReverse(ext.color);
          const hl = ext.highlight !== undefined ? decodeExtHighlight(ext.highlight) : undefined;
          const style: React.CSSProperties = {};
          if (color) style.color = cssVarForColor(color);
          // Color-byte reverse (0x08..0x0E) swaps fg/bg like highlight reverse
          if (colorReverse) {
            style.background = cssVarForColor(color);
            style.color = '#000';
          }
          if (hl?.reverse) { style.background = 'currentColor'; style.color = '#000'; }
          if (hl?.underscore) style.textDecoration = 'underline';
          if (hl?.blink) (style as any).animation = 'gs-blink 1s steps(2, start) infinite';
          segs.push(
            <span key={`${keyPrefix}-x${pos}`} style={style}>
              {line[pos]}
            </span>,
          );
          pos++;
          continue;
        }

        // Coalesce plain cells until the next ext/cont boundary
        let runEndPlain = pos + 1;
        while (runEndPlain < runEnd) {
          const a = rowIndex * cols + runEndPlain;
          if (extAttrs?.[a] || dbcsContSet?.has(a)) break;
          runEndPlain++;
        }
        segs.push(
          <span key={`${keyPrefix}-p${pos}`}>{line.substring(pos, runEndPlain)}</span>,
        );
        pos = runEndPlain;
      }
    };

    sorted.forEach((field, idx) => {
      const fs = field.col;
      const fe = Math.min(field.col + field.length, cols);
      if (fs > lastEnd) renderPlainRun(lastEnd, fs, `t${idx}`);
      const fc = line.substring(fs, fe);

      // Highlight-on-entry: if the cursor is inside this field AND the host
      // declared a replacement attribute (FCW 0x89), override the base color
      // and highlight for this render pass.
      const cursorInField = cursorRow === field.row && cursorCol >= fs && cursorCol < field.col + field.length;
      const entryAttr = cursorInField && (field as any).highlight_entry_attr !== undefined
        ? decodeAttrByte((field as any).highlight_entry_attr)
        : null;

      // Base color from field's 5250 color attribute (or the entry override)
      const baseColor = entryAttr?.color ?? ((field as any).color as any);
      const colorVar = baseColor ? cssVarForColor(baseColor) : undefined;

      // Compose inline style, combining base + entry override
      const fieldStyle: React.CSSProperties = {};
      if (colorVar) fieldStyle.color = colorVar;
      if (entryAttr?.reverse) { fieldStyle.background = 'currentColor'; fieldStyle.color = '#000'; }
      if (entryAttr?.underscore) fieldStyle.textDecoration = 'underline';
      if (entryAttr?.highIntensity) fieldStyle.fontWeight = 'bold';

      // Non-display (password) fields: render as blank space, not asterisks.
      // Real 5250 terminals (ACS, Mocha, native) never echo password
      // characters — the underscore/field attribute shows the input zone,
      // typed chars stay invisible. Asterisks are an HTML <input
      // type=password> convention that doesn't belong here.
      const isPassword = (field as any).is_non_display;
      const displayText = isPassword ? ' '.repeat(fc.length) : fc;

      if (field.is_input) {
        const fieldWidth = Math.min(field.length, cols - fs);
        const fieldClass = field.is_underscored ? 'gs-input-field' : undefined;
        const extra: string[] = [];
        if ((field as any).is_dbcs) extra.push('gs-dbcs-field');
        if (cursorInField) extra.push('gs-field-active');
        const composedClass = [fieldClass, ...extra].filter(Boolean).join(' ') || undefined;
        segs.push(
          <span
            key={`f${idx}`}
            className={composedClass}
            style={{
              display: 'inline-block',
              width: `${fieldWidth}ch`,
              overflow: 'hidden',
              ...fieldStyle,
            }}
          >
            {displayText}
          </span>,
        );
      } else if (field.is_reverse) {
        segs.push(
          <span
            key={`v${idx}`}
            style={{ color: colorVar || 'var(--gs-red, #FF5555)', fontWeight: 'bold', ...fieldStyle }}
          >
            {displayText}
          </span>,
        );
      } else if (colorVar || entryAttr) {
        segs.push(<span key={`h${idx}`} style={fieldStyle}>{displayText}</span>);
      } else if (field.is_highlighted) {
        segs.push(<span key={`h${idx}`} style={{ color: 'var(--gs-white, #FFFFFF)' }}>{displayText}</span>);
      } else {
        segs.push(<span key={`h${idx}`}>{displayText}</span>);
      }
      lastEnd = fe;
    });
    if (lastEnd < line.length) renderPlainRun(lastEnd, line.length, 'te');
    return <>{segs}</>;
  }, [renderTextWithUnderlines, screenData, profile.defaultCols]);

  // --- Screen rendering ---
  const renderScreen = () => {
    if (showBootLoader && !screenData?.content) {
      if (bootLoader === false) return null;
      if (bootLoader) return <>{bootLoader}</>;
      return <DefaultBootLoader brandText={profile.bootText} />;
    }
    if (bootFadingOut && screenData?.content) return <div className="gs-fade-in">{renderScreenContent()}</div>;
    if (!screenData?.content) {
      if (inlineSignIn && !connStatus?.connected) {
        return (
          <div style={{ width: '100%', height: `${(screenData?.rows || profile.defaultRows) * 21}px`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <InlineSignIn defaultProtocol={signInDefaultProtocol || protocol || 'tn5250'} loading={connecting || reconnecting} error={signInError || connectError} onConnect={handleSignIn} />
          </div>
        );
      }
      return (
        <div style={{ width: `${screenData?.cols || profile.defaultCols}ch`, height: `${(screenData?.rows || profile.defaultRows) * 21}px`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ color: 'var(--gs-muted, #6c7086)', marginBottom: '12px' }}><TerminalIcon size={40} /></div>
            <p style={{ fontFamily: 'var(--gs-font)', fontSize: '12px', color: connStatus?.status === 'connecting' ? 'var(--gs-yellow, #f9e2af)' : connStatus?.status === 'loading' ? 'var(--gs-muted, #6c7086)' : 'var(--gs-muted, #6c7086)' }}>
              {connStatus?.connected ? 'Waiting for screen data...' : connStatus?.status === 'connecting' ? 'Connecting...' : connStatus?.status === 'loading' ? 'Loading...' : 'Not connected'}
            </p>
            {!connStatus?.connected && isUsingDefaultAdapter && (
              <p style={{ fontFamily: 'var(--gs-font)', fontSize: '11px', color: 'var(--gs-muted, #6c7086)', marginTop: '8px' }}>
                Start the proxy: <code style={{ color: 'var(--gs-accent, #cba6f7)' }}>npx green-screen-proxy</code>
              </p>
            )}
          </div>
        </div>
      );
    }
    return renderScreenContent();
  };

  const renderScreenContent = () => {
    if (!screenData?.content) return null;
    const termRows = screenData.rows || profile.defaultRows;
    const cols = screenData.cols || profile.defaultCols;
    const lines = screenData.content.split('\n');
    const rows: string[] = [];
    for (let i = 0; i < termRows; i++) rows.push((lines[i] || '').padEnd(cols, ' '));

    const fields = screenData.fields || [];
    const ROW_HEIGHT = 21;
    const cursor = getCursorPos();
    const hasCursor = screenData.cursor_row !== undefined && screenData.cursor_col !== undefined;
    // Show cursor whenever it's inside an input field. Real 5250 terminals
    // (ACS, Mocha) show the cursor in password (NON_DISPLAY) fields too —
    // that's the only feedback that a keypress was registered, since the
    // typed characters stay invisible.
    const cursorInInputField = hasCursor && fields.some(f => {
      if (!f.is_input) return false;
      // Handle multi-row wrapping input fields (e.g. IBM i command lines).
      const slice = fieldSliceForRow(f, cursor.row, cols);
      // Allow cursor at the trailing "end-marker" position (col === slice.col
      // + slice.length) — after typing into a single-char field (e.g. the
      // Option input on the Exit Interactive SQL UIM popup), the proxy
      // advances cursor one past the last editable cell. Mocha and ACS still
      // render the cursor there. Without this, the cursor vanishes and users
      // can't tell they're positioned in the field.
      return !!slice && cursor.col >= slice.col && cursor.col <= slice.col + slice.length;
    });

    const ROW_H = 21; // matches ROW_HEIGHT above; used for window overlay positioning
    const screenWindows = detectedWindows;

    return (
      <div style={{ fontFamily: 'var(--gs-font)', fontSize: '13px', position: 'relative', width: `${cols}ch` }}>
        {rows.map((line, index) => {
          // Apply optimistic edits to this row
          let displayLine = line;
          const rowEdits = optimisticEdits.filter(e => e.row === index);
          if (rowEdits.length > 0) {
            const chars = displayLine.split('');
            for (const edit of rowEdits) {
              if (edit.col >= 0 && edit.col < chars.length) chars[edit.col] = edit.ch;
            }
            displayLine = chars.join('');
          }
          const headerSegments = index === 0 ? profile.colors.parseHeaderRow(displayLine) : null;
          return (
            <div key={index} className={headerSegments ? '' : profile.colors.getRowColorClass(index, displayLine, termRows)} style={{ height: `${ROW_HEIGHT}px`, lineHeight: `${ROW_HEIGHT}px`, whiteSpace: 'pre', position: 'relative' }}>
              {headerSegments
                ? headerSegments.map((seg, i) => <span key={i} className={seg.colorClass}>{seg.text}</span>)
                : renderRowWithFields(displayLine, index, fields, cursor.row, cursor.col)}
              {cursorInInputField && index === cursor.row && (
                <span className="gs-cursor" style={{ position: 'absolute', left: `${cursor.col}ch`, width: screenData?.insert_mode ? '1ch' : '2px', height: `${ROW_HEIGHT}px`, top: 0, pointerEvents: 'none' }} />
              )}
            </div>
          );
        })}
        {/* WDSF popup window frames (styled overlays replacing the ASCII
         * border cells). Each window is positioned absolutely over its
         * border cells and sized to cover the full window rectangle. Title
         * and footer are rendered as small centered labels on the top/bottom
         * edges. pointer-events: none so clicks pass through to the content
         * (input fields inside the window remain clickable). */}
        {screenWindows && screenWindows.map((w, wi) => (
          <div
            key={`gs-window-${wi}`}
            className="gs-window"
            style={{
              position: 'absolute',
              left: `${w.col}ch`,
              top: `${w.row * ROW_H}px`,
              width: `${w.width + 2}ch`,
              height: `${(w.height + 2) * ROW_H}px`,
              pointerEvents: 'none',
            }}
          >
            {w.title && (
              <span className="gs-window-title">{w.title}</span>
            )}
            {w.footer && (
              <span className="gs-window-footer">{w.footer}</span>
            )}
          </div>
        ))}
        {validationError && (
          <div
            role="alert"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              padding: '2px 6px',
              background: 'var(--gs-red, #FF5555)',
              color: '#000',
              fontFamily: 'var(--gs-font)',
              fontSize: '12px',
              zIndex: 10,
            }}
            onClick={() => setValidationError(null)}
          >
            {validationError} — click to dismiss
          </div>
        )}
        {screenData.cursor_row !== undefined && screenData.cursor_col !== undefined && (
          <span style={{ position: 'absolute', bottom: 0, right: 0, fontFamily: 'var(--gs-font)', fontSize: '10px', color: 'var(--gs-muted, #6c7086)', pointerEvents: 'none', opacity: 0.6 }}>
            {String(screenData.cursor_row + 1).padStart(2, '0')}/{String(screenData.cursor_col + 1).padStart(3, '0')}
          </span>
        )}
      </div>
    );
  };

  const handleReconnect = async () => {
    resetAutoReconnect();
    await reconnect();
  };

  const getStatusColor = (status?: string) => {
    switch (status) {
      case 'authenticated': return 'var(--gs-green, #a6e3a1)';
      case 'connected': return 'var(--gs-muted, #6c7086)';
      case 'connecting': return 'var(--gs-muted, #6c7086)';
      case 'error': return 'var(--gs-red, #f38ba8)';
      default: return 'var(--gs-muted, #6c7086)';
    }
  };

  // --- Disconnect handler ---
  const [disconnecting, setDisconnecting] = useState(false);
  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      await adapter.disconnect();
    } catch { /* ignore */ }
    setDisconnecting(false);
    onDisconnect?.();
  }, [adapter, onDisconnect]);

  // Send a key from the shortcuts panel. Mirrors the submit-key self-check
  // behaviour in handleKeyDown so clicked shortcuts behave like keystrokes.
  const handleShortcutSend = useCallback(async (key: string) => {
    if (readOnly) return;
    const isSubmit = key === 'ENTER' || key === 'PAGEUP' || key === 'PAGEDOWN' || /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
    if (isSubmit && !runSelfCheck()) return;
    setIsFocused(true);
    inputRef.current?.focus();
    // Clear optimistic cursor and fire-and-forget for non-submit keys — the
    // proxy's pushed cursor/screen update flows through adapter.onScreen into
    // rawScreenData. For submit keys (ENTER/PageUp/PageDown/F-keys) the screen
    // transition fully clears state anyway.
    if (!isSubmit) {
      setSyncedCursor(null);
      sendKey(key);
      return;
    }
    setOptimisticLock(true);
    const kr = await sendKey(key);
    if (kr.cursor_row !== undefined) setSyncedCursor({ row: kr.cursor_row, col: kr.cursor_col! });
  }, [readOnly, runSelfCheck, sendKey]);

  return (
    <div ref={containerRef} className={`gs-terminal gs-theme-${theme} ${isFocused ? 'gs-terminal-focused' : ''} ${className || ''}`} style={style}>
      {/* Header: custom header prop takes precedence over showHeader/embedded */}
      {header !== undefined ? (
        header === false ? null :
        typeof header === 'function' ? header({
          connectionStatus: connStatus,
          keyboardLocked: !!screenData?.keyboard_locked || optimisticLock,
          insertMode: !!screenData?.insert_mode,
          isFocused,
          reconnect: handleReconnect,
          reconnecting: reconnecting || isAutoReconnecting,
        }) :
        header
      ) : showHeader ? (
        <div className="gs-header">
          {embedded ? (
            <>
              <span className="gs-header-left">
                {showShortcutsButton && !readOnly && isFocused && <button onClick={(e) => { e.stopPropagation(); setShowShortcuts(s => !s); }} className="gs-btn-icon" title="Keyboard shortcuts"><KeyboardIcon size={16} /></button>}
                {(screenData?.keyboard_locked || optimisticLock) && <span className="gs-badge-lock">X II</span>}
                {screenData?.insert_mode && <span className="gs-badge-ins">INS</span>}
              </span>
              <span className="gs-header-title">Terminal</span>
              <div className="gs-header-right">
                {connStatus && connStatus.status !== 'loading' && (
                  connStatus.connected
                    ? <WifiIcon size={12} className="gs-connection-icon gs-connection-icon-connected" />
                    : <WifiOffIcon size={12} className="gs-connection-icon gs-connection-icon-disconnected" />
                )}
                {statusActions}
                {onMinimize && <button onClick={(e) => { e.stopPropagation(); onMinimize(); }} className="gs-btn-icon" title="Minimize terminal"><MinimizeIcon /></button>}
                {headerRight}
              </div>
            </>
          ) : (
            <>
              <span className="gs-header-left">
                {showShortcutsButton && !readOnly && isFocused && <button onClick={(e) => { e.stopPropagation(); setShowShortcuts(s => !s); }} className="gs-btn-icon" title="Keyboard shortcuts"><KeyboardIcon size={16} /></button>}
                {(screenData?.keyboard_locked || optimisticLock) && <span className="gs-badge-lock">X II</span>}
                {screenData?.insert_mode && <span className="gs-badge-ins">INS</span>}
              </span>
              <span className="gs-header-title">
                {profile.headerLabel.replace(' TERMINAL', '')}
              </span>
              <div className="gs-header-right">
                {connStatus && connStatus.status !== 'loading' && (
                  connStatus.connected ? (
                    <div className="gs-status-group">
                      <WifiIcon size={12} className="gs-connection-icon gs-connection-icon-connected" />
                      <span className="gs-host">{connStatus.host}</span>
                      {connStatus.username && (
                        <>
                          <KeyIcon size={11} style={{ color: getStatusColor(connStatus.status) }} />
                          <span className="gs-host">{connStatus.username}</span>
                        </>
                      )}
                      {connStatus.status !== 'authenticated' && (
                        <RefreshIcon size={12} className="gs-spin" />
                      )}
                      <button
                        onClick={handleDisconnect}
                        disabled={disconnecting}
                        className="gs-disconnect-btn"
                        title="Disconnect terminal session"
                      >
                        <UnplugIcon size={12} />
                        <span>Disconnect</span>
                      </button>
                    </div>
                  ) : (
                    <div className="gs-status-group">
                      <WifiOffIcon size={12} className="gs-connection-icon gs-connection-icon-disconnected" />
                      {connStatus.host && <span className="gs-host">{connStatus.host}</span>}
                      {connStatus.username && (
                        <>
                          <KeyIcon size={11} style={{ color: 'var(--gs-muted)' }} />
                          <span className="gs-host">{connStatus.username}</span>
                        </>
                      )}
                      <span className="gs-disconnected-text">
                        {isAutoReconnecting || reconnecting
                          ? `Reconnecting${autoReconnectAttempt > 0 ? ` (${autoReconnectAttempt}/${maxAttempts})` : '...'}`
                          : 'Disconnected'}
                      </span>
                      <button onClick={handleReconnect} disabled={reconnecting || isAutoReconnecting} className="gs-btn-icon" title="Reconnect">
                        <RefreshIcon size={12} className={reconnecting || isAutoReconnecting ? 'gs-spin' : ''} />
                      </button>
                    </div>
                  )
                )}
                {statusActions}
                {headerRight}
              </div>
            </>
          )}
        </div>
      ) : null}

      <div className="gs-body">
        <div ref={terminalRef} onClick={handleTerminalClick} className={`gs-screen ${embedded ? 'gs-screen-embedded' : ''}`}
          style={!embedded ? { width: `calc(${screenData?.cols || profile.defaultCols}ch + 32px)`, fontSize: (screenData?.cols ?? profile.defaultCols) > 80 ? '11px' : '13px', fontFamily: 'var(--gs-font)' } : undefined}>
          {screenError != null && (
            <div className="gs-error-banner">
              <AlertTriangleIcon size={14} />
              <span>{String(screenError)}</span>
            </div>
          )}
          <div ref={screenContentRef} className="gs-screen-content">{renderScreen()}</div>
          {overlay}
          {showShortcuts && (
            <div
              ref={shortcutsPanelRef}
              className="gs-shortcuts-panel"
              style={shortcutsPos
                ? { position: 'fixed', left: `${shortcutsPos.x}px`, top: `${shortcutsPos.y}px`, right: 'auto', bottom: 'auto' }
                : { position: 'fixed', visibility: 'hidden' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                className="gs-shortcuts-header"
                onMouseDown={startShortcutsDrag}
                style={{ cursor: isDraggingShortcuts ? 'grabbing' : 'grab', userSelect: 'none' }}
              >
                <span>Keyboard Shortcuts</span>
                <button
                  className="gs-btn-icon"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => setShowShortcuts(false)}
                >&times;</button>
              </div>
              <div className="gs-shortcuts-actions">
                {([
                  ['Enter',      'Submit',       'ENTER'],
                  ['Tab',        'Next field',   'TAB'],
                  ['Backspace',  'Backspace',    'BACKSPACE'],
                  ['Delete',     'Delete',       'DELETE'],
                  ['Insert',     'Ins / Ovr',    'INSERT'],
                  ['Home',       'Home',         'HOME'],
                  ['End',        'End',          'END'],
                  ['PgUp',       'Roll Down',    'PAGEUP'],
                  ['PgDn',       'Roll Up',      'PAGEDOWN'],
                  ['Ctrl+Ent',   'Field Exit',   'FIELD_EXIT'],
                  ['Ctrl+R',     'Reset',        'RESET'],
                  ['—',          'Help',         'HELP'],
                  ['—',          'Clear',        'CLEAR'],
                  ['—',          'Print',        'PRINT'],
                ] as const).map(([label, desc, key]) => (
                  <div key={key} className="gs-shortcut-action" onClick={(e) => { e.stopPropagation(); handleShortcutSend(key); }}>
                    <span className="gs-shortcut-key">{label}</span>
                    <span className="gs-shortcut-desc">{desc}</span>
                  </div>
                ))}
              </div>
              <div className="gs-shortcuts-fkeys-header">
                <span className="gs-shortcuts-section-title" style={{ margin: 0 }}>
                  {fkeyPage === 0 ? 'F1 – F12' : 'F13 – F24'}
                </span>
                <button
                  className="gs-btn-icon gs-fkey-nav"
                  onClick={(e) => { e.stopPropagation(); setFkeyPage(p => p === 0 ? 1 : 0); }}
                  title={fkeyPage === 0 ? 'Show F13–F24' : 'Show F1–F12'}
                >{fkeyPage === 0 ? '\u25B6' : '\u25C0'}</button>
              </div>
              <div className="gs-shortcuts-fkeys">
                {Array.from({ length: 12 }, (_, i) => `F${i + 1 + fkeyPage * 12}`).map(fk => (
                  <button
                    key={fk}
                    className="gs-shortcut-fkey"
                    onClick={(e) => { e.stopPropagation(); handleShortcutSend(fk); }}
                    title={`Send ${fk}`}
                  >{fk}</button>
                ))}
              </div>
            </div>
          )}
          {connStatus && !connStatus.connected && connStatus.status !== 'loading' && screenData && (
            <div className="gs-overlay">
              <WifiOffIcon size={28} />
              <span>{isAutoReconnecting || reconnecting ? 'Reconnecting...' : connStatus?.status === 'connecting' ? 'Connecting...' : 'Disconnected'}</span>
              {connStatus.error && !isAutoReconnecting && !reconnecting && (
                <span style={{ fontSize: '0.75em', opacity: 0.7, maxWidth: '80%', textAlign: 'center', wordBreak: 'break-word' }}>{connStatus.error}</span>
              )}
            </div>
          )}
          {showBusyOverlay && connStatus?.connected && (
            <div className="gs-busy-overlay" role="status" aria-live="polite">
              <RefreshIcon size={22} className="gs-spin" />
              <span className="gs-busy-clock">
                X CLOCK&nbsp;&nbsp;{formatBusyClock(lockElapsedMs)}
              </span>
              <span className="gs-busy-hint">Waiting for host…</span>
            </div>
          )}
          <input
            ref={inputRef}
            type="text"
            value={inputText}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', fontSize: '13px', lineHeight: '21px', fontFamily: 'var(--gs-font)', padding: 0, border: 'none', height: '21px' }}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            // Hint IME / mobile keyboard mode from current field metadata.
            // DBCS fields on Japanese hosts should open the kana/kanji IME
            // so the user can compose full-width text directly.
            lang={(() => {
              const f = getCurrentField();
              if (!f) return undefined;
              if ((f as any).is_dbcs || (f as any).is_dbcs_either) return 'ja';
              return undefined;
            })()}
            inputMode={(() => {
              const f = getCurrentField();
              if (!f) return undefined;
              if ((f as any).is_dbcs) return 'text';
              // Numeric-only shift types (SHIFT_NUMERIC_ONLY 0x03, DIGITS_ONLY 0x05, SIGNED_NUM 0x07)
              // are not exposed on Field today — but the browser mode hint is just an optimization.
              return 'text';
            })()}
          />
        </div>
      </div>
    </div>
  );
}
