import React, { useEffect, useState } from 'react';
import type { TerminalProtocol, ConnectConfig } from '../adapters/types';
import { TerminalIcon, AlertTriangleIcon, RefreshIcon } from './Icons';

/**
 * Persist non-secret sign-in fields (host, port, protocol, terminal type,
 * username) to localStorage so returning users don't retype them. The
 * password is intentionally excluded and must be re-entered each session.
 */
const STORAGE_KEY = 'green-screen:inline-signin';

interface StoredSignIn {
  host?: string;
  port?: string;
  protocol?: TerminalProtocol;
  terminalType?: string;
  username?: string;
}

function loadStored(): StoredSignIn {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveStored(value: StoredSignIn): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // localStorage unavailable (private mode, quota) — silently ignore
  }
}

const PROTOCOL_OPTIONS: { value: TerminalProtocol; label: string }[] = [
  { value: 'tn5250', label: 'TN5250 (IBM i)' },
  { value: 'tn3270', label: 'TN3270 (Mainframe)' },
  { value: 'vt', label: 'VT220' },
  { value: 'hp6530', label: 'HP 6530 (NonStop)' },
];

/** Terminal type options per protocol (only protocols with >1 option need a dropdown) */
const TERMINAL_TYPE_OPTIONS: Partial<Record<TerminalProtocol, { value: string; label: string }[]>> = {
  tn5250: [
    { value: 'IBM-3179-2', label: '24 × 80 (Standard)' },
    { value: 'IBM-3477-FC', label: '27 × 132 (Wide)' },
  ],
  tn3270: [
    { value: 'IBM-3278-2', label: '24 × 80 (Model 2)' },
    { value: 'IBM-3278-3', label: '32 × 80 (Model 3)' },
    { value: 'IBM-3278-4', label: '43 × 80 (Model 4)' },
    { value: 'IBM-3278-5', label: '27 × 132 (Model 5)' },
  ],
};

export interface InlineSignInProps {
  defaultProtocol: TerminalProtocol;
  loading: boolean;
  error: string | null;
  onConnect: (config: ConnectConfig) => void;
}

export function InlineSignIn({ defaultProtocol, loading: externalLoading, error, onConnect }: InlineSignInProps) {
  const stored = loadStored();
  const [host, setHost] = useState(stored.host ?? '');
  const [port, setPort] = useState(stored.port ?? '');
  const [selectedProtocol, setSelectedProtocol] = useState<TerminalProtocol>(stored.protocol ?? defaultProtocol);
  const [terminalType, setTerminalType] = useState(stored.terminalType ?? '');
  const [username, setUsername] = useState(stored.username ?? '');
  const [password, setPassword] = useState('');

  // Persist non-secret fields on change. Password is never written.
  useEffect(() => {
    saveStored({
      host,
      port,
      protocol: selectedProtocol,
      terminalType,
      username,
    });
  }, [host, port, selectedProtocol, terminalType, username]);

  const termTypeOptions = TERMINAL_TYPE_OPTIONS[selectedProtocol];
  const [submitted, setSubmitted] = useState(false);

  const loading = externalLoading || submitted;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    onConnect({
      host,
      port: port ? parseInt(port, 10) : 23,
      protocol: selectedProtocol,
      ...(username.trim() ? { username: username.trim() } : {}),
      ...(password ? { password } : {}),
      ...(terminalType ? { terminalType } : {}),
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

  if (loading) {
    return (
      <div className="gs-signin" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
        <RefreshIcon size={28} className="gs-spin" />
        <div style={{ fontSize: '11px', letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--gs-muted)', fontFamily: 'var(--gs-font)' }}>
          Connecting to {host || 'host'}...
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="gs-signin">
      <div style={{ textAlign: 'center', marginBottom: '16px' }}>
        <TerminalIcon size={28} />
        <div style={{ fontSize: '11px', letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--gs-muted)', marginTop: '8px' }}>Connect to Host</div>
      </div>

      <div className="gs-signin-row">
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Host <span style={{ color: '#ef4444' }}>*</span></label>
          <input style={inputStyle} value={host} onChange={e => setHost(e.target.value)} placeholder="192.168.1.100" required autoFocus />
        </div>
        <div style={{ width: '72px' }}>
          <label style={labelStyle}>Port</label>
          <input style={inputStyle} value={port} onChange={e => setPort(e.target.value)} placeholder="23" type="number" min="1" max="65535" />
        </div>
      </div>

      <div>
        <label style={labelStyle}>Protocol <span style={{ color: '#ef4444' }}>*</span></label>
        <select style={{ ...inputStyle, appearance: 'none' }} value={selectedProtocol} onChange={e => { setSelectedProtocol(e.target.value as TerminalProtocol); setTerminalType(''); }}>
          {PROTOCOL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {termTypeOptions && termTypeOptions.length > 1 && (
        <div>
          <label style={labelStyle}>Screen Size</label>
          <select style={{ ...inputStyle, appearance: 'none' }} value={terminalType || termTypeOptions[0].value} onChange={e => setTerminalType(e.target.value)}>
            {termTypeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      )}

      <div>
        <label style={labelStyle}>Username</label>
        <input style={inputStyle} value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" />
      </div>

      <div>
        <label style={labelStyle}>Password</label>
        <input style={inputStyle} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
      </div>

      {error && (
        <div style={{ color: '#FF6B00', fontSize: '11px', fontFamily: 'var(--gs-font)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <AlertTriangleIcon size={12} />
          <span>{error}</span>
        </div>
      )}

      <button type="submit" disabled={!host} className="gs-signin-btn">
        Connect
      </button>
    </form>
  );
}
