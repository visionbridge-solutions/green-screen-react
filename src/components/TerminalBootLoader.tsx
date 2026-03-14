import React, { useState, useEffect, useRef } from 'react';

export interface TerminalBootLoaderProps {
  /** Text to display during boot animation */
  brandText?: string;
  /** Speed in ms per character */
  charSpeed?: number;
  /** Optional logo element to render alongside the text */
  logo?: React.ReactNode;
  /** Height of the boot loader container */
  height?: number | string;
}

/**
 * Animated boot loader for the terminal.
 * Shows a typewriter-style text reveal animation.
 */
export function TerminalBootLoader({
  brandText = 'TERMINAL',
  charSpeed = 80,
  logo,
  height = 504,
}: TerminalBootLoaderProps) {
  const [charCount, setCharCount] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setCharCount(prev => {
        if (prev >= brandText.length) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          return prev;
        }
        return prev + 1;
      });
    }, charSpeed);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [brandText, charSpeed]);

  const displayed = brandText.substring(0, charCount);

  return (
    <div
      className="gs-boot-loader"
      style={{
        height: typeof height === 'number' ? `${height}px` : height,
        backgroundColor: 'var(--gs-bg, #000)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--gs-font)',
        fontSize: '13px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        {logo}
        <h1
          style={{
            fontFamily: 'var(--gs-font)',
            fontSize: '1.5rem',
            letterSpacing: '0.1em',
            color: 'var(--gs-green, #10b981)',
            textShadow: '0 0 12px rgba(16, 185, 129, 0.4)',
            margin: 0,
          }}
        >
          {displayed}
          <span
            className="tn5250-cursor"
            style={{
              display: 'inline-block',
              width: '0.6ch',
              height: '1.2em',
              verticalAlign: 'middle',
              marginLeft: '2px',
            }}
          />
        </h1>
      </div>
    </div>
  );
}
