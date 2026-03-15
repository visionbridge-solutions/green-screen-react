import { useState, useMemo } from 'react'
import { GreenScreenTerminal, WebSocketAdapter } from 'green-screen-react'
import type { TerminalAdapter, ConnectConfig } from 'green-screen-react'
import { tn5250ScreenTree } from './mockScreens'
import { MockAdapter } from './MockAdapter'

// Default Worker URL — update this after deploying the Cloudflare Worker
const DEFAULT_WORKER_URL = import.meta.env.VITE_WORKER_URL || ''

function ConnectPanel() {
  const [connected, setConnected] = useState(false)
  const [adapter, setAdapter] = useState<TerminalAdapter | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connectedHost, setConnectedHost] = useState('')

  const handleConnect = async (config: ConnectConfig) => {
    setError(null)

    try {
      const wsAdapter = new WebSocketAdapter({ workerUrl: DEFAULT_WORKER_URL })
      const result = await wsAdapter.connect(config)

      if (result.success) {
        setAdapter(wsAdapter)
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
            protocol="tn5250"
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
            protocol="tn5250"
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
  const [selected, setSelected] = useState<'connect' | 'mock'>(DEFAULT_WORKER_URL ? 'connect' : 'mock')

  // Create interactive TN5250 mock adapter with screen tree
  const mockAdapter = useMemo(() => new MockAdapter(tn5250ScreenTree, 'main'), [])

  return (
    <div className="demo-page">
      <header className="demo-header">
        <h1 className="demo-title">green-screen-react</h1>
        <p className="demo-subtitle">Multi-protocol legacy terminal emulator for React</p>
      </header>

      <nav className="protocol-tabs">
        {DEFAULT_WORKER_URL && (
          <button
            className={`protocol-tab connect-tab ${selected === 'connect' ? 'active' : ''}`}
            onClick={() => setSelected('connect')}
          >
            Connect
          </button>
        )}
        <button
          className={`protocol-tab ${selected === 'mock' ? 'active' : ''}`}
          onClick={() => setSelected('mock')}
        >
          TN5250 Mock Preview
        </button>
      </nav>

      {selected === 'mock' && (
        <div className="demo-hint">
          Click the terminal and start typing — this is a live interactive demo
        </div>
      )}

      <div className="terminal-wrapper">
        {selected === 'mock' ? (
          <GreenScreenTerminal
            key="mock"
            adapter={mockAdapter}
            protocol="tn5250"
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
