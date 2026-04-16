import { useState, useEffect, useRef, useCallback } from 'react';

export interface UseAutoReconnectOptions {
  /** Whether auto-reconnect is enabled (default true) */
  enabled?: boolean;
  /** Maximum number of reconnect attempts (default 5) */
  maxAttempts?: number;
  /** Callback for notifications */
  onNotification?: (message: string, type: 'info' | 'error') => void;
}

export interface UseAutoReconnectResult {
  /** Current reconnect attempt number */
  attempt: number;
  /** Whether a reconnect is currently in progress */
  isReconnecting: boolean;
  /** Reset the reconnect state (e.g. for manual reconnect) */
  reset: () => void;
}

/**
 * Hook for auto-reconnecting to a terminal backend with exponential backoff.
 *
 * @param connected - Whether the terminal is currently connected
 * @param reconnecting - Whether a reconnect operation is in progress (from useTerminalConnection)
 * @param reconnect - Function to trigger a reconnect
 * @param options - Configuration options
 */
export function useAutoReconnect(
  connected: boolean,
  reconnecting: boolean,
  reconnect: () => Promise<{ success: boolean } | undefined>,
  options: UseAutoReconnectOptions = {},
): UseAutoReconnectResult {
  const {
    enabled = true,
    maxAttempts = 5,
    onNotification,
  } = options;

  const [attempt, setAttempt] = useState(0);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasConnectedRef = useRef(false);
  const isConnectedRef = useRef(false);

  useEffect(() => { isConnectedRef.current = connected; }, [connected]);

  useEffect(() => {
    if (!enabled) return;

    if (connected) {
      wasConnectedRef.current = true;
      if (reconnectTimeoutRef.current) { clearTimeout(reconnectTimeoutRef.current); reconnectTimeoutRef.current = null; }
      setAttempt(0);
      setIsReconnecting(false);
    } else if (wasConnectedRef.current && !connected && !isReconnecting && !reconnecting) {
      if (attempt < maxAttempts) {
        setIsReconnecting(true);
        const delay = Math.pow(2, attempt) * 1000;
        reconnectTimeoutRef.current = setTimeout(async () => {
          if (isConnectedRef.current) { setIsReconnecting(false); return; }
          onNotification?.(`Auto-reconnect attempt ${attempt + 1}/${maxAttempts}`, 'info');
          try {
            const result = await reconnect();
            if (!result?.success) setAttempt(prev => prev + 1);
          } catch {
            onNotification?.('Auto-reconnect failed', 'error');
            setAttempt(prev => prev + 1);
          }
          setIsReconnecting(false);
        }, delay);
      }
    }
    return () => { if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current); };
  }, [connected, attempt, isReconnecting, reconnecting, reconnect, enabled, maxAttempts, onNotification]);

  const reset = useCallback(() => {
    setAttempt(0);
    setIsReconnecting(false);
    if (reconnectTimeoutRef.current) { clearTimeout(reconnectTimeoutRef.current); reconnectTimeoutRef.current = null; }
  }, []);

  return { attempt, isReconnecting, reset };
}
