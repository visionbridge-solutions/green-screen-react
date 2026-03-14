import { useState, useCallback, useEffect, useRef } from 'react';
import type { TerminalAdapter, ScreenData, ConnectionStatus, SendResult, ConnectConfig } from '../adapters/types';

/**
 * Hook for terminal connection management via adapter.
 */
export function useTerminalConnection(adapter: TerminalAdapter) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const result = await adapter.getStatus();
      setStatus(result);
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return null;
    }
  }, [adapter]);

  const connect = useCallback(async (config?: ConnectConfig) => {
    setLoading(true);
    setError(null);
    try {
      const result = await adapter.connect(config);
      return { ...result, success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return { success: false, error: message };
    } finally {
      setLoading(false);
    }
  }, [adapter]);

  const disconnect = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await adapter.disconnect();
      setStatus(prev => prev ? { ...prev, connected: false, status: 'disconnected' } : null);
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return { success: false, error: message };
    } finally {
      setLoading(false);
    }
  }, [adapter]);

  const reconnect = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await adapter.reconnect();
      return { ...result, success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return { success: false, error: message };
    } finally {
      setLoading(false);
    }
  }, [adapter]);

  return { status, loading, error, fetchStatus, connect, disconnect, reconnect };
}

/**
 * Hook for terminal screen content with polling.
 */
export function useTerminalScreen(
  adapter: TerminalAdapter,
  interval: number = 2000,
  enabled: boolean = true,
) {
  const [data, setData] = useState<ScreenData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }

    const poll = async () => {
      try {
        const screen = await adapter.getScreen();
        if (screen) setData(screen);
        setError(null);
      } catch (err) {
        setError(err);
      }
    };

    poll(); // Initial fetch
    intervalRef.current = setInterval(poll, interval);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [adapter, interval, enabled]);

  return { data, error };
}

/**
 * Hook for terminal operations (sendText, sendKey).
 */
export function useTerminalInput(adapter: TerminalAdapter) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendText = useCallback(async (text: string): Promise<SendResult> => {
    setLoading(true);
    setError(null);
    try {
      const result = await adapter.sendText(text);
      return { ...result, success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return { success: false, error: message };
    } finally {
      setLoading(false);
    }
  }, [adapter]);

  const sendKey = useCallback(async (key: string): Promise<SendResult> => {
    setLoading(true);
    setError(null);
    try {
      const result = await adapter.sendKey(key);
      return { ...result, success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return { success: false, error: message };
    } finally {
      setLoading(false);
    }
  }, [adapter]);

  return { loading, error, sendText, sendKey };
}
