import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { TN5250Adapter, ScreenData, ConnectionStatus, Field } from '../adapters/types';
import { useTN5250Screen, useTN5250Terminal as useTN5250TerminalHook, useTN5250Connection } from '../hooks/useTN5250';
import { useTypingAnimation } from '../hooks/useTypingAnimation';
import { getRowColorClass, parseHeaderRow } from '../utils/rendering';
import { TerminalBootLoader as DefaultBootLoader } from './TerminalBootLoader';

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

/* ── Component Props ──────────────────────────────────────────────── */

export interface TN5250TerminalProps {
  /** Adapter for communicating with the TN5250 backend */
  adapter: TN5250Adapter;
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
 * TN5250 Terminal — Web-based IBM 5250 terminal emulator component.
 *
 * Renders a 24x80 (or 27x132) terminal screen with:
 * - Green-on-black terminal aesthetic with IBM 5250 color conventions
 * - Connection status indicator
 * - Keyboard input support (text, function keys, tab)
 * - Auto-reconnect with exponential backoff
 * - Typing animation for field entries
 * - Focus lock mode for keyboard capture
 */
export function TN5250Terminal({
  adapter,
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
  bootLoader,
  headerRight,
  overlay,
  onNotification,
  onScreenChange,
  onMinimize,
  className,
  style,
}: TN5250TerminalProps) {
  // --- Data sources ---
  const shouldPoll = pollInterval > 0 && !externalScreenData;
  const { data: polledScreenData, error: screenError } = useTN5250Screen(adapter, pollInterval, shouldPoll);
  const { sendText: _sendText, sendKey: _sendKey } = useTN5250TerminalHook(adapter);
  const { reconnect, loading: reconnecting } = useTN5250Connection(adapter);

  const rawScreenData = externalScreenData ?? polledScreenData;

  const tn5250Status = externalStatus ?? (rawScreenData ? { connected: true, status: 'authenticated' as const } : { connected: false, status: 'disconnected' as const });

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

  useEffect(() => { isConnectedRef.current = tn5250Status?.connected ?? false; }, [tn5250Status?.connected]);

  useEffect(() => {
    if (!autoReconnectEnabled) return;
    const isConnected = tn5250Status?.connected;

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
  }, [tn5250Status?.connected, autoReconnectAttempt, isAutoReconnecting, reconnecting, reconnect, autoReconnectEnabled, maxAttempts, onNotification]);

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
  const getCursorPos = () => {
    if (animatedCursorPos) return animatedCursorPos;
    let cursorRow = syncedCursor?.row ?? screenData?.cursor_row ?? 0;
    let cursorCol = (syncedCursor?.col ?? screenData?.cursor_col ?? 0) + inputText.length;
    while (cursorCol >= 80) { cursorCol -= 80; cursorRow += 1; }
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
      segments.push(<span key={`${keyPrefix}-u-${segmentIndex}`} style={{ borderBottom: '1px solid var(--tn5250-green, #10b981)', display: 'inline-block', width: `${count}ch` }}>{' '.repeat(count)}</span>);
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
    const termCols = screenData?.cols || 80;

    sorted.forEach((field, idx) => {
      const fs = field.col;
      const fe = Math.min(field.col + field.length, termCols);
      if (fs > lastEnd) segs.push(<span key={`t${idx}`}>{renderTextWithUnderlines(line.substring(lastEnd, fs), `r${rowIndex}p${idx}`)}</span>);
      const fc = line.substring(fs, fe);
      if (field.is_input) {
        const w = field.length >= 30 ? Math.max(field.length, 40) : field.length;
        segs.push(<span key={`f${idx}`} className="tn5250-input-field" style={{ borderBottom: '2px solid var(--tn5250-green, #10b981)', display: 'inline-block', minWidth: `${w}ch` }}>{fc}</span>);
      } else if (field.is_reverse) {
        segs.push(<span key={`v${idx}`} style={{ color: '#ef4444', fontWeight: 'bold' }}>{fc}</span>);
      } else {
        segs.push(<span key={`h${idx}`} style={{ color: 'var(--tn5250-white, #FFFFFF)' }}>{fc}</span>);
      }
      lastEnd = fe;
    });
    if (lastEnd < line.length) segs.push(<span key="te">{renderTextWithUnderlines(line.substring(lastEnd), `r${rowIndex}e`)}</span>);
    return <>{segs}</>;
  }, [renderTextWithUnderlines, screenData?.cols]);

  // --- Screen rendering ---
  const renderScreen = () => {
    if (showBootLoader && !screenData?.content) {
      if (bootLoader === false) return null;
      if (bootLoader) return <>{bootLoader}</>;
      return <DefaultBootLoader />;
    }
    if (bootFadingOut && screenData?.content) return <div className="tn5250-fade-in">{renderScreenContent()}</div>;
    if (!screenData?.content) {
      return (
        <div style={{ width: `${screenData?.cols || 80}ch`, height: `${(screenData?.rows || 24) * 21}px`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ color: '#808080', marginBottom: '12px' }}><TerminalIcon size={40} /></div>
            <p style={{ fontFamily: 'var(--tn5250-font)', fontSize: '12px', color: '#808080' }}>
              {tn5250Status?.connected ? 'Waiting for screen data...' : 'Not connected'}
            </p>
          </div>
        </div>
      );
    }
    return renderScreenContent();
  };

  const renderScreenContent = () => {
    if (!screenData?.content) return null;
    const termRows = screenData.rows || 24;
    const termCols = screenData.cols || 80;
    const lines = screenData.content.split('\n');
    const rows: string[] = [];
    for (let i = 0; i < termRows; i++) rows.push((lines[i] || '').padEnd(termCols, ' '));

    const fields = screenData.fields || [];
    const ROW_HEIGHT = 21;
    const cursor = getCursorPos();
    const hasInputFields = fields.some(f => f.is_input);
    const hasCursor = screenData.cursor_row !== undefined && screenData.cursor_col !== undefined
      && (hasInputFields || screenData.cursor_row !== 0 || screenData.cursor_col !== 0);

    return (
      <div style={{ fontFamily: 'var(--tn5250-font)', fontSize: '13px', position: 'relative', width: `${termCols}ch` }}>
        {rows.map((line, index) => {
          let displayLine = line;
          if (hasCursor && index === cursor.row && inputText && !animatedCursorPos) {
            const baseCol = syncedCursor?.col ?? screenData.cursor_col ?? 0;
            displayLine = (line.substring(0, baseCol) + inputText + line.substring(baseCol + inputText.length)).substring(0, termCols).padEnd(termCols, ' ');
          }
          const headerSegments = index === 0 ? parseHeaderRow(displayLine) : null;
          return (
            <div key={index} className={headerSegments ? '' : getRowColorClass(index, displayLine)} style={{ height: `${ROW_HEIGHT}px`, lineHeight: `${ROW_HEIGHT}px`, whiteSpace: 'pre', position: 'relative' }}>
              {headerSegments
                ? headerSegments.map((seg, i) => <span key={i} className={seg.colorClass}>{seg.text}</span>)
                : renderRowWithFields(displayLine, index, fields)}
              {hasCursor && index === cursor.row && (
                <span className="tn5250-cursor" style={{ position: 'absolute', left: `${cursor.col}ch`, width: '1ch', height: `${ROW_HEIGHT}px`, top: 0, pointerEvents: 'none' }} />
              )}
            </div>
          );
        })}
        {screenData.cursor_row !== undefined && screenData.cursor_col !== undefined && (
          <span style={{ position: 'absolute', bottom: 0, right: 0, fontFamily: 'var(--tn5250-font)', fontSize: '10px', color: 'var(--tn5250-green, #10b981)', pointerEvents: 'none', opacity: 0.6 }}>
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
      case 'authenticated': return 'var(--tn5250-green, #10b981)';
      case 'connected': return '#F59E0B';
      case 'connecting': return '#64748b';
      case 'error': return '#EF4444';
      default: return '#64748b';
    }
  };

  return (
    <div className={`tn5250-terminal ${isFocused ? 'tn5250-terminal-focused' : ''} ${className || ''}`} style={style}>
      {showHeader && (
        <div className="tn5250-header">
          {embedded ? (
            <>
              <span className="tn5250-header-left">
                <TerminalIcon size={14} />
                <span>TERMINAL</span>
                {isFocused && <span className="tn5250-badge-focused">FOCUSED</span>}
                {screenData?.timestamp && <span className="tn5250-timestamp">{new Date(screenData.timestamp).toLocaleTimeString()}</span>}
                <span className="tn5250-hint">{readOnly ? 'Read-only' : isFocused ? 'ESC to exit focus' : 'Click to control'}</span>
              </span>
              <div className="tn5250-header-right">
                {tn5250Status?.status && <KeyIcon size={12} style={{ color: getStatusColor(tn5250Status.status) }} />}
                {tn5250Status && (tn5250Status.connected
                  ? <WifiIcon size={12} style={{ color: 'var(--tn5250-green, #10b981)' }} />
                  : <WifiOffIcon size={12} style={{ color: '#FF6B00' }} />)}
                {onMinimize && <button onClick={(e) => { e.stopPropagation(); onMinimize(); }} className="tn5250-btn-icon" title="Minimize terminal"><MinimizeIcon /></button>}
                {headerRight}
              </div>
            </>
          ) : (
            <>
              <span className="tn5250-header-left">
                <TerminalIcon size={14} />
                <span>TN5250 TERMINAL</span>
                {isFocused && <span className="tn5250-badge-focused">FOCUSED</span>}
                {screenData?.timestamp && <span className="tn5250-timestamp">{new Date(screenData.timestamp).toLocaleTimeString()}</span>}
                <span className="tn5250-hint">{readOnly ? 'Read-only mode' : isFocused ? 'ESC to exit focus' : 'Click terminal to control'}</span>
              </span>
              <div className="tn5250-header-right">
                {tn5250Status && (
                  <div className="tn5250-status-group">
                    {tn5250Status.connected ? (
                      <>
                        <WifiIcon size={12} style={{ color: 'var(--tn5250-green, #10b981)' }} />
                        <span className="tn5250-host">{tn5250Status.host}</span>
                      </>
                    ) : (
                      <>
                        <WifiOffIcon size={12} style={{ color: '#FF6B00' }} />
                        <span className="tn5250-disconnected-text">
                          {isAutoReconnecting || reconnecting
                            ? `RECONNECTING${autoReconnectAttempt > 0 ? ` (${autoReconnectAttempt}/${maxAttempts})` : '...'}`
                            : autoReconnectAttempt >= maxAttempts ? 'DISCONNECTED (auto-retry exhausted)' : 'DISCONNECTED'}
                        </span>
                        <button onClick={handleReconnect} disabled={reconnecting || isAutoReconnecting} className="tn5250-btn-icon" title="Reconnect">
                          <RefreshIcon size={12} className={reconnecting || isAutoReconnecting ? 'tn5250-spin' : ''} />
                        </button>
                      </>
                    )}
                  </div>
                )}
                {tn5250Status?.status && (
                  <div className="tn5250-status-group">
                    <KeyIcon size={12} style={{ color: getStatusColor(tn5250Status.status) }} />
                    {tn5250Status.username && <span className="tn5250-host">{tn5250Status.username}</span>}
                  </div>
                )}
                {headerRight}
              </div>
            </>
          )}
        </div>
      )}

      <div className="tn5250-body">
        <div ref={terminalRef} onClick={handleTerminalClick} className={`tn5250-screen ${embedded ? 'tn5250-screen-embedded' : ''}`}
          style={!embedded ? { width: `calc(${screenData?.cols || 80}ch + 24px)`, fontSize: (screenData?.cols ?? 80) > 80 ? '11px' : '13px', fontFamily: 'var(--tn5250-font)' } : undefined}>
          {screenError != null && (
            <div className="tn5250-error-banner">
              <AlertTriangleIcon size={14} />
              <span>{String(screenError)}</span>
            </div>
          )}
          <div className="tn5250-screen-content">{renderScreen()}</div>
          {overlay}
          {tn5250Status && !tn5250Status.connected && screenData && (
            <div className="tn5250-overlay">
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
