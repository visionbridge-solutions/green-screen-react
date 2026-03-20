import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { TerminalAdapter, ScreenData, ConnectionStatus, Field, TerminalProtocol, ProtocolProfile, ConnectConfig } from '../adapters/types';
import { RestAdapter } from '../adapters/RestAdapter';
import { WebSocketAdapter } from '../adapters/WebSocketAdapter';
import { useTerminalScreen, useTerminalInput, useTerminalConnection } from '../hooks/useTerminal';
import { useTypingAnimation } from '../hooks/useTypingAnimation';
import { getProtocolProfile } from '../protocols/registry';
import { TerminalBootLoader as DefaultBootLoader } from './TerminalBootLoader';
import { TerminalIcon, WifiIcon, WifiOffIcon, AlertTriangleIcon, RefreshIcon, KeyIcon, MinimizeIcon } from './Icons';
import { InlineSignIn } from './InlineSignIn';

/* ── No-op adapter (placeholder before connection) ───────────────── */

const noopResult = { success: false, error: 'No adapter configured' };
const noopAdapter: TerminalAdapter = {
  getScreen: async () => null,
  getStatus: async () => ({ connected: false, status: 'disconnected' }),
  sendText: async () => noopResult,
  sendKey: async () => noopResult,
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
  /** Enable typing animation (default true) */
  typingAnimation?: boolean;
  /** Typing animation budget in ms (default 60) */
  typingBudgetMs?: number;

  /** Show inline sign-in form when disconnected (default true) */
  inlineSignIn?: boolean;
  /** Default protocol for the sign-in form dropdown (default 'tn5250') */
  defaultProtocol?: TerminalProtocol;
  /** Callback when sign-in form is submitted */
  onSignIn?: (config: ConnectConfig) => void;
  /** Show "press Enter to continue" hint after auto sign-in (for external adapter flows) */
  autoSignedIn?: boolean;
  /** Disable auto-focus on the terminal after connecting (default false) */
  autoFocusDisabled?: boolean;

  /** Custom boot loader element, or false to disable */
  bootLoader?: React.ReactNode | false;
  /** Content for the right side of the header */
  headerRight?: React.ReactNode;
  /** Overlay content (e.g. "Extracting..." state) */
  overlay?: React.ReactNode;
  /** Callback for notifications (replaces toast) */
  onNotification?: (message: string, type: 'info' | 'error') => void;
  /** Callback when screen content changes */
  onScreenChange?: (screen: ScreenData) => void;
  /** Callback for minimize action (embedded mode) */
  onMinimize?: () => void;

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
  typingAnimation = true,
  typingBudgetMs = 60,
  inlineSignIn = true,
  defaultProtocol: signInDefaultProtocol,
  onSignIn,
  autoSignedIn,
  autoFocusDisabled = false,
  bootLoader,
  headerRight,
  overlay,
  onNotification,
  onScreenChange,
  onMinimize,
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

  // --- UI State ---
  const [inputText, setInputText] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [showSignInHint, setShowSignInHint] = useState(false);
  const prevAutoSignedIn = useRef(false);
  useEffect(() => {
    if (autoSignedIn && !prevAutoSignedIn.current) setShowSignInHint(true);
    prevAutoSignedIn.current = !!autoSignedIn;
  }, [autoSignedIn]);
  const terminalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [syncedCursor, setSyncedCursor] = useState<{ row: number; col: number } | null>(null);
  const prevRawContentRef = useRef('');

  useEffect(() => {
    const newContent = rawScreenData?.content || '';
    if (prevRawContentRef.current && newContent && newContent !== prevRawContentRef.current) {
      setSyncedCursor(null);
      setInputText('');
      if (showSignInHint) setShowSignInHint(false);
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
        if (config.username && config.password) setShowSignInHint(true);
        return;
      }
      await connect(config);
      if (config.username && config.password) setShowSignInHint(true);
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
    if (screenData?.content && showBootLoader) {
      setBootFadingOut(true);
      setShowBootLoader(false);
      const timer = setTimeout(() => setBootFadingOut(false), 400);
      return () => clearTimeout(timer);
    }
  }, [screenData?.content, showBootLoader]);

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

  const handleTerminalClick = useCallback(() => {
    if (readOnly) return;
    setIsFocused(true);
    inputRef.current?.focus();
  }, [readOnly]);

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

  const canTypeMore = useCallback((additionalChars: number = 1) => {
    const currentField = getCurrentField();
    if (!currentField) return true;
    const cursorCol = (syncedCursor?.col ?? screenData?.cursor_col ?? 0) + inputText.length;
    return cursorCol + additionalChars <= currentField.col + currentField.length;
  }, [getCurrentField, syncedCursor, screenData, inputText]);

  // --- Keyboard handling ---
  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (readOnly) { e.preventDefault(); return; }

    if (e.key === 'Escape') { e.preventDefault(); setIsFocused(false); inputRef.current?.blur(); return; }

    if (e.key === 'Backspace') {
      e.preventDefault();
      // Flush any buffered text first, then send backspace to proxy
      if (inputText) {
        const r = await sendText(inputText); setInputText('');
        if (r.cursor_row !== undefined) setSyncedCursor({ row: r.cursor_row, col: r.cursor_col! });
      }
      const keyResult = await sendKey('BACKSPACE');
      if (keyResult.cursor_row !== undefined) setSyncedCursor({ row: keyResult.cursor_row, col: keyResult.cursor_col! });
      return;
    }

    const keyMap: Record<string, string> = {
      Enter: 'ENTER', Tab: 'TAB', Delete: 'DELETE',
      ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
      PageUp: 'PAGEUP', PageDown: 'PAGEDOWN', Home: 'HOME', End: 'END', Insert: 'INSERT',
    };

    if (e.key.startsWith('F') && e.key.length <= 3) {
      e.preventDefault();
      const fKey = e.key.toUpperCase();
      if (/^F([1-9]|1[0-9]|2[0-4])$/.test(fKey)) {
        if (inputText) {
          const r = await sendText(inputText); setInputText('');
          if (r.cursor_row !== undefined) setSyncedCursor({ row: r.cursor_row, col: r.cursor_col! });
        }
        const kr = await sendKey(fKey);
        if (kr.cursor_row !== undefined) setSyncedCursor({ row: kr.cursor_row, col: kr.cursor_col! });
        return;
      }
    }

    if (keyMap[e.key]) {
      e.preventDefault();
      if (inputText) {
        const r = await sendText(inputText); setInputText('');
        if (r.cursor_row !== undefined) setSyncedCursor({ row: r.cursor_row, col: r.cursor_col! });
      }
      const kr = await sendKey(keyMap[e.key]);
      if (kr.cursor_row !== undefined) setSyncedCursor({ row: kr.cursor_row, col: kr.cursor_col! });
    }
  };

  const handleInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (readOnly) { e.target.value = ''; return; }
    const newText = e.target.value;
    if (newText.includes('\n')) {
      const textToSend = newText.replace('\n', '');
      if (textToSend) {
        const r = await sendText(textToSend);
        if (r.cursor_row !== undefined) setSyncedCursor({ row: r.cursor_row, col: r.cursor_col! });
      }
      const kr = await sendKey('ENTER');
      if (kr.cursor_row !== undefined) setSyncedCursor({ row: kr.cursor_row, col: kr.cursor_col! });
      setInputText(''); e.target.value = '';
    } else {
      const charsToAdd = newText.length - inputText.length;
      if (charsToAdd > 0 && !canTypeMore(charsToAdd)) { e.target.value = inputText; return; }
      setInputText(newText);
    }
  };

  // --- Cursor ---
  const termCols = screenData?.cols || profile.defaultCols;
  const getCursorPos = () => {
    if (animatedCursorPos) return animatedCursorPos;
    let cursorRow = syncedCursor?.row ?? screenData?.cursor_row ?? 0;
    let cursorCol = (syncedCursor?.col ?? screenData?.cursor_col ?? 0) + inputText.length;
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

  const renderRowWithFields = useCallback((line: string, rowIndex: number, fields: Field[]): React.ReactNode => {
    const inputFields = fields.filter(f => f.row === rowIndex && f.is_input);
    const highlightedFields = fields.filter(f => f.row === rowIndex && f.is_protected && f.is_highlighted);
    const reverseFields = fields.filter(f => f.row === rowIndex && f.is_protected && f.is_reverse);
    const colorFields = fields.filter(f => f.row === rowIndex && f.is_protected && (f as any).color && !f.is_highlighted && !f.is_reverse);
    const allRowFields = [...inputFields, ...highlightedFields, ...reverseFields, ...colorFields];

    if (allRowFields.length === 0) return <span>{line}</span>;

    const sorted = [...allRowFields].sort((a, b) => a.col - b.col);
    const segs: React.ReactNode[] = [];
    let lastEnd = 0;
    const cols = screenData?.cols || profile.defaultCols;

    sorted.forEach((field, idx) => {
      const fs = field.col;
      const fe = Math.min(field.col + field.length, cols);
      if (fs > lastEnd) segs.push(<span key={`t${idx}`}>{line.substring(lastEnd, fs)}</span>);
      const fc = line.substring(fs, fe);

      // Resolve color from field's 5250 color attribute
      const colorVar = (field as any).color
        ? `var(--gs-${(field as any).color}, var(--gs-green))`
        : undefined;

      if (field.is_input) {
        const fieldWidth = Math.min(field.length, cols - fs);
        const fieldClass = showSignInHint ? 'gs-confirmed-field' : (field.is_underscored ? 'gs-input-field' : undefined);
        segs.push(<span key={`f${idx}`} className={fieldClass || undefined} style={{ display: 'inline-block', width: `${fieldWidth}ch`, overflow: 'hidden', color: colorVar }}>{fc}</span>);
      } else if (field.is_reverse) {
        segs.push(<span key={`v${idx}`} style={{ color: colorVar || 'var(--gs-red, #FF5555)', fontWeight: 'bold' }}>{fc}</span>);
      } else if (colorVar) {
        segs.push(<span key={`h${idx}`} style={{ color: colorVar }}>{fc}</span>);
      } else if (field.is_highlighted) {
        segs.push(<span key={`h${idx}`} style={{ color: 'var(--gs-white, #FFFFFF)' }}>{fc}</span>);
      } else {
        segs.push(<span key={`h${idx}`}>{fc}</span>);
      }
      lastEnd = fe;
    });
    if (lastEnd < line.length) segs.push(<span key="te">{line.substring(lastEnd)}</span>);
    return <>{segs}</>;
  }, [renderTextWithUnderlines, screenData?.cols, profile.defaultCols, showSignInHint]);

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
            <p style={{ fontFamily: 'var(--gs-font)', fontSize: '12px', color: '#808080' }}>
              {connStatus?.connected ? 'Waiting for screen data...' : 'Not connected'}
            </p>
            {!connStatus?.connected && isUsingDefaultAdapter && (
              <p style={{ fontFamily: 'var(--gs-font)', fontSize: '11px', color: '#606060', marginTop: '8px' }}>
                Start the proxy: <code style={{ color: '#10b981' }}>npx green-screen-proxy --mock</code>
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
    // Only show cursor when it's inside an input field
    const cursorInInputField = hasCursor && fields.some(f =>
      f.is_input && f.row === cursor.row &&
      cursor.col >= f.col && cursor.col < f.col + f.length
    );

    return (
      <div style={{ fontFamily: 'var(--gs-font)', fontSize: '13px', position: 'relative', width: `${cols}ch` }}>
        {rows.map((line, index) => {
          let displayLine = line;
          if (hasCursor && index === cursor.row && inputText && !animatedCursorPos) {
            const baseCol = syncedCursor?.col ?? screenData.cursor_col ?? 0;
            displayLine = (line.substring(0, baseCol) + inputText + line.substring(baseCol + inputText.length)).substring(0, cols).padEnd(cols, ' ');
          }
          const headerSegments = index === 0 ? profile.colors.parseHeaderRow(displayLine) : null;
          return (
            <div key={index} className={headerSegments ? '' : profile.colors.getRowColorClass(index, displayLine, termRows)} style={{ height: `${ROW_HEIGHT}px`, lineHeight: `${ROW_HEIGHT}px`, whiteSpace: 'pre', position: 'relative' }}>
              {headerSegments
                ? headerSegments.map((seg, i) => <span key={i} className={seg.colorClass}>{seg.text}</span>)
                : renderRowWithFields(displayLine, index, fields)}
              {cursorInInputField && !showSignInHint && index === cursor.row && (
                <span className="gs-cursor" style={{ position: 'absolute', left: `${cursor.col}ch`, width: '1ch', height: `${ROW_HEIGHT}px`, top: 0, pointerEvents: 'none' }} />
              )}
            </div>
          );
        })}
        {showSignInHint && (
          <div className="gs-signin-hint">
            Signed in — press Enter to continue
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
              </span>
              <div className="gs-header-right">
                {connStatus?.status && <KeyIcon size={12} style={{ color: getStatusColor(connStatus.status) }} />}
                {connStatus && (connStatus.connected
                  ? <WifiIcon size={12} style={{ color: 'var(--gs-green, #10b981)' }} />
                  : <WifiOffIcon size={12} style={{ color: '#FF6B00' }} />)}
                {onMinimize && <button onClick={(e) => { e.stopPropagation(); onMinimize(); }} className="gs-btn-icon" title="Minimize terminal"><MinimizeIcon /></button>}
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
              </span>
              <div className="gs-header-right">
                {connStatus && (
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
          <div className="gs-screen-content">{renderScreen()}</div>
          {overlay}
          {connStatus && !connStatus.connected && screenData && (
            <div className="gs-overlay">
              <WifiOffIcon size={28} />
              <span>{isAutoReconnecting || reconnecting ? 'Reconnecting...' : 'Disconnected'}</span>
            </div>
          )}
          <input ref={inputRef} type="text" value={inputText} onChange={handleInput} onKeyDown={handleKeyDown}
            style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
        </div>
      </div>
    </div>
  );
}
