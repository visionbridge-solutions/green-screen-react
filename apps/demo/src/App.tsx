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

      // Reattach failed — the saved session may still be alive on the
      // proxy as an orphaned controller (different browser session, or
      // the reattach path didn't find it for some reason). Fire a beacon
      // to destroy it before we spin up a new session. Without this the
      // old orphan lingers until its TTL expires, counting against the
      // host's LMTDEVSSN quota (CPF1220).
      try {
        const url = `${DEFAULT_WORKER_URL || 'http://localhost:3001'}/disconnect-beacon`
        const blob = new Blob([JSON.stringify({ sessionId: saved.sessionId })], { type: 'application/json' })
        navigator.sendBeacon(url, blob)
      } catch { /* ignore */ }

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

  const handleDisconnect = async () => {
    // Await the adapter's disconnect so the UI only transitions to
    // "disconnected" after the server has acked the SIGNOFF round-trip.
    // Otherwise we'd race the server teardown and leak a half-open 5250
    // session on the host (IBM i + LMTDEVSSN=*YES → CPF1220 on next login).
    if (adapter && 'disconnect' in adapter) {
      try { await (adapter as WebSocketAdapter).disconnect() } catch { /* ignore */ }
    }
    setAdapter(null)
    setConnected(false)
    setConnectedHost('')
    clearSession()
  }

  // Page unload fallback: if the user closes the tab or navigates away
  // without clicking Disconnect, fire a beacon to tear down the session
  // server-side. `navigator.sendBeacon` is the only reliable way to send
  // a request during page unload — fetch/WS writes get silently dropped.
  useEffect(() => {
    if (!adapter) return
    const sessionId = (adapter as WebSocketAdapter).sessionId
    if (!sessionId) return

    const onPageHide = () => {
      try {
        const url = `${DEFAULT_WORKER_URL || 'http://localhost:3001'}/disconnect-beacon`
        const blob = new Blob([JSON.stringify({ sessionId })], { type: 'application/json' })
        navigator.sendBeacon(url, blob)
      } catch { /* ignore */ }
    }

    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [adapter])

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
          Credentials are sent directly to the target host. Your password is never stored;
          other connection details (host, port, protocol, username) are saved in this
          browser&rsquo;s local storage for convenience.
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
