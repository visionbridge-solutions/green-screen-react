import { useState, useEffect } from 'react'
import { GreenScreenTerminal, WebSocketAdapter } from 'green-screen-react'
import type { TerminalAdapter, ConnectConfig } from 'green-screen-react'

// Default Worker URL — update this after deploying the Cloudflare Worker
const DEFAULT_WORKER_URL = import.meta.env.VITE_WORKER_URL || ''

const SESSION_KEY = 'green-screen-connect-config'

interface SavedSession {
  config: ConnectConfig
  sessionId: string
}

function saveSession(config: ConnectConfig, sessionId: string) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ config, sessionId })) } catch {}
}

function loadSession(): SavedSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY) } catch {}
}

function ConnectPanel({ standalone = false }: { standalone?: boolean }) {
  const [connected, setConnected] = useState(false)
  const [adapter, setAdapter] = useState<TerminalAdapter | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connectedHost, setConnectedHost] = useState('')
  const [restoring, setRestoring] = useState(true)

  const doConnect = async (config: ConnectConfig) => {
    const wsAdapter = new WebSocketAdapter({ workerUrl: DEFAULT_WORKER_URL })
    const result = await wsAdapter.connect(config)

    if (result.success) {
      setAdapter(wsAdapter)
      setConnected(true)
      setConnectedHost(config.host)
      saveSession(config, wsAdapter.sessionId!)
    } else {
      wsAdapter.dispose()
      throw new Error(result.error || 'Connection failed')
    }
  }

  // Restore session on mount — try reattaching to existing proxy session
  // (TCP connection stays alive across page reloads). Fall back to full
  // connect with auto-sign-in if the session is gone.
  useEffect(() => {
    const saved = loadSession()
    if (!saved) { setRestoring(false); return }

    const restore = async () => {
      const wsAdapter = new WebSocketAdapter({ workerUrl: DEFAULT_WORKER_URL })

      // Try reattach to existing proxy session first
      const result = await wsAdapter.reattach(saved.sessionId)
      if (result.success) {
        setAdapter(wsAdapter)
        setConnected(true)
        setConnectedHost(saved.config.host)
        // Update sessionId in case it changed
        saveSession(saved.config, wsAdapter.sessionId!)
        return
      }

      // Session gone — full connect with auto-sign-in
      wsAdapter.dispose()
      await doConnect(saved.config)
    }

    restore().catch(() => {
      clearSession()
    }).finally(() => setRestoring(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleConnect = async (config: ConnectConfig) => {
    setError(null)
    try {
      await doConnect(config)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleDisconnect = () => {
    if (adapter && 'disconnect' in adapter) {
      (adapter as WebSocketAdapter).disconnect()
    }
    setAdapter(null)
    setConnected(false)
    setConnectedHost('')
    clearSession()
  }

  if (restoring) {
    return (
      <div className={standalone ? 'standalone-page' : 'connect-panel'} style={{ textAlign: 'center', padding: standalone ? undefined : '3rem' }}>
        <p style={{ color: '#808080', fontFamily: 'var(--gs-font, monospace)', fontSize: '13px' }}>Reconnecting...</p>
      </div>
    )
  }

  if (connected && adapter) {
    if (standalone) {
      return (
        <div className="standalone-page">
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

  if (standalone) {
    return (
      <div className="standalone-page">
        <div className="terminal-wrapper">
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
    )
  }

  return (
    <div className="connect-panel">
      <div className="connect-info">
        <h3>Connect to your system</h3>
        <p>
          Enter your host details to connect directly from this page.
          The connection is proxied through the local proxy server or a Cloudflare Worker.
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
  const isStandalone = new URLSearchParams(window.location.search).get('mode') === 'standalone'

  useEffect(() => {
    if (isStandalone) {
      document.body.classList.add('standalone')
      document.title = 'Green Screen Terminal'
    }
    return () => { document.body.classList.remove('standalone') }
  }, [isStandalone])

  if (isStandalone) {
    return <ConnectPanel standalone />
  }

  return (
    <div className="demo-page">
      <header className="demo-header">
        <h1 className="demo-title">green-screen-react</h1>
        <p className="demo-subtitle">Multi-protocol legacy terminal emulator for React</p>
      </header>

      <ConnectPanel />

      <footer className="demo-footer">
        <code className="install-cmd">npx green-screen-terminal</code>
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
