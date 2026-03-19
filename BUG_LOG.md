# Bug Log — TN5250 Terminal Emulator

## Summary

| # | Category | Severity | Status | Description |
|---|----------|----------|--------|-------------|
| SUSPECT-001 | Protocol | High | Investigating | SBA/IC/MC/RA/EA 0-based vs 1-based addressing |
| SUSPECT-002 | Protocol | High | Investigating | RA/EA orders do not wrap around screen |
| SUSPECT-003 | Protocol | High | Investigating | EA missing attribute type parameter (byte misalignment) |
| SUSPECT-004 | Protocol | Medium | Investigating | SF field length not read from data stream |
| SUSPECT-005 | Protocol | Medium | Investigating | IC sets cursor immediately instead of deferring to post-WTD |
| SUSPECT-006 | Protocol | Medium | Investigating | SOH doesn't clear format table or lock keyboard |
| SUSPECT-007 | Parser | Medium | Investigating | ROLL command stub — reads bytes but doesn't scroll |
| SUSPECT-008 | Parser | Low | Investigating | Last field length cap heuristic may truncate |
| SUSPECT-009 | Parser | Low | Investigating | parseStartField 4-byte skip-ahead heuristic |
| SUSPECT-010 | Parser | Low | Investigating | Cursor repositioning side-effect in calculateFieldLengths |
| SUSPECT-011 | Protocol | Low | Investigating | CC1 bit-check vs lib5250 3-bit dispatch |
| SUSPECT-012 | Rendering | Low | Investigating | Field attributes missing color range (0x28-0x3A) |

---

## Bug Detail Format

### BUG-NNN: [Short Title]
- **Severity:** Critical / High / Medium / Low
- **Category:** Parsing / Rendering / Input / Protocol / State
- **Screen:** [Which screen/scenario triggers it]
- **Symptom:** [What the user sees]
- **Internal State:** [What page.evaluate / state dump shows]
- **Root Cause:** [Technical explanation]
- **File(s):** [Affected source files with line numbers]
- **Reference:** [lib5250 file/function if applicable]
- **Fix:** [Description of fix applied]
- **Commit:** [hash]
- **Verified:** [ ] Screenshot before / [ ] Screenshot after / [ ] Regression test

---

## Suspected Issues (from code review)

### SUSPECT-001: SBA/IC/MC/RA/EA 0-based vs 1-based addressing
- **Severity:** High
- **Category:** Protocol
- **File:** `packages/proxy/src/tn5250/parser.ts:249-252, 270-271, 283-285, 298-299`
- **Reference:** lib5250 `session.c:1860` — uses 1-based Y,X with explicit `Y-1`, `X-1`
- **Risk:** Every positioned operation (field placement, cursor, fill) could be off by one row and one column
- **Verification:** Capture raw SBA bytes from pub400 and check if they are 0-based or 1-based

### SUSPECT-002: RA/EA orders do not wrap around screen
- **Severity:** High
- **Category:** Protocol
- **File:** `packages/proxy/src/tn5250/parser.ts:287, 300`
- **Reference:** lib5250 `dbuffer.c` — wrapping via `cx %= w; cy %= h`
- **Risk:** Repeat-to-address and erase-to-address silently fail if target address < current address
- **Verification:** Find a screen where RA/EA wraps (may require specific test programs)

### SUSPECT-003: EA missing attribute type parameter
- **Severity:** High
- **Category:** Protocol
- **File:** `packages/proxy/src/tn5250/parser.ts:294-305`
- **Reference:** lib5250 `session.c:2075` — EA reads LEN byte + attribute types after address
- **Risk:** Our EA consumes only 2 bytes after the order, but the host sends additional bytes (length + attr types). This causes byte misalignment — subsequent orders are parsed from wrong positions
- **Verification:** Capture raw data stream containing EA order and check byte count

### SUSPECT-004: SF field length not read from data stream
- **Severity:** Medium
- **Category:** Protocol
- **File:** `packages/proxy/src/tn5250/parser.ts:443-511` (parseStartField) and `parser.ts:539-614` (calculateFieldLengths)
- **Reference:** lib5250 `session.c:1499` — reads explicit 2-byte length after attribute byte
- **Risk:** Field lengths are inferred from adjacent field positions, which could be wrong if fields are not contiguous or if the last field wraps
- **Verification:** Compare inferred field lengths with actual data entered on screen

### SUSPECT-005: IC sets cursor immediately instead of deferring
- **Severity:** Medium
- **Category:** Protocol
- **File:** `packages/proxy/src/tn5250/parser.ts:257-262`
- **Reference:** lib5250 `session.c:2049` — stores "pending insert", applied after WTD completes
- **Risk:** If multiple IC orders appear in one WTD, we use the first one's position during processing; lib5250 uses the last one after all orders are processed
- **Verification:** Send WTD with multiple IC orders, check final cursor position

### SUSPECT-006: SOH doesn't clear format table or lock keyboard
- **Severity:** Medium
- **Category:** Protocol
- **File:** `packages/proxy/src/tn5250/parser.ts:308-316`
- **Reference:** lib5250 `session.c:1810` — SOH clears field format table, clears pending insert, locks keyboard
- **Risk:** Stale fields from previous screen format persist after SOH
- **Verification:** Navigate between screens with different field layouts, check for ghost fields

### SUSPECT-007: ROLL command stub
- **Severity:** Medium
- **Category:** Parser
- **File:** `packages/proxy/src/tn5250/parser.ts:203-212`
- **Risk:** Server-side scrolling (some PageUp/PageDown implementations) won't work. Only marks `modified` but doesn't actually move buffer content
- **Verification:** Find a screen that uses ROLL (vs sending full new screen)

### SUSPECT-008: Last field length cap heuristic
- **Severity:** Low
- **Category:** Parser
- **File:** `packages/proxy/src/tn5250/parser.ts:565-566`
- **Risk:** Last field on screen may have wrong length if it legitimately wraps past 2 rows. Caps at `cols * 2` then falls back to `cols - col`
- **Verification:** Find a screen with a long last field (command line on main menu)

### SUSPECT-009: parseStartField 4-byte skip-ahead
- **Severity:** Low
- **Category:** Parser
- **File:** `packages/proxy/src/tn5250/parser.ts:484-494`
- **Risk:** Could skip legitimate field content or miss SBA that's >4 bytes away
- **Verification:** Check data streams where SF is followed by immediate data (not SBA)

### SUSPECT-010: Cursor repositioning in calculateFieldLengths
- **Severity:** Low
- **Category:** Parser
- **File:** `packages/proxy/src/tn5250/parser.ts:574-602`
- **Risk:** Masks cursor bugs from IC/MC by overriding cursor position post-parse. Also makes debugging harder
- **Verification:** Disable this repositioning logic and check if cursor position from IC/MC alone is correct

### SUSPECT-011: CC1 bit-check vs 3-bit dispatch
- **Severity:** Low
- **Category:** Protocol
- **File:** `packages/proxy/src/tn5250/parser.ts:158-175`
- **Reference:** lib5250 `session.h` — CC1 uses upper 3 bits (0xE0 mask) as 7-value switch
- **Risk:** Some CC1 combinations that should both reset MDT AND null-fill may not behave correctly with individual bit checks
- **Verification:** Trace CC1 byte values from host and compare behavior

### SUSPECT-012: Field attributes missing color range
- **Severity:** Low
- **Category:** Rendering
- **File:** `packages/proxy/src/tn5250/constants.ts:150-158`
- **Reference:** lib5250 `codes5250.h` — defines RED (0x28), TURQ (0x30), YELLOW (0x32), PINK (0x38), BLUE (0x3A)
- **Risk:** Fields with color attributes (0x28-0x3A) may be classified incorrectly by decodeDisplayAttr
- **Verification:** Find a screen with colored fields and check attribute mapping

---

## Resolved Bugs

(none yet — to be populated in Phase 2)
