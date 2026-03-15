import { useState, useMemo } from 'react'
import { GreenScreenTerminal, WebSocketAdapter } from 'green-screen-react'
import type { TerminalProtocol, TerminalAdapter, ConnectConfig } from 'green-screen-react'
import { mockScreens } from './mockScreens'
import { MockAdapter } from './MockAdapter'

const protocols: { key: TerminalProtocol; label: string; desc: string }[] = [
  { key: 'tn5250', label: 'TN5250', desc: 'IBM i / AS/400' },
  { key: 'tn3270', label: 'TN3270', desc: 'z/OS Mainframe' },
  { key: 'vt', label: 'VT220', desc: 'OpenVMS / Unix' },
  { key: 'hp6530', label: 'HP 6530', desc: 'NonStop' },
]

// Default Worker URL — update this after deploying the Cloudflare Worker
const DEFAULT_WORKER_URL = import.meta.env.VITE_WORKER_URL || ''

function ConnectPanel() {
  const [connected, setConnected] = useState(false)
  const [adapter, setAdapter] = useState<TerminalAdapter | null>(null)
  const [protocol, setProtocol] = useState<TerminalProtocol>('tn5250')
  const [error, setError] = useState<string | null>(null)
  const [connectedHost, setConnectedHost] = useState('')

  const handleConnect = async (config: ConnectConfig) => {
    setError(null)

    try {
      const wsAdapter = new WebSocketAdapter({ workerUrl: DEFAULT_WORKER_URL })
      const result = await wsAdapter.connect(config)

      if (result.success) {
        setAdapter(wsAdapter)
        setProtocol(config.protocol)
        setConnected(true)
        setConnectedHost(config.host)
      } else {
        setError(result.error || 'Connection failed')
        wsAdapter.dispose()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleDisconnect = () => {
    if (adapter && 'dispose' in adapter) {
      (adapter as WebSocketAdapter).dispose()
    }
    setAdapter(null)
    setConnected(false)
    setConnectedHost('')
  }

  if (connected && adapter) {
    return (
      <div>
        <div style={{ marginBottom: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="connect-status connected">Connected to {connectedHost}</span>
          <button className="disconnect-btn" onClick={handleDisconnect}>Disconnect</button>
        </div>
        <div className="terminal-wrapper">
          <GreenScreenTerminal
            adapter={adapter}
            protocol={protocol}
            inlineSignIn={false}
            pollInterval={500}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="connect-panel">
      <div className="connect-info">
        <h3>Connect to your system</h3>
        <p>
          Enter your host details to connect directly from this page.
          The connection is proxied through a Cloudflare Worker — no local proxy needed.
        </p>
        <div className="connect-note">
          Your credentials are sent directly to the target host and are not stored.
        </div>
      </div>

      <div className="connect-form">
        {error && <div className="connect-error">{error}</div>}

        <div className="terminal-wrapper" style={{ minHeight: 'auto' }}>
          <GreenScreenTerminal
            protocol={protocol}
            inlineSignIn={true}
            defaultProtocol="tn5250"
            pollInterval={0}
            readOnly={true}
            showHeader={false}
            bootLoader={false}
            typingAnimation={false}
            onSignIn={handleConnect}
          />
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [selected, setSelected] = useState<TerminalProtocol | 'connect'>('tn5250')

  // Create mock adapters — one per protocol, stable across re-renders
  const mockAdapters = useMemo(() => {
    const adapters: Record<TerminalProtocol, MockAdapter> = {} as any
    for (const p of protocols) {
      adapters[p.key] = new MockAdapter(mockScreens[p.key])
    }
    return adapters
  }, [])

  // Fall back to tn5250 if connect selected but no worker URL configured
  const effectiveSelected = (selected === 'connect' && !DEFAULT_WORKER_URL) ? 'tn5250' : selected
  const isProtocol = effectiveSelected !== 'connect'

  return (
    <div className="demo-page">
      <header className="demo-header">
        <h1 className="demo-title">green-screen-react</h1>
        <p className="demo-subtitle">Multi-protocol legacy terminal emulator for React</p>
      </header>

      <nav className="protocol-tabs">
        {protocols.map(({ key, label }) => (
          <button
            key={key}
            className={`protocol-tab ${selected === key ? 'active' : ''}`}
            onClick={() => setSelected(key)}
          >
            {label}
          </button>
        ))}
        {DEFAULT_WORKER_URL && (
          <button
            className={`protocol-tab connect-tab ${selected === 'connect' ? 'active' : ''}`}
            onClick={() => setSelected('connect')}
          >
            Connect
          </button>
        )}
      </nav>

      {isProtocol && (
        <div className="demo-hint">
          Click the terminal and start typing — this is a live interactive demo
        </div>
      )}

      <div className="terminal-wrapper">
        {isProtocol ? (
          <GreenScreenTerminal
            key={effectiveSelected}
            adapter={mockAdapters[effectiveSelected as TerminalProtocol]}
            protocol={effectiveSelected as TerminalProtocol}
            connectionStatus={{ connected: true, status: 'authenticated' }}
            inlineSignIn={false}
            pollInterval={500}
            typingAnimation={false}
          />
        ) : (
          <ConnectPanel />
        )}
      </div>

      <footer className="demo-footer">
        <code className="install-cmd">npm install green-screen-react</code>
        <a
          href="https://github.com/visionbridge-solutions/green-screen-react"
          className="github-link"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub &rarr;
        </a>
      </footer>
    </div>
  )
}
