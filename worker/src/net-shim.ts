/**
 * net.Socket shim for Cloudflare Workers.
 * Replaces Node.js net.Socket with Cloudflare's connect() API.
 * Only implements the subset used by green-screen-proxy connection classes.
 */
import { connect } from 'cloudflare:sockets'
import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'

export class Socket extends EventEmitter {
  private socket: any = null
  private writer: WritableStreamDefaultWriter | null = null
  private timeoutMs: number = 0
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null
  private destroyed: boolean = false

  setTimeout(ms: number): this {
    this.timeoutMs = ms
    this.resetTimeout()
    return this
  }

  connect(port: number, host: string, callback?: () => void): this {
    if (callback) this.once('connect', callback)

    try {
      this.socket = connect({ hostname: host, port })
      this.writer = this.socket.writable.getWriter()

      // Signal connected
      queueMicrotask(() => this.emit('connect'))

      // Read loop: TCP → events
      this.readLoop()

      // Handle socket closure
      this.socket.closed.then(() => {
        if (!this.destroyed) {
          this.cleanup()
          this.emit('close')
        }
      }).catch((err: Error) => {
        if (!this.destroyed) {
          this.emit('error', err)
          this.cleanup()
        }
      })
    } catch (err) {
      queueMicrotask(() => this.emit('error', err))
    }

    return this
  }

  write(data: Buffer | Uint8Array): boolean {
    if (this.destroyed || !this.writer) return false
    this.resetTimeout()

    const bytes = data instanceof Uint8Array ? data : Buffer.from(data)
    this.writer.write(bytes).catch((err: Error) => {
      if (!this.destroyed) this.emit('error', err)
    })
    return true
  }

  destroy(): void {
    if (this.destroyed) return
    this.cleanup()
  }

  private async readLoop(): Promise<void> {
    if (!this.socket) return

    const reader = this.socket.readable.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done || this.destroyed) break
        this.resetTimeout()
        this.emit('data', Buffer.from(value))
      }
    } catch (err) {
      if (!this.destroyed) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)))
      }
    } finally {
      reader.releaseLock()
      if (!this.destroyed) {
        this.cleanup()
        this.emit('close')
      }
    }
  }

  private resetTimeout(): void {
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle)
    if (this.timeoutMs > 0 && !this.destroyed) {
      this.timeoutHandle = setTimeout(() => {
        this.emit('timeout')
      }, this.timeoutMs)
    }
  }

  private cleanup(): void {
    this.destroyed = true
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle)
      this.timeoutHandle = null
    }
    if (this.writer) {
      try { this.writer.close() } catch {}
      this.writer = null
    }
    if (this.socket) {
      try { this.socket.close() } catch {}
      this.socket = null
    }
  }
}

export default { Socket }
