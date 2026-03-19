# Debug Notes — TN5250 Terminal Emulator

## Architecture Overview

```
Browser (React)           Proxy Server (Node.js)          IBM i Host
=================         ========================        ===========

GreenScreenTerminal       SessionController               pub400.com:23
  │                          │                                │
  │  WebSocket (/ws)         │   TCP Socket (port 23)         │
  │  JSON messages           │   Telnet + 5250 binary         │
  │                          │                                │
  ├──{type:"connect"}──────>│──TCP connect──────────────────>│
  │                          │<─Telnet DO/WILL negotiation──>│
  │                          │  (TTYPE, EOR, BINARY, ENV)     │
  │                          │                                │
  │                      TN5250Handler                        │
  │                          │                                │
  │                      TN5250Connection                     │
  │                        onData() → processBuffer()         │
  │                        findRecordEnd() (IAC EOR)          │
  │                        unescapeIAC()                      │
  │                          │                                │
  │                      TN5250Parser                         │
  │                        parseRecord() → parseCommands()    │
  │                        parseOrders() (SBA,SF,RA,EA,IC..)  │
  │                          │                                │
  │                      ScreenBuffer                         │
  │                        buffer[] + attrBuffer[] + fields[] │
  │                        cursorRow, cursorCol               │
  │                          │                                │
  │<──{type:"screen",───────│                                │
  │    data: ScreenData}     │                                │
  │                          │                                │
  │──{type:"key",──────────>│                                │
  │   key:"Enter"}           │                                │
  │                      TN5250Encoder                        │
  │                        buildAidResponse()                 │
  │                        (cursor + modified fields)         │
  │                          │──5250 GDS response (IAC EOR)─>│
```

## File Responsibility Map

| File | Class/Module | Layer | Responsibility | Key State |
|------|-------------|-------|---------------|-----------|
| `packages/proxy/src/tn5250/constants.ts` | Exports | Constants | Protocol byte constants (TELNET, OPCODE, CMD, ORDER, AID, FFW, ATTR, SCREEN) | None |
| `packages/proxy/src/tn5250/ebcdic.ts` | Functions | Encoding | CCSID 37 EBCDIC ↔ Unicode conversion; symbol character set (CGCS) | `EBCDIC_TO_UNICODE[]`, `UNICODE_TO_EBCDIC` Map, `SYMBOL_MAP` |
| `packages/proxy/src/tn5250/connection.ts` | `TN5250Connection` | Network | TCP socket, Telnet negotiation (DO/WILL/SB), IAC EOR record framing | `socket`, `recvBuffer`, `negotiationDone`, `terminalType` |
| `packages/proxy/src/tn5250/parser.ts` | `TN5250Parser` | Parser | Parses GDS records → commands → orders; updates ScreenBuffer | `pendingFieldsClear` flag |
| `packages/proxy/src/tn5250/screen.ts` | `ScreenBuffer` | Model | Character grid + attribute grid + field list + cursor position | `buffer[]`, `attrBuffer[]`, `fields[]`, `cursorRow`, `cursorCol` |
| `packages/proxy/src/tn5250/encoder.ts` | `TN5250Encoder` | Encoder | Builds AID response records (cursor + modified field data in EBCDIC) | References `screen` |
| `packages/proxy/src/protocols/tn5250-handler.ts` | `TN5250Handler` | Handler | Orchestrates connection/parser/encoder; Tab/Backtab; auto-sign-in | `savedFields[]` |
| `packages/proxy/src/controller.ts` | `SessionController` | Controller | WebSocket message protocol bridge (connect/text/key/disconnect) | `handler`, `connected` |
| `packages/react/src/components/GreenScreenTerminal.tsx` | `GreenScreenTerminal` | UI | React terminal renderer; keyboard input; typing animation | `screenData`, `inputText`, `syncedCursor`, `isFocused` |

## Coordinate Systems

**All coordinates are 0-based throughout the entire stack.**

| Layer | Coordinate Style | Notes |
|-------|-----------------|-------|
| 5250 data stream (from host) | 0-based row, col | SBA/IC/MC/RA/EA bytes are direct row/col values |
| `ScreenBuffer.offset(row, col)` | Linear: `row * cols + col` | 0-based |
| `ScreenBuffer.toRowCol(offset)` | `{ row: floor(offset/cols), col: offset%cols }` | 0-based |
| `ScreenBuffer.cursorRow/cursorCol` | 0-based | |
| `FieldDef.row/col` | 0-based; points to first DATA cell (after attribute byte) | |
| `ScreenData` wire format | `cursor_row`, `cursor_col` (0-based) | |
| `ScreenData.content` | Newline-separated rows, row 0 = first line | |

**CRITICAL DISCREPANCY vs lib5250:** The lib5250 reference implementation uses **1-based** addressing for SBA/IC/MC/RA/EA order bytes from the host. It explicitly subtracts 1: `Y-1`, `X-1`. Our parser treats them as 0-based and uses them directly. **This is a potential bug** — if the host sends 1-based addresses (as lib5250 expects), our parser will be off-by-one on every positioned operation.

### Conversion Points
- `parser.ts:252` — SBA: `currentAddr = this.screen.offset(row, col)` (direct, no -1)
- `parser.ts:260-261` — IC: `toRowCol(currentAddr)` → cursor
- `parser.ts:270-271` — MC: direct row,col → cursor (no -1)
- `parser.ts:283-285` — RA: target from `offset(toRow, toCol)` (no -1)
- `parser.ts:298-299` — EA: target from `offset(toRow, toCol)` (no -1)
- `encoder.ts:34` — AID response: sends `cursorRow, cursorCol` directly
- `encoder.ts:47` — Field SBA in response: sends `field.row, field.col` directly

## Shared Mutable State

State that is read or written by more than one module:

| State | Owner | Mutated By | Read By |
|-------|-------|-----------|---------|
| `ScreenBuffer.buffer[]` | screen.ts | Parser (orders, chars), Encoder (insertText), Handler (autoSignIn field restore, setFieldValue) | Encoder (getFieldValue), Screen (toScreenData) |
| `ScreenBuffer.attrBuffer[]` | screen.ts | Parser (WEA, SA) | Screen (toScreenData — not currently used in output) |
| `ScreenBuffer.fields[]` | screen.ts | Parser (push, clearStaleFieldsOnce, clear, calculateFieldLengths sort/dedup) | Encoder (buildAidResponse), Handler (Tab/Backtab, autoSignIn), Screen (toScreenData) |
| `ScreenBuffer.cursorRow/cursorCol` | screen.ts | Parser (IC, MC, calculateFieldLengths reposition), Handler (Tab/Backtab, autoSignIn), Encoder (insertText) | Encoder (buildAidResponse cursor pos), Screen (toScreenData) |
| `TN5250Parser.pendingFieldsClear` | parser.ts | Parser (WTD CC1 sets it, clearStaleFieldsOnce consumes it) | Parser only |
| `FieldDef.modified` | screen.ts | Encoder (insertText sets true), Parser (WTD CC1 resets), Handler (autoSignIn resets all) | Encoder (buildAidResponse filters on it) |
| `TN5250Handler.savedFields` | handler.ts | Handler (saveInputFields populates, restoreFields consumes) | Handler only |

## 5250 Protocol Coverage

### Orders (within WTD command)

| Order | Hex | Implemented | File:Line | Notes |
|-------|-----|-------------|-----------|-------|
| SBA (Set Buffer Address) | 0x11 | Yes | parser.ts:246 | 2-byte row,col → sets currentAddr |
| IC (Insert Cursor) | 0x13 | Yes | parser.ts:257 | Sets cursor to currentAddr immediately (lib5250 defers to post-WTD) |
| MC (Move Cursor) | 0x14 | Yes | parser.ts:267 | Sets cursor + currentAddr from 2-byte row,col |
| RA (Repeat to Address) | 0x02 | Partial | parser.ts:278 | No wrapping support — fails if target < current |
| EA (Erase to Address) | 0x03 | Partial | parser.ts:294 | No wrapping, no multi-row edge logic, no attribute type parameter |
| SOH (Start of Header) | 0x01 | Partial | parser.ts:308 | Skips header bytes but doesn't clear format table or lock keyboard |
| TD (Transparent Data) | 0x10 | Yes | parser.ts:319 | Length-prefixed raw EBCDIC |
| WEA (Write Extended Attr) | 0x04 | Yes | parser.ts:330 | Sets attribute at currentAddr |
| SF (Start Field) | 0x1D | Yes | parser.ts:364 | FFW + optional FCW + attribute byte |
| SA (Set Attribute) | 0x28 | Yes | parser.ts:342 | Handles types 0x00 (all), 0x20 (highlighting), 0x22 (CGCS) |
| Field Attr (0x20-0x3F) | — | Yes | parser.ts:374 | Only recognized immediately after SBA |

### Commands

| Command | Hex | Implemented | File:Line | Notes |
|---------|-----|-------------|-----------|-------|
| CLEAR_UNIT | 0x40 | Yes | parser.ts:137 | screen.clear() |
| CLEAR_UNIT_ALT | 0x20 | Yes | parser.ts:138 | screen.clear() |
| CLEAR_FORMAT_TABLE | 0x50 | Yes | parser.ts:144 | Clears fields only |
| WRITE_TO_DISPLAY | 0x11 | Yes | parser.ts:150 | CC1/CC2 + orders |
| WRITE_ERROR_CODE | 0x21 | Partial | parser.ts:183 | Parsed as orders, no error-specific handling |
| WRITE_ERROR_CODE_WIN | 0x22 | Partial | parser.ts:184 | Same |
| WRITE_STRUCTURED_FIELD | 0xF3 | Stub | parser.ts:193 | Length-skip only, no content parsed |
| ROLL | 0x23 | Stub | parser.ts:203 | Reads CC + count, marks modified, but does NOT scroll |
| SAVE_SCREEN | 0x02 | Partial | parser.ts:82 | Delegates to parseCommandsFromOffset (no actual save) |
| RESTORE_SCREEN | 0x05 | Partial | parser.ts:83 | Delegates to parseCommandsFromOffset (no actual restore) |

### CC1/CC2 Handling

| CC1 Feature | Implemented | Notes |
|-------------|-------------|-------|
| Reset MDT (bit 5, 0x20) | Yes | parser.ts:158 — resets all field.modified flags |
| Null-fill inputs (bit 6, 0x40) | Yes | parser.ts:166 — fills input fields with spaces |
| Upper 3-bit dispatch | No | Only checks individual bits, not the 3-bit combo that lib5250 uses |

| CC2 Feature | Implemented | Notes |
|-------------|-------------|-------|
| Unlock keyboard | No | Not implemented |
| Alarm/beep | No | Not implemented |
| Message indicators | No | Not implemented |
| IC suppress unlock | No | Not implemented |

## Suspicious Code Patterns

### [FIXED] SBA/IC/MC/RA/EA Address Interpretation — 0-based vs 1-based

**RESOLVED in commit 7575662.** All SBA/IC/MC/RA/EA now subtract 1 from host addresses (1-based→0-based). Encoder adds 1 when sending responses. Verified against live pub400.com — all screen positions correct.

### [FIXED] RA/EA Orders Do Not Wrap

**RESOLVED in commit 7575662.** RA/EA now handle wrap-around: when target < current, fill to end of screen then continue from 0.

### [FIXED] ROLL Command Stub

**RESOLVED in commit d7a4160.** ROLL now implements actual buffer scrolling per lib5250 `dbuffer.c:869-899`.

**File (historical):** parser.ts:203-212

Reads `rollCC` and `rollCount` but does nothing with them. Screens that use server-side scrolling (PageUp/PageDown on some screens) will not update correctly.

### [SUSPICIOUS] Last Field Length Cap Heuristic

**File:** parser.ts:565-566

```typescript
if (current.length > this.screen.cols * 2) {
  current.length = this.screen.cols - current.col;
}
```

Arbitrary cap of `cols * 2` for the last field's wrap-around length, falling back to `cols - col`. This could produce wrong lengths for fields that legitimately wrap past 2 rows. The lib5250 implementation calculates field length from the SF order's explicit length bytes, not by inferring from field positions.

### [FIXED] parseStartField 4-Byte Skip-Ahead

**RESOLVED in commit d7a4160.** Root cause was not reading the 2-byte field length after the attribute byte. The skip-ahead was compensating. Now that SF properly reads the length, the heuristic was removed.

### [SUSPICIOUS] Cursor Side-Effect in calculateFieldLengths

**File:** parser.ts:574-602

`calculateFieldLengths()` may reposition the cursor to a "functional input field" if the current cursor position isn't in one. This side effect in a calculation method could mask cursor positioning bugs from IC/MC orders, making them harder to diagnose.

### [FIXED] decodeDisplayAttr Bit Interpretation

**RESOLVED in commit d7a4160.** Rewrote to use lower 3 bits (0x07) as the type selector per 5250 spec, properly distinguishing column separator, high intensity, underscore, and non-display.

### [SUSPICIOUS] WRITE_STRUCTURED_FIELD Fully Skipped

**File:** parser.ts:193-200

WSF content (windows, help panels, GUI elements) is completely ignored. Any screen using 5250 structured fields will have missing content.

### [FIXED] IC Immediate vs Deferred

**RESOLVED in commit 7575662.** IC now reads 2 bytes (row, col) from stream and stores as pending position. Applied at end of `parseOrders()`. Last IC wins.

### [FIXED] SOH Doesn't Clear Format Table

**RESOLVED in commit 7575662.** SOH now clears `screen.fields` and resets pending IC.

### [FIXED] EA Missing Attribute Type Parameter

**RESOLVED in commit 7575662.** EA now reads length byte and consumes attribute type bytes per lib5250 spec.

## Reference Implementation Comparison (lib5250)

### SBA Address Calculation

- **lib5250** (`session.c:1860`): Reads 2 bytes as 1-based Y,X. Validates `Y ∈ [1,height]`, `X ∈ [1,width]`. Converts to 0-based with `Y-1`, `X-1`. Calls `tn5250_display_set_cursor(display, Y-1, X-1)`.
- **Our emulator** (`parser.ts:249-252`): Reads 2 bytes as 0-based row,col. Uses directly as `offset(row, col)`.
- **Match:** Uncertain — depends on whether the host sends 0-based or 1-based values. If 1-based (per spec), we are off-by-one.

### SF Field Creation

- **lib5250** (`session.c:1499`): Reads FFW (2 bytes, bit 6 set = present). Reads FCW pairs (bit 7 set). Reads attribute byte. Reads explicit 2-byte field length. Validates `start + length ≤ screenSize`. Creates field with all properties.
- **Our emulator** (`parser.ts:443-511`): Reads FFW (2 bytes). Reads optional FCW (checks bit 7). Reads optional attribute byte (0x20-0x3F). Does NOT read explicit field length — length is calculated post-parse from field positions in `calculateFieldLengths()`. Has a 4-byte skip-ahead heuristic.
- **Match:** No — lib5250 uses explicit length from data stream; we infer length from adjacent field positions. This is a fundamental architectural difference.

### SOH Header Parsing

- **lib5250** (`session.c:1810`): Clears field format table. Clears pending insert cursor. Locks keyboard. Reads length byte (0-7). Stores header data.
- **Our emulator** (`parser.ts:308-316`): Reads length byte. Skips `length - 2` bytes. No format table clear, no keyboard lock.
- **Match:** No — we're missing the format table clear and keyboard lock side effects.

### RA Repeat Logic

- **lib5250** (`session.c:2161`): Reads target Y,X (1-based) + char byte. Validates target ≥ current. Loops calling `tn5250_display_addch()` which auto-advances with wrapping (`cx %= w; cy %= h`).
- **Our emulator** (`parser.ts:278-291`): Reads target row,col (0-based) + char byte. Loops `while (currentAddr < targetAddr)`. No wrapping.
- **Match:** Partial — basic fill works, but no wrapping support. Also 0-based vs 1-based address difference.

### EA Erase Logic

- **lib5250** (`session.c:2075`): Reads target Y,X (1-based). Reads LEN byte (2-5) + attribute type bytes. Validates target ≥ current. Uses `tn5250_display_erase_region()` with multi-row edge logic (first row, middle rows, last row).
- **Our emulator** (`parser.ts:294-305`): Reads target row,col (0-based) only. No length/attribute bytes. Simple space fill loop. No wrapping.
- **Match:** No — we're missing the attribute type parameter entirely. Our EA likely consumes too few bytes, causing subsequent byte misalignment.

### WTD CC1/CC2 Handling

- **lib5250** (`session.h`, `session.c:891`): CC1 uses upper 3 bits as a switch (0x00/0x40/0x60/0x80/0xA0/0xC0/0xE0) controlling MDT reset + null fill combos. CC2 has individual bits for unlock (0x08), alarm (0x04), message on/off, blink, IC suppress.
- **Our emulator** (`parser.ts:150-176`): CC1 checks bit 5 (0x20) for MDT reset and bit 6 (0x40) for null fill independently. CC2 is read but ignored entirely.
- **Match:** Partial — our CC1 bit checks overlap with some of the 3-bit combos but miss others. CC2 features (keyboard unlock, alarm) not implemented.

### IC Insert Cursor

- **lib5250** (`session.c:2049`): Reads Y,X (1-based). Stores as "pending insert" via `tn5250_display_set_pending_insert()`. Cursor is positioned AFTER WTD completes, not immediately.
- **Our emulator** (`parser.ts:257-262`): Sets cursor immediately to currentAddr.
- **Match:** No — timing difference. Immediate vs deferred cursor positioning.

### EBCDIC Translation Table

- **lib5250** (`scs.c` / built-in tables): CCSID 37 mapping.
- **Our emulator** (`ebcdic.ts`): CCSID 37 mapping with 256-entry table.
- **Match:** Yes — both use standard CCSID 37. Our table appears complete for all 256 byte values.

### Field Attribute Values

- **lib5250** (`codes5250.h`): Defines color-based attributes: GREEN (0x20), WHITE (0x22), NONDISP (0x27), RED (0x28), TURQ (0x30), YELLOW (0x32), PINK (0x38), BLUE (0x3A).
- **Our emulator** (`constants.ts`): Defines: NORMAL (0x20), REVERSE (0x21), HIGH_INTENSITY (0x22), UNDERSCORE (0x24), BLINK (0x25), NON_DISPLAY (0x27), COLUMN_SEPARATOR (0x23). Missing RED (0x28), TURQ (0x30), YELLOW (0x32), PINK (0x38), BLUE (0x3A).
- **Match:** Partial — our attribute naming uses a different paradigm (display style vs color). We map 0x22 to HIGH_INTENSITY where lib5250 calls it WHITE. We're missing the color attribute range (0x28-0x3A).

### Buffer Addressing

- **lib5250** (`dbuffer.c`): Linear array `data[cy * w + cx]`. 0-based internally. Cursor wraps on overflow: `cx %= w; cy = (cy + cx/w) % h`.
- **Our emulator** (`screen.ts`): Linear array `buffer[row * cols + col]`. 0-based. No wrapping on overflow — bounds check with `if (addr < this.size)`.
- **Match:** Partial — same addressing formula but we don't wrap, we clamp/reject.
