import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { TerminalAdapter, ScreenData, ConnectionStatus, SendResult, Field } from '../adapters/types';
import { useTerminalScreen, useTerminalInput, useTerminalConnection } from './useTerminal';
import { useTypingAnimation } from './useTypingAnimation';

/**
 * True if the screen content is effectively empty — all spaces, NULs, or
 * whitespace. Used to detect the "host blanked the screen but hasn't sent
 * replacement content yet" transit state.
 */
function isBlankContent(content: string | undefined): boolean {
  if (!content) return true;
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i);
    if (ch !== 0x20 && ch !== 0x09 && ch !== 0x0a && ch !== 0x0d && ch !== 0x00 && ch !== 0xa0) {
      return false;
    }
  }
  return true;
}

export interface UseTerminalStateOptions {
  /** Adapter for communicating with the terminal backend */
  adapter: TerminalAdapter;
  /** Polling interval in ms (0 to disable; default 2000) */
  pollInterval?: number;
  /** Direct screen data injection (bypasses polling) */
  externalScreenData?: ScreenData | null;
  /** Direct connection status injection */
  externalStatus?: ConnectionStatus | null;
  /** Enable typing animation (default false) */
  typingAnimation?: boolean;
  /** Typing animation budget in ms (default 60) */
  typingBudgetMs?: number;
  /** Callback when screen content changes */
  onScreenChange?: (screen: ScreenData) => void;
}

export interface UseTerminalStateResult {
  /** Processed screen data (with typing animation applied) */
  screenData: ScreenData | null;
  /** Raw screen data before typing animation */
  rawScreenData: ScreenData | null;
  /** Connection status */
  connectionStatus: ConnectionStatus;
  /** Send text input */
  sendText: (text: string) => Promise<SendResult>;
  /** Send a special key */
  sendKey: (key: string) => Promise<SendResult>;
  /** Establish a connection */
  connect: (config?: any) => Promise<{ success: boolean; error?: string }>;
  /** Reconnect */
  reconnect: () => Promise<{ success: boolean; error?: string }>;
  /** Whether a reconnect is in progress */
  reconnecting: boolean;
  /** Connection error */
  connectError: string | null;
  /** Screen polling error */
  screenError: unknown;
  /** Whether the host is in a busy (blank+locked) state */
  isBusy: boolean;
  /** How long the busy state has lasted (ms) */
  busyElapsedMs: number;
  /** Whether the busy overlay should be shown (after delay) */
  showBusyOverlay: boolean;
  /** Animated cursor position (from typing animation) or null */
  animatedCursorPos: { row: number; col: number } | null;
}

const BUSY_OVERLAY_DELAY_MS = 600;

/**
 * Core terminal state management hook.
 *
 * Bundles screen data polling, blank-screen stashing, busy overlay timing,
 * typing animation, and connection management. Use this hook to build a
 * fully custom terminal UI without the GreenScreenTerminal component.
 */
export function useTerminalState(options: UseTerminalStateOptions): UseTerminalStateResult {
  const {
    adapter,
    pollInterval = 2000,
    externalScreenData,
    externalStatus,
    typingAnimation = false,
    typingBudgetMs = 60,
    onScreenChange,
  } = options;

  // --- Data sources ---
  const shouldPoll = pollInterval > 0 && !externalScreenData;
  const { data: polledScreenData, error: screenError } = useTerminalScreen(adapter, pollInterval, shouldPoll);
  const { sendText: _sendText, sendKey: _sendKey } = useTerminalInput(adapter);
  const { connect, reconnect, loading: reconnecting, error: connectError } = useTerminalConnection(adapter);

  const incomingScreenData = externalScreenData ?? polledScreenData;

  // --- Sticky last-contentful screen ---
  const lastContentfulRef = useRef<ScreenData | null>(null);
  useEffect(() => {
    if (incomingScreenData && !isBlankContent(incomingScreenData.content)) {
      lastContentfulRef.current = incomingScreenData;
    }
  }, [incomingScreenData]);

  const isBlankLocked = !!(
    incomingScreenData &&
    incomingScreenData.keyboard_locked &&
    isBlankContent(incomingScreenData.content)
  );

  const rawScreenData = useMemo(() => {
    if (isBlankLocked && lastContentfulRef.current) {
      return { ...lastContentfulRef.current, keyboard_locked: true };
    }
    return incomingScreenData;
  }, [incomingScreenData, isBlankLocked]);

  // --- Busy overlay timer ---
  const [lockElapsedMs, setLockElapsedMs] = useState(0);
  useEffect(() => {
    if (!isBlankLocked) {
      setLockElapsedMs(0);
      return;
    }
    const start = Date.now();
    setLockElapsedMs(0);
    const id = setInterval(() => setLockElapsedMs(Date.now() - start), 250);
    return () => clearInterval(id);
  }, [isBlankLocked]);
  const showBusyOverlay = isBlankLocked && lockElapsedMs >= BUSY_OVERLAY_DELAY_MS;

  // --- Connection status ---
  const connectionStatus = externalStatus ?? (rawScreenData ? { connected: true, status: 'authenticated' as const } : { connected: false, status: 'disconnected' as const });

  // --- Typing animation ---
  const { displayedContent, animatedCursorPos } = useTypingAnimation(
    rawScreenData?.content,
    typingAnimation,
    typingBudgetMs,
  );

  const screenData = useMemo(() => {
    if (!rawScreenData) return null;
    return { ...rawScreenData, content: displayedContent };
  }, [rawScreenData, displayedContent]);

  // --- Notify parent on screen changes ---
  const prevScreenSigRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (screenData && onScreenChange && screenData.screen_signature !== prevScreenSigRef.current) {
      prevScreenSigRef.current = screenData.screen_signature;
      onScreenChange(screenData);
    }
  }, [screenData, onScreenChange]);

  const sendText = useCallback(async (text: string) => _sendText(text), [_sendText]);
  const sendKey = useCallback(async (key: string) => _sendKey(key), [_sendKey]);

  return {
    screenData: screenData ?? null,
    rawScreenData: rawScreenData ?? null,
    connectionStatus,
    sendText,
    sendKey,
    connect,
    reconnect,
    reconnecting,
    connectError,
    screenError,
    isBusy: isBlankLocked,
    busyElapsedMs: lockElapsedMs,
    showBusyOverlay,
    animatedCursorPos,
  };
}
