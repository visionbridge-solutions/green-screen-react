/**
 * Cloudflare Worker for green-screen-react.
 * Uses Durable Objects to hold persistent TCP connections to legacy hosts.
 * Communicates with the browser via WebSocket.
 *
 * Rate limits:
 *   - Max 3 concurrent sessions per IP
 *   - Max 5 new connections per IP per minute
 *   - 10-minute idle timeout per session
 *   - CORS locked to allowed origins
 *
 * WebSocket protocol (JSON messages):
 *   Client → Server:
 *     { type: "connect", host, port, protocol, username?, password? }
 *     { type: "text", text }
 *     { type: "key", key }
 *     { type: "disconnect" }
 *
 *   Server → Client:
 *     { type: "screen", data: ScreenData }
 *     { type: "status", data: ConnectionStatus }
 *     { type: "error", message: string }
 *     { type: "connected", sessionId: string }
 */

import { createProtocolHandler, ProtocolHandler, ProtocolType } from 'green-screen-proxy/dist/protocols/index.js'

interface Env {
  TERMINAL_SESSION: DurableObjectNamespace
}

// ── Configuration ───────────────────────────────────────────

// __CORS_ORIGINS_PLACEHOLDER__ is replaced by `npx green-screen-proxy deploy --origins`
// Default value below is used for the pre-built demo worker
const CONFIGURED_ORIGINS = '__CORS_ORIGINS_PLACEHOLDER__'
const ALLOWED_ORIGINS = CONFIGURED_ORIGINS.startsWith('__')
  ? ['https://visionbridge-solutions.github.io', 'http://localhost:5173', 'http://localhost:4173']
  : [...CONFIGURED_ORIGINS.split(',').filter(Boolean), 'http://localhost:5173', 'http://localhost:4173']

// Restrictions only apply to the shared demo worker (placeholder = demo mode)
const IS_DEMO = CONFIGURED_ORIGINS.startsWith('__')
const MAX_SESSIONS_PER_IP = IS_DEMO ? 3 : Infinity
const MAX_CONNECTS_PER_MINUTE = IS_DEMO ? 5 : Infinity
const SESSION_IDLE_TIMEOUT_MS = IS_DEMO ? 10 * 60 * 1000 : 0 // 10 min for demo, disabled for user-deployed

// ── Rate limiter (in-memory, per Worker isolate) ────────────

interface RateBucket {
  sessions: number
  connectTimestamps: number[]
}

const rateLimits = new Map<string, RateBucket>()

function getRateBucket(ip: string): RateBucket {
  let bucket = rateLimits.get(ip)
  if (!bucket) {
    bucket = { sessions: 0, connectTimestamps: [] }
    rateLimits.set(ip, bucket)
  }
  return bucket
}

function checkRateLimit(ip: string): string | null {
  const bucket = getRateBucket(ip)

  // Check concurrent sessions
  if (bucket.sessions >= MAX_SESSIONS_PER_IP) {
    return `Too many concurrent sessions (max ${MAX_SESSIONS_PER_IP})`
  }

  // Check connection rate (sliding window)
  const now = Date.now()
  bucket.connectTimestamps = bucket.connectTimestamps.filter(t => now - t < 60_000)
  if (bucket.connectTimestamps.length >= MAX_CONNECTS_PER_MINUTE) {
    return `Too many connections (max ${MAX_CONNECTS_PER_MINUTE}/min)`
  }

  return null
}

function trackConnect(ip: string): void {
  const bucket = getRateBucket(ip)
  bucket.sessions++
  bucket.connectTimestamps.push(Date.now())
}

function trackDisconnect(ip: string): void {
  const bucket = getRateBucket(ip)
  bucket.sessions = Math.max(0, bucket.sessions - 1)
  const now = Date.now()
  bucket.connectTimestamps = bucket.connectTimestamps.filter(t => now - t < 60_000)
  if (bucket.sessions === 0 && bucket.connectTimestamps.length === 0) {
    rateLimits.delete(ip)
  }
}

// ── CORS helpers ────────────────────────────────────────────

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') || ''
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Upgrade, X-Session-Id',
    'Vary': 'Origin',
  }
}

function corsResponse(request: Request): Response {
  return new Response(null, { status: 204, headers: getCorsHeaders(request) })
}

// ── Worker entry ────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return corsResponse(request)

    const url = new URL(request.url)
    const corsHeaders = getCorsHeaders(request)

    // CORS origin check for non-GET requests
    const origin = request.headers.get('Origin')
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    // WebSocket upgrade → route to a Durable Object
    if (url.pathname === '/ws') {
      const upgrade = request.headers.get('Upgrade')
      if (upgrade !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 })
      }

      const ip = request.headers.get('CF-Connecting-IP') || 'unknown'

      // Rate limit check
      const rateLimitError = checkRateLimit(ip)
      if (rateLimitError) {
        return new Response(JSON.stringify({ error: rateLimitError }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      trackConnect(ip)

      // Create a unique DO per connection, pass IP for cleanup tracking
      const id = env.TERMINAL_SESSION.newUniqueId()
      const stub = env.TERMINAL_SESSION.get(id)

      // Forward the request with IP header for the DO to track
      const doRequest = new Request(request.url, {
        headers: {
          ...Object.fromEntries(request.headers),
          'X-Client-IP': ip,
          'Upgrade': 'websocket',
        },
      })

      return stub.fetch(doRequest)
    }

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'green-screen-worker' }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    return new Response('Not found', { status: 404, headers: corsHeaders })
  },
}

// ── Durable Object: TerminalSession ─────────────────────────

export class TerminalSession {
  private state: DurableObjectState
  private ws: WebSocket | null = null
  private handler: ProtocolHandler | null = null
  private connected: boolean = false
  private clientIp: string = 'unknown'
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    this.clientIp = request.headers.get('X-Client-IP') || 'unknown'

    // Accept WebSocket
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]

    this.state.acceptWebSocket(server)
    this.ws = server
    this.resetIdleTimer()

    return new Response(null, {
      status: 101,
      webSocket: client,
    })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    this.resetIdleTimer()

    try {
      const msg = JSON.parse(message)

      switch (msg.type) {
        case 'connect':
          await this.handleConnect(msg)
          break
        case 'text':
          this.handleSendText(msg.text)
          break
        case 'key':
          this.handleSendKey(msg.key)
          break
        case 'disconnect':
          this.handleDisconnect()
          break
      }
    } catch (err) {
      this.send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.cleanup()
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    this.cleanup()
  }

  private async handleConnect(msg: { host: string; port?: number; protocol?: string }): Promise<void> {
    // Clean up existing connection
    if (this.handler) {
      this.handler.destroy()
      this.handler = null
    }

    const protocol = (msg.protocol || 'tn5250') as ProtocolType
    const port = msg.port || this.defaultPort(protocol)
    const host = msg.host

    // Basic host validation — block private/internal ranges
    if (IS_DEMO && this.isPrivateHost(host)) {
      this.send({ type: 'error', message: 'Cannot connect to private/internal addresses' })
      return
    }

    this.send({ type: 'status', data: { connected: false, status: 'connecting', protocol, host } })

    try {
      this.handler = createProtocolHandler(protocol)

      // Listen for screen changes
      this.handler.on('screenChange', (screenData: any) => {
        this.resetIdleTimer()
        this.send({ type: 'screen', data: screenData })
      })

      this.handler.on('disconnected', () => {
        this.connected = false
        this.send({ type: 'status', data: { connected: false, status: 'disconnected', protocol, host } })
      })

      this.handler.on('error', (err: Error) => {
        this.send({ type: 'error', message: err.message })
        this.send({ type: 'status', data: { connected: false, status: 'error', protocol, host, error: err.message } })
      })

      await this.handler.connect(host, port)
      this.connected = true

      this.send({ type: 'status', data: { connected: true, status: 'connected', protocol, host } })

      // Wait for initial screen data via event (with timeout fallback)
      const initialScreen = await this.waitForScreen(5000)
      this.send({ type: 'screen', data: initialScreen })
      this.send({ type: 'connected', sessionId: this.state.id.toString() })

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.send({ type: 'error', message })
      this.send({ type: 'status', data: { connected: false, status: 'error', protocol, host, error: message } })
    }
  }

  private handleSendText(text: string): void {
    if (!this.handler || !this.connected) {
      this.send({ type: 'error', message: 'Not connected' })
      return
    }

    this.handler.sendText(text)
    const screenData = this.handler.getScreenData()
    this.send({ type: 'screen', data: screenData })
  }

  private async handleSendKey(key: string): Promise<void> {
    if (!this.handler || !this.connected) {
      this.send({ type: 'error', message: 'Not connected' })
      return
    }

    const ok = this.handler.sendKey(key)
    if (!ok) {
      this.send({ type: 'error', message: `Unknown key: ${key}` })
      return
    }

    const screenData = await this.waitForScreen(3000)
    this.send({ type: 'screen', data: screenData })
  }

  private waitForScreen(timeoutMs: number): Promise<any> {
    return new Promise((resolve) => {
      if (!this.handler) { resolve(null); return }
      const timer = setTimeout(() => resolve(this.handler!.getScreenData()), timeoutMs)
      this.handler.once('screenChange', (data: any) => {
        clearTimeout(timer)
        resolve(data)
      })
    })
  }

  private handleDisconnect(): void {
    if (this.handler) {
      this.handler.destroy()
      this.handler = null
    }
    this.connected = false
  }

  private cleanup(): void {
    this.handleDisconnect()
    this.clearIdleTimer()
    trackDisconnect(this.clientIp)
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer()
    if (!SESSION_IDLE_TIMEOUT_MS) return // disabled for user-deployed workers
    this.idleTimer = setTimeout(() => {
      this.send({ type: 'error', message: 'Session timed out due to inactivity' })
      this.send({ type: 'status', data: { connected: false, status: 'disconnected' } })
      this.handleDisconnect()
      try { this.ws?.close(1000, 'Idle timeout') } catch {}
    }, SESSION_IDLE_TIMEOUT_MS)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private send(data: object): void {
    try {
      this.ws?.send(JSON.stringify(data))
    } catch {
      // WebSocket may be closed
    }
  }

  private defaultPort(protocol: string): number {
    switch (protocol) {
      case 'tn5250': return 23
      case 'tn3270': return 23
      case 'vt': return 23
      case 'hp6530': return 26
      default: return 23
    }
  }

  private isPrivateHost(host: string): boolean {
    // Block localhost
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true

    // Block private IPv4 ranges
    const parts = host.split('.').map(Number)
    if (parts.length === 4 && parts.every(n => !isNaN(n))) {
      if (parts[0] === 10) return true
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
      if (parts[0] === 192 && parts[1] === 168) return true
      if (parts[0] === 169 && parts[1] === 254) return true // link-local
      if (parts[0] === 0) return true
    }

    // Block common internal hostnames
    const lower = host.toLowerCase()
    if (lower.endsWith('.local') || lower.endsWith('.internal')) return true

    return false
  }
}
