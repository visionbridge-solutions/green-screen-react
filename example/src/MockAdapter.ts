import type {
  TerminalAdapter,
  ScreenData,
  ConnectionStatus,
  SendResult,
  ConnectConfig,
} from 'green-screen-react'

/**
 * Client-side mock adapter for interactive demo terminals.
 * Handles typing, cursor movement, and key presses entirely in the browser.
 */
export class MockAdapter implements TerminalAdapter {
  private lines: string[]
  private cursorRow: number
  private cursorCol: number
  private rows: number
  private cols: number
  private fields: ScreenData['fields']

  constructor(screen: ScreenData) {
    this.rows = screen.rows ?? 24
    this.cols = screen.cols ?? 80
    this.cursorRow = screen.cursor_row
    this.cursorCol = screen.cursor_col
    this.fields = screen.fields ?? []
    this.lines = screen.content.split('\n')
    // Ensure we have enough lines
    while (this.lines.length < this.rows) this.lines.push(' '.repeat(this.cols))
  }

  private buildScreen(): ScreenData {
    return {
      content: this.lines.map(l => l.padEnd(this.cols).slice(0, this.cols)).join('\n'),
      cursor_row: this.cursorRow,
      cursor_col: this.cursorCol,
      rows: this.rows,
      cols: this.cols,
      fields: this.fields,
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
    }
    return this.result()
  }

  async sendKey(key: string): Promise<SendResult> {
    switch (key) {
      case 'ENTER': {
        // Clear input field and reset cursor to field start
        const field = this.getCurrentField()
        if (field) {
          const line = this.lines[this.cursorRow] ?? ' '.repeat(this.cols)
          this.lines[this.cursorRow] =
            line.substring(0, field.col) +
            ' '.repeat(field.length) +
            line.substring(field.col + field.length)
          this.cursorCol = field.col
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
