import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { TerminalAdapter, ScreenData, ConnectionStatus, Field, TerminalProtocol, ProtocolProfile, ConnectConfig } from '../adapters/types';
import { RestAdapter } from '../adapters/RestAdapter';
import { WebSocketAdapter } from '../adapters/WebSocketAdapter';
import { useTerminalScreen, useTerminalInput, useTerminalConnection } from '../hooks/useTerminal';
import { useTypingAnimation } from '../hooks/useTypingAnimation';
import { getProtocolProfile } from '../protocols/registry';
import { TerminalBootLoader as DefaultBootLoader } from './TerminalBootLoader';
import { TerminalIcon, WifiIcon, WifiOffIcon, AlertTriangleIcon, RefreshIcon, KeyIcon, MinimizeIcon, KeyboardIcon } from './Icons';
import { InlineSignIn } from './InlineSignIn';
import { decodeAttrByte, decodeExtColor, decodeExtHighlight, cssVarForColor, mergeExtAttr, extColorIsReverse } from '../utils/attribute';
import { validateMod10, validateMod11, filterFieldInput } from '../utils/validation';

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
  /** Enable typing animation (default false) */
  typingAnimation?: boolean;
  /** Typing animation budget in ms (default 60) */
  typingBudgetMs?: number;

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
  /** Callback for minimize action (embedded mode) */
  onMinimize?: () => void;
  /** Show the keyboard-shortcuts button in the header (default true) */
  showShortcutsButton?: boolean;

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
  typingAnimation = false,
  typingBudgetMs = 60,
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
  onMinimize,
  showShortcutsButton = true,
  className,
  style,
}: GreenScreenTerminalProps) {
  const profile = customProfile ?? getProtocolProfile(protocol);

  // --- Resolve adapter: explicit > baseUrl > workerUrl > internal (from sign-in) > default WebSocket > noop ---
  const [internalAdapter, setInternalAdapter] = useState<TerminalAdapter | null>(null);
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
    () => (!externalAdapter && !baseUrl && !workerUrl) ? new WebSocketAdapter() : null,
    [externalAdapter, baseUrl, workerUrl],
  );
  const adapter = externalAdapter ?? baseUrlAdapter ?? workerUrlAdapter ?? internalAdapter ?? defaultWsAdapter ?? noopAdapter;
  const isUsingDefaultAdapter = adapter === defaultWsAdapter;

  // --- Data sources ---
  const shouldPoll = pollInterval > 0 && !externalScreenData;
  const { data: polledScreenData, error: screenError } = useTerminalScreen(adapter, pollInterval, shouldPoll);
  const { sendText: _sendText, sendKey: _sendKey } = useTerminalInput(adapter);
  const { connect, reconnect, loading: reconnecting, error: connectError } = useTerminalConnection(adapter);

  const rawScreenData = externalScreenData ?? polledScreenData;

  const connStatus = externalStatus ?? (rawScreenData ? { connected: true, status: 'authenticated' as const } : { connected: false, status: 'disconnected' as const });

  // Typing animation
  const { displayedContent, animatedCursorPos } = useTypingAnimation(
    rawScreenData?.content,
    typingAnimation,
    typingBudgetMs,
  );

  const screenData = useMemo(() => {
    if (!rawScreenData) return null;
    return { ...rawScreenData, content: displayedContent };
  }, [rawScreenData, displayedContent]);

  // Notify parent on screen changes
  const prevScreenSigRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (screenData && onScreenChange && screenData.screen_signature !== prevScreenSigRef.current) {
      prevScreenSigRef.current = screenData.screen_signature;
      onScreenChange(screenData);
    }
  }, [screenData, onScreenChange]);

  const sendText = useCallback(async (text: string) => _sendText(text), [_sendText]);
  const sendKey = useCallback(async (key: string) => _sendKey(key), [_sendKey]);

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
  const terminalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [syncedCursor, setSyncedCursor] = useState<{ row: number; col: number } | null>(null);
  const prevRawContentRef = useRef('');

  useEffect(() => {
    const newContent = rawScreenData?.content || '';
    if (prevRawContentRef.current && newContent && newContent !== prevRawContentRef.current) {
      setSyncedCursor(null);
      setInputText('');
    }
    prevRawContentRef.current = newContent;
  }, [rawScreenData?.content]);

  // --- Auto-reconnect ---
  const [autoReconnectAttempt, setAutoReconnectAttempt] = useState(0);
  const [isAutoReconnecting, setIsAutoReconnecting] = useState(false);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasConnectedRef = useRef(false);
  const isConnectedRef = useRef(false);

  useEffect(() => { isConnectedRef.current = connStatus?.connected ?? false; }, [connStatus?.connected]);

  useEffect(() => {
    if (!autoReconnectEnabled) return;
    const isConnected = connStatus?.connected;

    if (isConnected) {
      wasConnectedRef.current = true;
      if (reconnectTimeoutRef.current) { clearTimeout(reconnectTimeoutRef.current); reconnectTimeoutRef.current = null; }
      setAutoReconnectAttempt(0);
      setIsAutoReconnecting(false);
    } else if (wasConnectedRef.current && !isConnected && !isAutoReconnecting && !reconnecting) {
      if (autoReconnectAttempt < maxAttempts) {
        setIsAutoReconnecting(true);
        const delay = Math.pow(2, autoReconnectAttempt) * 1000;
        reconnectTimeoutRef.current = setTimeout(async () => {
          if (isConnectedRef.current) { setIsAutoReconnecting(false); return; }
          onNotification?.(`Auto-reconnect attempt ${autoReconnectAttempt + 1}/${maxAttempts}`, 'info');
          try {
            const result = await reconnect();
            if (!result?.success) setAutoReconnectAttempt(prev => prev + 1);
          } catch {
            onNotification?.('Auto-reconnect failed', 'error');
            setAutoReconnectAttempt(prev => prev + 1);
          }
          setIsAutoReconnecting(false);
        }, delay);
      }
    }
    return () => { if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current); };
  }, [connStatus?.connected, autoReconnectAttempt, isAutoReconnecting, reconnecting, reconnect, autoReconnectEnabled, maxAttempts, onNotification]);

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
      // Auto-create adapter from sign-in config when no external adapter is provided
      if (!externalAdapter && !baseUrlAdapter) {
        const port = config.port ? `:${config.port}` : '';
        const newAdapter = new RestAdapter({ baseUrl: `http://${config.host}${port}` });
        setInternalAdapter(newAdapter);
        await newAdapter.connect(config);
        return;
      }
      await connect(config);
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : String(err));
      setConnecting(false);
    }
    // Note: connecting is cleared by the screenData effect below, not here —
    // the connect() promise may resolve before the screen is actually ready.
  }, [connect, onSignIn, externalAdapter, baseUrlAdapter]);

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

  // Restore focus from localStorage on mount (if auto-focus enabled)
  useEffect(() => {
    if (!autoFocusDisabled && !readOnly) {
      try {
        if (localStorage.getItem(FOCUS_STORAGE_KEY) === 'true') {
          setIsFocused(true);
        }
      } catch { /* localStorage unavailable */ }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist focus state to localStorage
  useEffect(() => {
    if (autoFocusDisabled) return;
    try { localStorage.setItem(FOCUS_STORAGE_KEY, String(isFocused)); } catch { /* noop */ }
  }, [isFocused, autoFocusDisabled]);

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
    const handleClickOutside = (event: MouseEvent) => {
      if (terminalRef.current && !terminalRef.current.contains(event.target as Node)) setIsFocused(false);
    };
    if (isFocused) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isFocused]);

  useEffect(() => {
    if (readOnly && isFocused) { setIsFocused(false); inputRef.current?.blur(); }
  }, [readOnly, isFocused]);

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

    const rect = contentEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
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
    const clickedField = screenData.fields.find(f =>
      f.row === clickedRow && clickedCol >= f.col && clickedCol < f.col + f.length,
    );
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

    // Send cursor position to proxy (async, fire-and-forget for responsiveness)
    setSyncedCursor({ row: clickedRow, col: clickedCol });
    adapter.setCursor?.(clickedRow, clickedCol).then(r => {
      if (r?.cursor_row !== undefined) {
        setSyncedCursor({ row: r.cursor_row, col: r.cursor_col! });
      }
    });
  }, [readOnly, screenData, adapter, sendKey]);

  // --- Field helpers ---
  const getCurrentField = useCallback(() => {
    const fields = screenData?.fields || [];
    const cursorRow = syncedCursor?.row ?? screenData?.cursor_row ?? 0;
    const cursorCol = syncedCursor?.col ?? screenData?.cursor_col ?? 0;
    for (const field of fields) {
      if (field.is_input && field.row === cursorRow && cursorCol >= field.col && cursorCol < field.col + field.length) return field;
    }
    return null;
  }, [screenData, syncedCursor]);

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
      const kr = await sendKey('RESET');
      if (kr.cursor_row !== undefined) setSyncedCursor({ row: kr.cursor_row, col: kr.cursor_col! });
      return;
    }

    // Ctrl+Enter: Field Exit (right-adjust and advance)
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      const kr = await sendKey('FIELD_EXIT');
      if (kr.cursor_row !== undefined) setSyncedCursor({ row: kr.cursor_row, col: kr.cursor_col! });
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
      segments.push(<span key={`${keyPrefix}-u-${segmentIndex}`} style={{ borderBottom: '1px solid var(--gs-green, #10b981)', display: 'inline-block', width: `${count}ch` }}>{' '.repeat(count)}</span>);
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
    const inputFields = fields.filter(f => f.row === rowIndex && f.is_input);
    const highlightedFields = fields.filter(f => f.row === rowIndex && f.is_protected && f.is_highlighted);
    const reverseFields = fields.filter(f => f.row === rowIndex && f.is_protected && f.is_reverse);
    const colorFields = fields.filter(f => f.row === rowIndex && f.is_protected && (f as any).color && !f.is_highlighted && !f.is_reverse);
    const allRowFields = [...inputFields, ...highlightedFields, ...reverseFields, ...colorFields];

    const cols = screenData?.cols || profile.defaultCols;
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
            <div style={{ color: '#808080', marginBottom: '12px' }}><TerminalIcon size={40} /></div>
            <p style={{ fontFamily: 'var(--gs-font)', fontSize: '12px', color: connStatus?.status === 'connecting' ? '#f59e0b' : connStatus?.status === 'loading' ? '#94a3b8' : '#808080' }}>
              {connStatus?.connected ? 'Waiting for screen data...' : connStatus?.status === 'connecting' ? 'Connecting...' : connStatus?.status === 'loading' ? 'Loading...' : 'Not connected'}
            </p>
            {!connStatus?.connected && isUsingDefaultAdapter && (
              <p style={{ fontFamily: 'var(--gs-font)', fontSize: '11px', color: '#606060', marginTop: '8px' }}>
                Start the proxy: <code style={{ color: '#10b981' }}>npx green-screen-proxy</code>
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
    // Only show cursor when it's inside a visible input field (not non-display/password)
    const cursorInInputField = hasCursor && fields.some(f =>
      f.is_input && !(f as any).is_non_display &&
      f.row === cursor.row &&
      cursor.col >= f.col && cursor.col < f.col + f.length
    );

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
                <span className="gs-cursor" style={{ position: 'absolute', left: `${cursor.col}ch`, width: '1ch', height: `${ROW_HEIGHT}px`, top: 0, pointerEvents: 'none' }} />
              )}
            </div>
          );
        })}
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
          <span style={{ position: 'absolute', bottom: 0, right: 0, fontFamily: 'var(--gs-font)', fontSize: '10px', color: 'var(--gs-green, #10b981)', pointerEvents: 'none', opacity: 0.6 }}>
            {String(screenData.cursor_row + 1).padStart(2, '0')}/{String(screenData.cursor_col + 1).padStart(3, '0')}
          </span>
        )}
      </div>
    );
  };

  const handleReconnect = async () => {
    setAutoReconnectAttempt(0);
    setIsAutoReconnecting(false);
    if (reconnectTimeoutRef.current) { clearTimeout(reconnectTimeoutRef.current); reconnectTimeoutRef.current = null; }
    await reconnect();
  };

  const getStatusColor = (status?: string) => {
    switch (status) {
      case 'authenticated': return 'var(--gs-green, #10b981)';
      case 'connected': return '#F59E0B';
      case 'connecting': return '#64748b';
      case 'error': return '#EF4444';
      default: return '#64748b';
    }
  };

  // Send a key from the shortcuts panel. Mirrors the submit-key self-check
  // behaviour in handleKeyDown so clicked shortcuts behave like keystrokes.
  const handleShortcutSend = useCallback(async (key: string) => {
    if (readOnly) return;
    const isSubmit = key === 'ENTER' || key === 'PAGEUP' || key === 'PAGEDOWN' || /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
    if (isSubmit && !runSelfCheck()) return;
    setIsFocused(true);
    inputRef.current?.focus();
    const kr = await sendKey(key);
    if (kr.cursor_row !== undefined) setSyncedCursor({ row: kr.cursor_row, col: kr.cursor_col! });
  }, [readOnly, runSelfCheck, sendKey]);

  return (
    <div className={`gs-terminal ${isFocused ? 'gs-terminal-focused' : ''} ${className || ''}`} style={style}>
      {showHeader && (
        <div className="gs-header">
          {embedded ? (
            <>
              <span className="gs-header-left">
                <TerminalIcon size={14} />
                <span>TERMINAL</span>
                {isFocused && <span className="gs-badge-focused">FOCUSED</span>}
                {screenData?.timestamp && <span className="gs-timestamp">{new Date(screenData.timestamp).toLocaleTimeString()}</span>}
                <span className="gs-hint">{readOnly ? 'Read-only' : isFocused ? 'ESC to exit focus' : 'Click to control'}</span>
                {screenData?.keyboard_locked && <span className="gs-badge-lock">X II</span>}
                {screenData?.insert_mode && <span className="gs-badge-ins">INS</span>}
              </span>
              <div className="gs-header-right">
                {connStatus?.status && connStatus.status !== 'loading' && <KeyIcon size={12} style={{ color: getStatusColor(connStatus.status) }} />}
                {connStatus && connStatus.status !== 'loading' && (connStatus.connected
                  ? <WifiIcon size={12} style={{ color: 'var(--gs-green, #10b981)' }} />
                  : <WifiOffIcon size={12} style={{ color: '#FF6B00' }} />)}
                {statusActions}
                {onMinimize && <button onClick={(e) => { e.stopPropagation(); onMinimize(); }} className="gs-btn-icon" title="Minimize terminal"><MinimizeIcon /></button>}
                {showShortcutsButton && <button onClick={(e) => { e.stopPropagation(); setShowShortcuts(s => !s); }} className="gs-btn-icon" title="Keyboard shortcuts"><KeyboardIcon size={12} /></button>}
                {headerRight}
              </div>
            </>
          ) : (
            <>
              <span className="gs-header-left">
                <TerminalIcon size={14} />
                <span>{profile.headerLabel}</span>
                {isFocused && <span className="gs-badge-focused">FOCUSED</span>}
                {screenData?.timestamp && <span className="gs-timestamp">{new Date(screenData.timestamp).toLocaleTimeString()}</span>}
                <span className="gs-hint">{readOnly ? 'Read-only mode' : isFocused ? 'ESC to exit focus' : 'Click terminal to control'}</span>
                {screenData?.keyboard_locked && <span className="gs-badge-lock">X II</span>}
                {screenData?.insert_mode && <span className="gs-badge-ins">INS</span>}
              </span>
              <div className="gs-header-right">
                {connStatus && connStatus.status !== 'loading' && (
                  <div className="gs-status-group">
                    {connStatus.connected ? (
                      <>
                        <WifiIcon size={12} style={{ color: 'var(--gs-green, #10b981)' }} />
                        <span className="gs-host">{connStatus.host}</span>
                      </>
                    ) : (
                      <>
                        <WifiOffIcon size={12} style={{ color: '#FF6B00' }} />
                        <span className="gs-disconnected-text">
                          {isAutoReconnecting || reconnecting
                            ? `RECONNECTING${autoReconnectAttempt > 0 ? ` (${autoReconnectAttempt}/${maxAttempts})` : '...'}`
                            : autoReconnectAttempt >= maxAttempts ? 'DISCONNECTED (auto-retry exhausted)' : 'DISCONNECTED'}
                        </span>
                        <button onClick={handleReconnect} disabled={reconnecting || isAutoReconnecting} className="gs-btn-icon" title="Reconnect">
                          <RefreshIcon size={12} className={reconnecting || isAutoReconnecting ? 'gs-spin' : ''} />
                        </button>
                      </>
                    )}
                  </div>
                )}
                {connStatus?.status && (
                  <div className="gs-status-group">
                    <KeyIcon size={12} style={{ color: getStatusColor(connStatus.status) }} />
                    {connStatus.username && <span className="gs-host">{connStatus.username}</span>}
                  </div>
                )}
                {statusActions}
                {showShortcutsButton && <button onClick={(e) => { e.stopPropagation(); setShowShortcuts(s => !s); }} className="gs-btn-icon" title="Keyboard shortcuts"><KeyboardIcon size={12} /></button>}
                {headerRight}
              </div>
            </>
          )}
        </div>
      )}

      <div className="gs-body">
        <div ref={terminalRef} onClick={handleTerminalClick} className={`gs-screen ${embedded ? 'gs-screen-embedded' : ''}`}
          style={!embedded ? { width: `calc(${screenData?.cols || profile.defaultCols}ch + 24px)`, fontSize: (screenData?.cols ?? profile.defaultCols) > 80 ? '11px' : '13px', fontFamily: 'var(--gs-font)' } : undefined}>
          {screenError != null && (
            <div className="gs-error-banner">
              <AlertTriangleIcon size={14} />
              <span>{String(screenError)}</span>
            </div>
          )}
          <div ref={screenContentRef} className="gs-screen-content">{renderScreen()}</div>
          {overlay}
          {showShortcuts && (
            <div className="gs-shortcuts-panel">
              <div className="gs-shortcuts-header">
                <span>Keyboard Shortcuts</span>
                <button className="gs-btn-icon" onClick={() => setShowShortcuts(false)}>&times;</button>
              </div>
              <div className="gs-shortcuts-section-title">Actions</div>
              <table className="gs-shortcuts-table">
                <tbody>
                  {([
                    ['Enter',      'Submit',             'ENTER'],
                    ['Tab',        'Next field',         'TAB'],
                    ['Backspace',  'Backspace',          'BACKSPACE'],
                    ['Delete',     'Delete',             'DELETE'],
                    ['Insert',     'Insert / Overwrite', 'INSERT'],
                    ['Home',       'Home',               'HOME'],
                    ['End',        'End',                'END'],
                    ['Page Up',    'Roll Down',          'PAGEUP'],
                    ['Page Down',  'Roll Up',            'PAGEDOWN'],
                    ['Ctrl+Enter', 'Field Exit',         'FIELD_EXIT'],
                    ['Ctrl+R',     'Reset',              'RESET'],
                    ['—',          'Help',               'HELP'],
                    ['—',          'Clear',              'CLEAR'],
                    ['—',          'Print',              'PRINT'],
                  ] as const).map(([label, desc, key]) => (
                    <tr key={key} className="gs-shortcut-row" onClick={(e) => { e.stopPropagation(); handleShortcutSend(key); }}>
                      <td className="gs-shortcut-key">{label}</td>
                      <td>{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="gs-shortcuts-section-title">Function keys</div>
              <div className="gs-shortcuts-fkeys">
                {Array.from({ length: 24 }, (_, i) => `F${i + 1}`).map(fk => (
                  <button
                    key={fk}
                    className="gs-shortcut-fkey"
                    onClick={(e) => { e.stopPropagation(); handleShortcutSend(fk); }}
                    title={`Send ${fk}`}
                  >{fk}</button>
                ))}
              </div>
              <div className="gs-shortcuts-section-title">Info</div>
              <table className="gs-shortcuts-table">
                <tbody>
                  <tr><td className="gs-shortcut-key">Click</td><td>Focus / Position cursor</td></tr>
                  <tr><td className="gs-shortcut-key">Escape</td><td>Exit focus mode</td></tr>
                </tbody>
              </table>
            </div>
          )}
          {connStatus && !connStatus.connected && screenData && (
            <div className="gs-overlay">
              <WifiOffIcon size={28} />
              <span>{isAutoReconnecting || reconnecting ? 'Reconnecting...' : connStatus?.status === 'connecting' ? 'Connecting...' : 'Disconnected'}</span>
              {connStatus.error && !isAutoReconnecting && !reconnecting && (
                <span style={{ fontSize: '0.75em', opacity: 0.7, maxWidth: '80%', textAlign: 'center', wordBreak: 'break-word' }}>{connStatus.error}</span>
              )}
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
