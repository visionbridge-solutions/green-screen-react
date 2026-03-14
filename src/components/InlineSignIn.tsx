import React, { useState } from 'react';
import type { TerminalProtocol, ConnectConfig } from '../adapters/types';
import { TerminalIcon, AlertTriangleIcon } from './Icons';

const PROTOCOL_OPTIONS: { value: TerminalProtocol; label: string }[] = [
  { value: 'tn5250', label: 'TN5250 (IBM i)' },
  { value: 'tn3270', label: 'TN3270 (Mainframe)' },
  { value: 'vt', label: 'VT220' },
  { value: 'hp6530', label: 'HP 6530 (NonStop)' },
];

export interface InlineSignInProps {
  defaultProtocol: TerminalProtocol;
  loading: boolean;
  error: string | null;
  onConnect: (config: ConnectConfig) => void;
}

export function InlineSignIn({ defaultProtocol, loading, error, onConnect }: InlineSignInProps) {
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
