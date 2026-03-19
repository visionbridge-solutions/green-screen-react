# Bug Log — TN5250 Terminal Emulator

## Summary

| # | Category | Severity | Status | Description |
|---|----------|----------|--------|-------------|
| BUG-001 | Protocol | Critical | Fixed | SBA/IC/MC/RA/EA 1-based→0-based address conversion missing |
| BUG-002 | Protocol | Critical | Fixed | Encoder sends 0-based addresses in AID responses |
| BUG-003 | Protocol | High | Fixed | EA order missing length/attribute bytes (byte misalignment) |
| BUG-004 | Protocol | High | Fixed | RA/EA orders do not wrap around screen |
| BUG-005 | Protocol | Medium | Fixed | IC sets cursor immediately instead of deferring to post-WTD |
| BUG-006 | Protocol | Medium | Fixed | IC reads 0 bytes instead of 2 (row, col) |
| BUG-007 | Protocol | Medium | Fixed | SOH doesn't clear format table or pending IC |
| SUSPECT-004 | Protocol | Medium | TODO: REVIEW | SF field length not read from data stream (inferred from positions) |
| SUSPECT-007 | Parser | Medium | TODO: REVIEW | ROLL command stub — reads bytes but doesn't scroll |
| SUSPECT-008 | Parser | Low | TODO: REVIEW | Last field length cap heuristic may truncate |
| SUSPECT-009 | Parser | Low | TODO: REVIEW | parseStartField 4-byte skip-ahead heuristic |
| SUSPECT-010 | Parser | Low | TODO: REVIEW | Cursor repositioning side-effect in calculateFieldLengths |
| SUSPECT-011 | Protocol | Low | TODO: REVIEW | CC1 bit-check vs lib5250 3-bit dispatch |
| SUSPECT-012 | Rendering | Low | TODO: REVIEW | Field attributes missing color range (0x28-0x3A) |

---

## Resolved Bugs

### BUG-001: SBA/IC/MC/RA/EA 1-based→0-based address conversion missing
- **Severity:** Critical
- **Category:** Protocol
- **Screen:** All screens — every positioned operation affected
- **Symptom:** All text, fields, and cursor positions shifted by +1 row and +1 column from their correct positions
- **Internal State:** `ScreenBuffer.cursorRow`, `cursorCol`, field positions all off-by-one
- **Root Cause:** The IBM 5250 data stream sends all SBA/IC/MC/RA/EA addresses as 1-based (row 1, col 1 = top-left). Our parser treated them as 0-based, using them directly without subtracting 1.
- **File(s):** `packages/proxy/src/tn5250/parser.ts` — SBA (line 249), IC (line 258), MC (line 270), RA (line 282), EA (line 298)
- **Reference:** lib5250 `session.c:1860-1881` — `Y-1, X-1` conversion; validates Y==0 as invalid
- **Fix:** Subtract 1 from all row/col bytes read from host data stream in SBA, IC, MC, RA, EA orders
- **Commit:** 7575662
- **Verified:** [x] Screenshot before (N/A — pre-fix) / [x] Screenshot after / [x] Regression test

### BUG-002: Encoder sends 0-based addresses in AID responses
- **Severity:** Critical
- **Category:** Protocol
- **Screen:** All screens — every AID response (Enter, F-keys, PageUp/Down) affected
- **Symptom:** Host misinterprets cursor and field positions, could cause data to be placed in wrong fields
- **Root Cause:** Encoder sent `cursorRow, cursorCol` and `field.row, field.col` directly without adding 1. The 5250 protocol requires 1-based addresses in responses.
- **File(s):** `packages/proxy/src/tn5250/encoder.ts` — cursor (line 34), field SBA (line 47)
- **Reference:** lib5250 `session.c:371-372` — `Y+1, X+1`; `session.c:548-549` — `start_row+1, start_col+1`
- **Fix:** Add 1 to cursor row/col and field row/col when building AID response buffers
- **Commit:** 7575662
- **Verified:** [x] Screenshot after / [x] Regression test (sign-in, commands, navigation all work)

### BUG-003: EA order missing length/attribute bytes
- **Severity:** High
- **Category:** Protocol
- **Screen:** Any screen using EA (Erase to Address) orders
- **Symptom:** Byte misalignment — subsequent orders after EA parsed from wrong positions, causing garbled screen content
- **Root Cause:** Our EA implementation read only 2 bytes (row, col) after the order byte. Per lib5250 and the 5250 spec, EA reads: row(1), col(1), length(1), then `length-1` attribute type bytes. Missing the length+attribute bytes caused the parser to be misaligned for all subsequent bytes.
- **File(s):** `packages/proxy/src/tn5250/parser.ts` — EA handler (was line 294-305)
- **Reference:** lib5250 `session.c:2075-2148` — reads row, col, length byte, then attribute types
- **Fix:** EA now reads the length byte and consumes attribute type bytes. Also implements erase only when attribute is 0xFF (erase all), matching lib5250 behavior.
- **Commit:** 7575662
- **Verified:** [x] Regression test

### BUG-004: RA/EA orders do not wrap around screen
- **Severity:** High
- **Category:** Protocol
- **Screen:** Screens where RA/EA target address is before current address (wrap-around)
- **Symptom:** RA/EA silently fails — no fill/erase occurs when target < current
- **Root Cause:** Loop condition `while (currentAddr < targetAddr)` exits immediately when target < current. The 5250 screen buffer is circular — RA/EA should wrap from end to start.
- **File(s):** `packages/proxy/src/tn5250/parser.ts` — RA and EA handlers
- **Reference:** lib5250 `dbuffer.c` — wrapping via `cx %= w; cy %= h`
- **Fix:** Added wrap-around logic: when target < current, fill to end of screen then continue from 0 to target.
- **Commit:** 7575662
- **Verified:** [x] Regression test

### BUG-005: IC sets cursor immediately instead of deferring
- **Severity:** Medium
- **Category:** Protocol
- **Screen:** Any screen with IC (Insert Cursor) orders
- **Symptom:** If multiple IC orders appear in one WTD, cursor ends up at first IC position instead of last
- **Root Cause:** IC set `cursorRow`/`cursorCol` immediately during order processing. Per lib5250, IC stores a "pending insert" position that is applied AFTER WTD processing completes (last IC wins).
- **File(s):** `packages/proxy/src/tn5250/parser.ts` — IC handler and end of `parseOrders()`
- **Reference:** lib5250 `session.c:2049-2072` — `tn5250_display_set_pending_insert()`
- **Fix:** IC now sets `pendingICRow`/`pendingICCol` local variables. At the end of `parseOrders()`, the pending position is applied to the cursor if set.
- **Commit:** 7575662
- **Verified:** [x] Regression test (cursor positions correct on all tested screens)

### BUG-006: IC reads 0 bytes instead of 2
- **Severity:** Medium
- **Category:** Protocol
- **Screen:** Any screen with IC orders
- **Symptom:** IC used `currentAddr` instead of reading its own row/col bytes from the data stream, and the 2 bytes meant for IC were consumed as subsequent orders, causing misalignment
- **Root Cause:** Original IC implementation used `this.screen.toRowCol(currentAddr)` without reading any bytes. Per the 5250 spec and lib5250, IC reads 2 bytes (row, col) just like SBA/MC.
- **File(s):** `packages/proxy/src/tn5250/parser.ts` — IC handler
- **Reference:** lib5250 `session.c:2055-2056` — `y = get_byte(); x = get_byte();`
- **Fix:** IC now reads 2 bytes (row, col) from the data stream, converts from 1-based to 0-based
- **Commit:** 7575662
- **Verified:** [x] Regression test

### BUG-007: SOH doesn't clear format table or pending IC
- **Severity:** Medium
- **Category:** Protocol
- **Screen:** Screen transitions using SOH (Start of Header)
- **Symptom:** Stale fields from previous screen format could persist after SOH
- **Root Cause:** SOH skipped header bytes but didn't clear the field list or pending cursor, both of which lib5250 does.
- **File(s):** `packages/proxy/src/tn5250/parser.ts` — SOH handler
- **Reference:** lib5250 `session.c:1810` — clears format table, clears pending insert
- **Fix:** SOH now clears `this.screen.fields` and resets pending IC position
- **Commit:** 7575662
- **Verified:** [x] Regression test (screen transitions clean, no ghost fields observed)

---

## TODO: REVIEW Items

### SUSPECT-004: SF field length not read from data stream
- **Status:** Not yet causing visible issues
- **Reason:** Field lengths are inferred from adjacent field positions in `calculateFieldLengths()`. This works correctly for all tested screens (sign-on, main menu, WRKACTJOB, DSPLIB). May cause issues with non-contiguous fields or fields that wrap across multiple rows.
- **Action:** Monitor; fix only if specific screens show wrong field lengths

### SUSPECT-007: ROLL command stub
- **Status:** Not triggered during testing
- **Reason:** pub400.com sends full screen updates for PageUp/PageDown instead of ROLL commands. ROLL may be used by other IBM i servers or specific programs.
- **Action:** Implement when a ROLL-using scenario is found

### SUSPECT-008: Last field length cap heuristic
- **Status:** Not causing visible issues
- **Reason:** The command line field (last field on main menu) has length 153 which is correct for the available space. The heuristic only triggers for fields > 2 rows, which hasn't been observed.
- **Action:** Monitor

### SUSPECT-009: parseStartField 4-byte skip-ahead
- **Status:** Not causing visible issues
- **Reason:** All tested screens parse correctly. The skip-ahead may be needed for specific data stream patterns.
- **Action:** Monitor

### SUSPECT-010: Cursor repositioning in calculateFieldLengths
- **Status:** Not causing visible issues
- **Reason:** With IC now deferred correctly, `calculateFieldLengths()` cursor adjustment serves as a safety net ensuring cursor lands on an input field. All tested screens show correct cursor positions.
- **Action:** Monitor; may mask future IC/MC bugs

### SUSPECT-011: CC1 bit-check vs 3-bit dispatch
- **Status:** Not causing visible issues
- **Reason:** Common CC1 values (0x00, 0x20, 0x40, 0x60) work correctly with our bit checks. Edge cases with less common combinations may misbehave.
- **Action:** Monitor

### SUSPECT-012: Field attributes missing color range
- **Status:** Cosmetic only
- **Reason:** Attributes 0x28-0x3A (RED, TURQ, YELLOW, etc.) are not mapped as distinct colors. They would be classified as NORMAL or HIGH_INTENSITY. Visual distinction is missing but fields are still functional.
- **Action:** Implement color attribute rendering in a future UI enhancement pass

---

## Regression Test Results

### After commit 7575662 (all BUG-001 through BUG-007 fixes)

| Screen | Status | Notes |
|--------|--------|-------|
| Sign-on screen | PASS | Welcome text correct position, username/password fields correct, cursor on username field |
| Tab cycling | PASS | Visits all input fields, wraps around correctly |
| Typing in fields | PASS | Characters appear at correct positions (verified visually) |
| Error credentials | PASS | CPF1120 error message on bottom row |
| Valid sign-in | PASS | Navigates through sign-on to main menu |
| Main menu | PASS | All menu items aligned, command line functional, system info header correct |
| WRKACTJOB | PASS | Column headers aligned with data, Opt fields present, More... indicator |
| PageDown | PASS | New data loaded, no remnants, columns aligned |
| PageUp | PASS | Returns to previous data |
| DSPLIB | PASS | Library details correct, data columns aligned |
| Garbage command | PASS | "Command XYZXYZ in library *LIBL not found." on error line |
| F3 exit | PASS | Clean return to previous screen |
| F12 cancel | PASS | Clean return to previous screen |
| Sign off | PASS | SIGNOFF command processed |
