import { useState } from 'react'
import { GreenScreenTerminal } from 'green-screen-react'
import type { TerminalProtocol } from 'green-screen-react'
import { mockScreens } from './mockScreens'

const protocols: { key: TerminalProtocol; label: string }[] = [
  { key: 'tn5250', label: 'TN5250' },
  { key: 'tn3270', label: 'TN3270' },
  { key: 'vt', label: 'VT220' },
  { key: 'hp6530', label: 'HP 6530' },
]

export default function App() {
  const [selected, setSelected] = useState<TerminalProtocol>('tn5250')

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
      </nav>

      <div className="terminal-wrapper">
        <GreenScreenTerminal
          protocol={selected}
          screenData={mockScreens[selected]}
          connectionStatus={{ connected: true, status: 'authenticated' }}
          inlineSignIn={false}
          readOnly={true}
          pollInterval={0}
          typingAnimation={false}
        />
      </div>

      <footer className="demo-footer">
        <code className="install-cmd">npm install green-screen-react</code>
        <a
          href="https://github.com/visionbridge-solutions/green-screen-react"
          className="github-link"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub →
        </a>
      </footer>
    </div>
  )
}
