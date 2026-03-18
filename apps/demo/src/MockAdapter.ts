import type {
  TerminalAdapter,
  ScreenData,
  ConnectionStatus,
  SendResult,
  ConnectConfig,
} from 'green-screen-react'
import type { MockScreenNode } from './mockScreens'

/**
 * Client-side mock adapter for interactive demo terminals.
 * Supports either a single static screen or a screen tree with navigation.
 */
export class MockAdapter implements TerminalAdapter {
  private lines!: string[]
  private cursorRow!: number
  private cursorCol!: number
  private rows!: number
  private cols!: number
  private fields!: ScreenData['fields']

  // Screen tree navigation
  private screenTree: Record<string, MockScreenNode> | null
  private currentScreenId: string
  private inputBuffer: string = ''

  constructor(screen: ScreenData)
  constructor(screenTree: Record<string, MockScreenNode>, startScreenId?: string)
  constructor(arg: ScreenData | Record<string, MockScreenNode>, startScreenId?: string) {
    // Detect screen tree vs single screen
    if (arg && typeof arg === 'object' && 'content' in arg) {
      // Single screen mode
      this.screenTree = null
      this.currentScreenId = ''
      this.loadScreen(arg as ScreenData)
    } else {
      // Screen tree mode
      this.screenTree = arg as Record<string, MockScreenNode>
      this.currentScreenId = startScreenId || 'main'
      const node = this.screenTree[this.currentScreenId]
      this.loadScreen(node.screen)
    }
  }

  private loadScreen(screen: ScreenData): void {
    this.rows = screen.rows ?? 24
    this.cols = screen.cols ?? 80
    this.cursorRow = screen.cursor_row
    this.cursorCol = screen.cursor_col
    this.fields = screen.fields ?? []
    this.lines = screen.content.split('\n')
    while (this.lines.length < this.rows) this.lines.push(' '.repeat(this.cols))
    this.inputBuffer = ''
  }

  private navigateTo(screenId: string): void {
    if (!this.screenTree) return
    const node = this.screenTree[screenId]
    if (!node) return
    this.currentScreenId = screenId
    this.loadScreen(node.screen)
  }

  private getCurrentNode(): MockScreenNode | null {
    if (!this.screenTree) return null
    return this.screenTree[this.currentScreenId] ?? null
  }

  private buildScreen(): ScreenData {
    return {
      content: this.lines.map(l => l.padEnd(this.cols).slice(0, this.cols)).join('\n'),
      cursor_row: this.cursorRow,
      cursor_col: this.cursorCol,
      rows: this.rows,
      cols: this.cols,
      fields: this.fields,
      screen_signature: '',
      timestamp: new Date().toISOString(),
    }
  }

  private result(): SendResult {
    return { success: true, cursor_row: this.cursorRow, cursor_col: this.cursorCol }
  }

  private getCurrentField() {
    return this.fields?.find(
      f => f.is_input && f.row === this.cursorRow &&
        this.cursorCol >= f.col && this.cursorCol < f.col + f.length,
    ) ?? null
  }

  /** Read typed text from the command input field */
  private readInputField(): string {
    // Find the command input field (the one with ===> on that row)
    const field = this.fields?.find(f => f.is_input && !f.is_protected)
    if (!field) return this.inputBuffer.trim()

    const line = this.lines[field.row] ?? ''
    return line.substring(field.col, field.col + field.length).trim()
  }

  async getScreen(): Promise<ScreenData | null> {
    return this.buildScreen()
  }

  async getStatus(): Promise<ConnectionStatus> {
    return { connected: true, status: 'authenticated' }
  }

  async sendText(text: string): Promise<SendResult> {
    const field = this.getCurrentField()
    for (const ch of text) {
      if (field && this.cursorCol >= field.col + field.length) break
      const line = this.lines[this.cursorRow] ?? ' '.repeat(this.cols)
      this.lines[this.cursorRow] =
        line.substring(0, this.cursorCol) + ch + line.substring(this.cursorCol + 1)
      this.cursorCol++
      this.inputBuffer += ch
    }
    return this.result()
  }

  async sendKey(key: string): Promise<SendResult> {
    const node = this.getCurrentNode()

    switch (key) {
      case 'ENTER': {
        if (node) {
          // Check input navigation first
          const input = this.readInputField()
          if (input && node.inputNav && node.inputNav[input]) {
            this.navigateTo(node.inputNav[input])
            return this.result()
          }
          // Check key navigation for ENTER
          if (node.keyNav?.['ENTER']) {
            const target = node.keyNav['ENTER']
            if (target === '_back' && node.parent) {
              this.navigateTo(node.parent)
            } else if (target === '_self') {
              this.navigateTo(this.currentScreenId)
            } else if (target !== '_back') {
              this.navigateTo(target)
            }
            return this.result()
          }
        }
        // Default: clear input field
        const field = this.getCurrentField()
        if (field) {
          const line = this.lines[this.cursorRow] ?? ' '.repeat(this.cols)
          this.lines[this.cursorRow] =
            line.substring(0, field.col) +
            ' '.repeat(field.length) +
            line.substring(field.col + field.length)
          this.cursorCol = field.col
          this.inputBuffer = ''
        }
        break
      }
      case 'BACKSPACE': {
        const field = this.getCurrentField()
        if (field && this.cursorCol > field.col) {
          this.cursorCol--
          const line = this.lines[this.cursorRow] ?? ' '.repeat(this.cols)
          this.lines[this.cursorRow] =
            line.substring(0, this.cursorCol) + ' ' + line.substring(this.cursorCol + 1)
          this.inputBuffer = this.inputBuffer.slice(0, -1)
        }
        break
      }
      case 'TAB': {
        // Jump to next input field
        const inputFields = (this.fields ?? []).filter(f => f.is_input)
        const currentIdx = inputFields.findIndex(
          f => f.row === this.cursorRow && this.cursorCol >= f.col && this.cursorCol < f.col + f.length,
        )
        const next = inputFields[(currentIdx + 1) % inputFields.length]
        if (next) {
          this.cursorRow = next.row
          this.cursorCol = next.col
          this.inputBuffer = ''
        }
        break
      }
      case 'LEFT':
        if (this.cursorCol > 0) this.cursorCol--
        break
      case 'RIGHT':
        if (this.cursorCol < this.cols - 1) this.cursorCol++
        break
      case 'UP':
        if (this.cursorRow > 0) this.cursorRow--
        break
      case 'DOWN':
        if (this.cursorRow < this.rows - 1) this.cursorRow++
        break
      case 'HOME':
        this.cursorCol = 0
        break
      case 'END':
        this.cursorCol = this.cols - 1
        break
      default: {
        // Handle F-keys via screen tree navigation
        if (node?.keyNav?.[key]) {
          const target = node.keyNav[key]
          if (target === '_back' && node.parent) {
            this.navigateTo(node.parent)
          } else if (target === '_self') {
            this.navigateTo(this.currentScreenId)
          } else if (target !== '_back') {
            this.navigateTo(target)
          }
          return this.result()
        }
        break
      }
    }
    return this.result()
  }

  async connect(_config?: ConnectConfig): Promise<SendResult> {
    return { success: true }
  }

  async disconnect(): Promise<SendResult> {
    return { success: true }
  }

  async reconnect(): Promise<SendResult> {
    return { success: true }
  }
}
