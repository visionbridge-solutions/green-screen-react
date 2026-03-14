import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { TerminalAdapter, ScreenData, ConnectionStatus, Field, TerminalProtocol, ProtocolProfile, ConnectConfig } from '../adapters/types';
import { RestAdapter } from '../adapters/RestAdapter';
import { useTerminalScreen, useTerminalInput, useTerminalConnection } from '../hooks/useTN5250';
import { useTypingAnimation } from '../hooks/useTypingAnimation';
import { getProtocolProfile } from '../protocols/registry';
import { TerminalBootLoader as DefaultBootLoader } from './TerminalBootLoader';

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

/* ── Inline SVG Icons (no external dependency) ────────────────────── */

const TerminalIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

const WifiIcon = ({ size = 12, className, style: s }: { size?: number; className?: string; style?: React.CSSProperties }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={s}>
    <path d="M5 12.55a11 11 0 0 1 14.08 0" /><path d="M1.42 9a16 16 0 0 1 21.16 0" /><path d="M8.53 16.11a6 6 0 0 1 6.95 0" /><line x1="12" y1="20" x2="12.01" y2="20" />
  </svg>
);

const WifiOffIcon = ({ size = 12, className, style: s }: { size?: number; className?: string; style?: React.CSSProperties }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={s}>
    <line x1="1" y1="1" x2="23" y2="23" /><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" /><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" /><path d="M10.71 5.05A16 16 0 0 1 22.56 9" /><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" /><path d="M8.53 16.11a6 6 0 0 1 6.95 0" /><line x1="12" y1="20" x2="12.01" y2="20" />
  </svg>
);

const AlertTriangleIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

const RefreshIcon = ({ size = 12, className }: { size?: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);

const KeyIcon = ({ size = 12, style: s }: { size?: number; style?: React.CSSProperties }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={s}>
    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
  </svg>
);

const MinimizeIcon = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M4 14h6v6M3 21l7-7M20 10h-6V4M21 3l-7 7" />
  </svg>
);

/* ── Inline Sign-In Form ─────────────────────────────────────────── */

const PROTOCOL_OPTIONS: { value: TerminalProtocol; label: string }[] = [
  { value: 'tn5250', label: 'TN5250 (IBM i)' },
  { value: 'tn3270', label: 'TN3270 (Mainframe)' },
  { value: 'vt', label: 'VT220' },
  { value: 'hp6530', label: 'HP 6530 (NonStop)' },
];

interface InlineSignInProps {
  defaultProtocol: TerminalProtocol;
  loading: boolean;
  error: string | null;
  onConnect: (config: ConnectConfig) => void;
}

function InlineSignIn({ defaultProtocol, loading, error, onConnect }: InlineSignInProps) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [selectedProtocol, setSelectedProtocol] = useState<TerminalProtocol>(defaultProtocol);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onConnect({
      host,
      port: port ? parseInt(port, 10) : undefined,
      protocol: selectedProtocol,
      username,
      password,
    });
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '6px 8px',
    backgroundColor: 'rgba(16, 185, 129, 0.05)',
    border: '1px solid var(--gs-card-border, #1e293b)',
    color: 'var(--gs-green, #10b981)',
    fontFamily: 'var(--gs-font)',
    fontSize: '13px',
    outline: 'none',
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    marginBottom: '4px',
    fontSize: '10px',
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: 'var(--gs-muted, #94a3b8)',
    fontFamily: 'var(--gs-font)',
  };

  return (
    <form onSubmit={handleSubmit} className="gs-signin">
      <div style={{ textAlign: 'center', marginBottom: '16px' }}>
        <TerminalIcon size={28} />
        <div style={{ fontSize: '11px', letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--gs-muted)', marginTop: '8px' }}>Connect to Host</div>
      </div>

      <div className="gs-signin-row">
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Host</label>
          <input style={inputStyle} value={host} onChange={e => setHost(e.target.value)} placeholder="192.168.1.100" required autoFocus />
        </div>
        <div style={{ width: '72px' }}>
          <label style={labelStyle}>Port</label>
          <input style={inputStyle} value={port} onChange={e => setPort(e.target.value)} placeholder="23" type="number" min="1" max="65535" />
        </div>
      </div>

      <div>
        <label style={labelStyle}>Protocol</label>
        <select style={{ ...inputStyle, appearance: 'none' }} value={selectedProtocol} onChange={e => setSelectedProtocol(e.target.value as TerminalProtocol)}>
          {PROTOCOL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      <div>
        <label style={labelStyle}>Username</label>
        <input style={inputStyle} value={username} onChange={e => setUsername(e.target.value)} required autoComplete="username" />
      </div>

      <div>
        <label style={labelStyle}>Password</label>
        <input style={inputStyle} type="password" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="current-password" />
      </div>

      {error && (
        <div style={{ color: '#FF6B00', fontSize: '11px', fontFamily: 'var(--gs-font)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <AlertTriangleIcon size={12} />
          <span>{error}</span>
        </div>
      )}

      <button type="submit" disabled={loading || !host || !username || !password} className="gs-signin-btn">
        {loading ? 'Connecting...' : 'Connect'}
      </button>
    </form>
  );
}

/* ── Component Props ──────────────────────────────────────────────── */

export interface GreenScreenTerminalProps {
  /** Adapter for communicating with the terminal backend (optional — auto-created from sign-in form or baseUrl) */
  adapter?: TerminalAdapter;
  /** Base URL for the terminal API — convenience shorthand that auto-creates a RestAdapter */
  baseUrl?: string;
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

/** @deprecated Use GreenScreenTerminalProps instead */
export type TN5250TerminalProps = GreenScreenTerminalProps;

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

  // --- Resolve adapter: explicit > baseUrl > internal (from sign-in) > noop ---
  const [internalAdapter, setInternalAdapter] = useState<TerminalAdapter | null>(null);
  const baseUrlAdapter = useMemo(
    () => baseUrl ? new RestAdapter({ baseUrl }) : null,
    [baseUrl],
  );
  const adapter = externalAdapter ?? baseUrlAdapter ?? internalAdapter ?? noopAdapter;

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
  const handleSignIn = useCallback(async (config: ConnectConfig) => {
    onSignIn?.(config);
    // Auto-create adapter from sign-in config when no external adapter is provided
    if (!externalAdapter && !baseUrlAdapter) {
      const port = config.port ? `:${config.port}` : '';
      const newAdapter = new RestAdapter({ baseUrl: `http://${config.host}${port}` });
      setInternalAdapter(newAdapter);
      await newAdapter.connect(config);
      return;
    }
    await connect(config);
  }, [connect, onSignIn, externalAdapter, baseUrlAdapter]);

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
      if (inputText.length > 0) { setInputText(prev => prev.slice(0, -1)); }
      else {
        const keyResult = await sendKey('BACKSPACE');
        if (keyResult.cursor_row !== undefined) setSyncedCursor({ row: keyResult.cursor_row, col: keyResult.cursor_col! });
      }
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
    const allRowFields = [...inputFields, ...highlightedFields, ...reverseFields];

    if (allRowFields.length === 0) return <span>{renderTextWithUnderlines(line, `r${rowIndex}`)}</span>;

    const sorted = [...allRowFields].sort((a, b) => a.col - b.col);
    const segs: React.ReactNode[] = [];
    let lastEnd = 0;
    const cols = screenData?.cols || profile.defaultCols;

    sorted.forEach((field, idx) => {
      const fs = field.col;
      const fe = Math.min(field.col + field.length, cols);
      if (fs > lastEnd) segs.push(<span key={`t${idx}`}>{renderTextWithUnderlines(line.substring(lastEnd, fs), `r${rowIndex}p${idx}`)}</span>);
      const fc = line.substring(fs, fe);
      if (field.is_input) {
        const w = field.length >= 30 ? Math.max(field.length, 40) : field.length;
        segs.push(<span key={`f${idx}`} className="gs-input-field" style={{ borderBottom: '2px solid var(--gs-green, #10b981)', display: 'inline-block', minWidth: `${w}ch` }}>{fc}</span>);
      } else if (field.is_reverse) {
        segs.push(<span key={`v${idx}`} style={{ color: '#ef4444', fontWeight: 'bold' }}>{fc}</span>);
      } else {
        segs.push(<span key={`h${idx}`} style={{ color: 'var(--gs-white, #FFFFFF)' }}>{fc}</span>);
      }
      lastEnd = fe;
    });
    if (lastEnd < line.length) segs.push(<span key="te">{renderTextWithUnderlines(line.substring(lastEnd), `r${rowIndex}e`)}</span>);
    return <>{segs}</>;
  }, [renderTextWithUnderlines, screenData?.cols, profile.defaultCols]);

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
          <div style={{ width: `${screenData?.cols || profile.defaultCols}ch`, height: `${(screenData?.rows || profile.defaultRows) * 21}px`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <InlineSignIn defaultProtocol={signInDefaultProtocol || protocol || 'tn5250'} loading={reconnecting} error={connectError} onConnect={handleSignIn} />
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
    const hasInputFields = fields.some(f => f.is_input);
    const hasCursor = screenData.cursor_row !== undefined && screenData.cursor_col !== undefined
      && (hasInputFields || screenData.cursor_row !== 0 || screenData.cursor_col !== 0);

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
              {hasCursor && index === cursor.row && (
                <span className="gs-cursor" style={{ position: 'absolute', left: `${cursor.col}ch`, width: '1ch', height: `${ROW_HEIGHT}px`, top: 0, pointerEvents: 'none' }} />
              )}
            </div>
          );
        })}
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

/** @deprecated Use GreenScreenTerminal instead */
export const TN5250Terminal = GreenScreenTerminal;
