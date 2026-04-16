import { useState, useEffect, createContext, useContext } from 'react'
import { GreenScreenTerminal, WebSocketAdapter } from 'green-screen-react'
import type { TerminalAdapter, ConnectConfig } from 'green-screen-react'

// --- Theme context (demo-app only) ---
// The theme picker lives outside the terminal and drives the `theme` prop
// passed to <GreenScreenTerminal>. This demonstrates how an integrator can
// swap visual presets at runtime without remounting the terminal.
type DemoTheme = 'modern' | 'classic'
const ThemeContext = createContext<{ theme: DemoTheme; setTheme: (t: DemoTheme) => void }>({
  theme: 'modern',
  setTheme: () => {},
})

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
  const [connectedConfig, setConnectedConfig] = useState<ConnectConfig | null>(null)
  const [restoring, setRestoring] = useState(true)

  const doConnect = async (config: ConnectConfig) => {
    const wsAdapter = new WebSocketAdapter({ workerUrl: DEFAULT_WORKER_URL })
    const result = await wsAdapter.connect(config)

    if (result.success) {
      setAdapter(wsAdapter)
      setConnected(true)
      setConnectedConfig(config)
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
        setConnectedConfig(saved.config)
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

  // Called by the terminal component after its built-in Disconnect button
  // tears down the adapter. Clears demo-side state (adapter ref, session
  // storage, connected flag) so we don't leak a stale reference.
  const handleDisconnect = () => {
    setAdapter(null)
    setConnected(false)
    setConnectedConfig(null)
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
        <p style={{ color: '#6c7086', fontFamily: 'var(--gs-font, monospace)', fontSize: '13px' }}>Reconnecting...</p>
      </div>
    )
  }

  if (connected && adapter) {
    // Pass host + username via connectionStatus so they appear in the
    // terminal's built-in header. The terminal's own Disconnect button
    // tears down the adapter; onDisconnect clears demo-side state.
    const connectionStatus = {
      connected: true,
      status: 'authenticated' as const,
      host: connectedConfig?.host,
      username: connectedConfig?.username,
    }
    if (standalone) {
      // Standalone mode (?mode=standalone) is what ships as the
      // `green-screen-terminal` npm package. The theme sticker is a
      // demo-landing-page flourish only — never render it in standalone
      // output.
      return (
        <div className="standalone-page">
          <div className="terminal-wrapper">
            <ThemedTerminal
              adapter={adapter}
              protocol="tn5250"
              inlineSignIn={false}
              pollInterval={500}
              connectionStatus={connectionStatus}
              onDisconnect={handleDisconnect}
              alwaysFocused
            />
          </div>
        </div>
      )
    }
    return (
      <div className="terminal-wrapper">
        <ThemeSticker />
        <ThemedTerminal
          adapter={adapter}
          protocol="tn5250"
          inlineSignIn={false}
          pollInterval={500}
          connectionStatus={connectionStatus}
          onDisconnect={handleDisconnect}
          alwaysFocused
        />
      </div>
    )
  }

  if (standalone) {
    return (
      <div className="standalone-page">
        <div className="terminal-wrapper">
          <ThemedTerminal
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

  // Not-connected: render info + form as Fragment children directly (no
  // surrounding .connect-panel wrapper). The parent .terminal-block flex
  // column sizes to the widest child (the terminal-wrapper), and the info
  // block is capped in width via CSS so it doesn't stretch the block out.
  return (
    <>
      <div className="connect-info">
        <h3 className="connect-heading">
          Connect to your system
          <button
            type="button"
            className="info-tooltip-btn"
            aria-label="More info about connection"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <span className="info-tooltip">
              Enter your host details to connect directly from this page.
              The connection is proxied through the local proxy server or a Cloudflare Worker.
              <br /><br />
              Credentials are sent directly to the target host. Your password is never stored;
              other connection details (host, port, protocol, username) are saved in this
              browser&rsquo;s local storage for convenience.
            </span>
          </button>
        </h3>
      </div>

      <div className="connect-form">
        {error && <div className="connect-error">{error}</div>}

        <div className="terminal-wrapper" style={{ minHeight: 'auto' }}>
          <ThemeSticker />
          <ThemedTerminal
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
    </>
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
    <DemoThemeProvider>
      <div className="demo-page">
        {/* Terminal block: the header (title + subtitle), npx + GitHub,
         * terminal, and theme toggle all live inside a single flex column
         * that hugs the terminal's fit-to-content width. This aligns the
         * page title to the terminal's LEFT edge (instead of centering it
         * against the 920px page column). */}
        <div className="terminal-block">
          <header className="demo-header">
            <div className="demo-header-row">
              <div className="demo-header-text">
                <h1 className="demo-title">
                  @green-screen-react
                  <span className="demo-title-badge">DEMO / PREVIEW</span>
                </h1>
                <p className="demo-subtitle">Multi-protocol legacy terminal emulator for React</p>
              </div>
              <div className="demo-footer">
                <GitHubButton />
                <CopyInstallCmd />
              </div>
            </div>
          </header>
          <ConnectPanel />
          <div className="terminal-block-theme-row">
            <ThemePicker />
          </div>
        </div>

        <PoweredByLegacyBridge />
      </div>
    </DemoThemeProvider>
  )
}

/** Attribution block pinned near the bottom of the page. Links to the
 * LegacyBridge landing page and adds a one-line tagline. The wordmark is
 * rendered as styled text with an inline logo glyph — no external asset
 * dependency. */
function PoweredByLegacyBridge() {
  return (
    <div className="powered-by">
      <div className="powered-by-line">
        <span className="powered-by-label">Powered by</span>
        <a
          href="https://legacybridge.software"
          target="_blank"
          rel="noopener noreferrer"
          className="legacybridge-logo"
          aria-label="LegacyBridge"
        >
          <svg width="22" height="22" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {/* Processor-chip pins (3 per edge) */}
            <line x1="10" y1="1.5" x2="10" y2="5.5" />
            <line x1="16" y1="1.5" x2="16" y2="5.5" />
            <line x1="22" y1="1.5" x2="22" y2="5.5" />
            <line x1="10" y1="26.5" x2="10" y2="30.5" />
            <line x1="16" y1="26.5" x2="16" y2="30.5" />
            <line x1="22" y1="26.5" x2="22" y2="30.5" />
            <line x1="1.5" y1="10" x2="5.5" y2="10" />
            <line x1="1.5" y1="16" x2="5.5" y2="16" />
            <line x1="1.5" y1="22" x2="5.5" y2="22" />
            <line x1="26.5" y1="10" x2="30.5" y2="10" />
            <line x1="26.5" y1="16" x2="30.5" y2="16" />
            <line x1="26.5" y1="22" x2="30.5" y2="22" />
            {/* Chip body */}
            <rect x="5.5" y="5.5" width="21" height="21" rx="3.5" />
            {/* Interior staircase / circuit path */}
            <path d="M11 21.5 H14.5 V17.5 H18 V13.5 H21.5" />
          </svg>
          <span className="legacybridge-wordmark">
            <span className="lb-legacy">Legacy</span><span className="lb-bridge">Bridge</span>
          </span>
        </a>
      </div>
      <div className="powered-by-tagline">
        We teach AI to use 5250 terminals safely
      </div>
    </div>
  )
}

/** Wrapper that reads the demo theme from context and forwards it to
 * <GreenScreenTerminal>. Lets us swap themes at runtime without having to
 * thread the prop through every callsite. */
function ThemedTerminal(props: React.ComponentProps<typeof GreenScreenTerminal>) {
  const { theme } = useContext(ThemeContext)
  return <GreenScreenTerminal {...props} theme={theme} />
}

/** Theme-dependent sticker positioned BELOW the terminal.
 *   Classic: paper sticky-note (right side, taped on, slight rotation).
 *   Modern:  brushed-metal panel (left side, flat, four corner screws).
 * Wraps inside `.terminal-wrapper` (position: relative). */
function ThemeSticker() {
  const { theme } = useContext(ThemeContext)
  const [line1, line2] = theme === 'classic'
    ? ['Phosphor included', "The classic 1978's recipe"]
    : ['Phosphor-free', 'Still eco-friendly']
  return (
    <div className={`theme-sticker theme-sticker-${theme}`} aria-hidden="true">
      {theme === 'modern' && (
        <>
          {/* Only top screws — visually lighter, more like a nameplate
           * hung by its top edge rather than fully fastened. */}
          <span className="sticker-screw sticker-screw-tl" />
          <span className="sticker-screw sticker-screw-tr" />
        </>
      )}
      <span className="theme-sticker-line1">{line1}</span>
      <span className="theme-sticker-line2">{line2}</span>
    </div>
  )
}

/** Demo-only: provides a DemoTheme and a setter. */
function DemoThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<DemoTheme>(() => {
    try { return (localStorage.getItem('gs-demo-theme') as DemoTheme) || 'modern' } catch { return 'modern' }
  })
  useEffect(() => {
    try { localStorage.setItem('gs-demo-theme', theme) } catch {}
    // Reflect theme on <body> so the page background and the <html>
    // scroll-area can restyle to match the terminal palette.
    document.body.classList.toggle('gs-demo-theme-modern', theme === 'modern')
    document.body.classList.toggle('gs-demo-theme-classic', theme === 'classic')
  }, [theme])
  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

function ThemePicker() {
  const { theme, setTheme } = useContext(ThemeContext)
  return (
    <div className="theme-picker" role="radiogroup" aria-label="Theme">
      <button
        type="button"
        role="radio"
        aria-checked={theme === 'classic'}
        className={`theme-toggle-option${theme === 'classic' ? ' active' : ''}`}
        onClick={() => setTheme('classic')}
      >
        Classic (Phosphor)
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={theme === 'modern'}
        className={`theme-toggle-option${theme === 'modern' ? ' active' : ''}`}
        onClick={() => setTheme('modern')}
      >
        Modern (Aurora)
      </button>
    </div>
  )
}

/** Copy button that transforms to a green checkmark for 2 seconds after click. */
function CopyInstallCmd() {
  const CMD = 'npx green-screen-terminal'
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    // Try the modern async API first; fall back to execCommand for
    // environments where clipboard access is blocked (iframes, insecure
    // contexts). Visual feedback fires either way so the user sees the
    // intent even if the copy itself silently failed.
    let ok = false
    try {
      await navigator.clipboard.writeText(CMD)
      ok = true
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = CMD
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
        document.body.appendChild(ta)
        ta.focus(); ta.select()
        ok = document.execCommand('copy')
        document.body.removeChild(ta)
      } catch { /* give up */ }
    }
    if (ok || !ok /* show feedback regardless */) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }
  return (
    <div className="install-cmd-wrap">
      <code className="install-cmd">{CMD}</code>
      <button
        type="button"
        className={`copy-btn${copied ? ' copied' : ''}`}
        onClick={handleCopy}
        aria-label={copied ? 'Copied!' : 'Copy install command'}
        title={copied ? 'Copied!' : 'Copy'}
      >
        {copied ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
    </div>
  )
}

function GitHubButton() {
  return (
    <a
      href="https://github.com/visionbridge-solutions/green-screen-react"
      className="github-btn"
      target="_blank"
      rel="noopener noreferrer"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.2 11.39.6.1.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.83 1.23 1.83 1.23 1.07 1.83 2.8 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.34-5.47-5.95 0-1.32.47-2.4 1.24-3.24-.13-.3-.54-1.53.11-3.19 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.3-1.55 3.3-1.23 3.3-1.23.65 1.66.24 2.89.12 3.19.77.84 1.23 1.92 1.23 3.24 0 4.62-2.81 5.64-5.49 5.94.43.37.81 1.1.81 2.22 0 1.6-.02 2.9-.02 3.29 0 .32.22.69.83.57C20.57 21.8 24 17.3 24 12 24 5.37 18.63 0 12 0z"/>
      </svg>
      <span>GitHub</span>
    </a>
  )
}
