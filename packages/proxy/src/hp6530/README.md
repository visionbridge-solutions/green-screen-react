# HP 6530 engine — supported subset

Best-effort support for HP NonStop (Tandem) 6530-family terminals. **No free
NonStop emulator exists**, so unlike TN5250 (live IBM i) and TN3270 (Hercules
MVS), this engine cannot be verified against a real host — the implemented
subset below is frozen and pinned by `parser.test.ts` / conformance tests, and
deliberately NOT extended speculatively.

## What is implemented (conversational + ANSI-ish subset)

- **Controls**: CR, LF (no scroll — block-mode stay-put at the last row), BS,
  HT (tab to next unprotected field, else 8-column stops), FF (clear), BEL/NUL
  ignored; printable ASCII + high-bit bytes pass through (latin1).
- **Cursor addressing**: `ESC [ row ; col H` (1-based CUP).
- **Erase**: `ESC [ 0/1/2 J`, `ESC [ K`, plus HP short forms `ESC J` (clear to
  end of screen) and `ESC K` (clear to end of line).
- **Display attributes**: `ESC & d <code>` with codes `@` normal, `B` half
  bright, `D` underline, `H` blink, `J` inverse, `L` underline+inverse.
- **Protection / fields**: `ESC )` starts a protected span, `ESC (` ends it;
  input fields are derived as the unprotected gaps between protected spans
  (`screen.buildFields()`); typing marks the containing field modified.
- **Block-mode reply**: action keys (ENTER / F1–F16 / SF1–SF16) transmit the
  modified unprotected fields (HT-separated, trailing blanks trimmed) followed
  by the key's `ESC p..w` / `` ESC ` ..g `` sequence.

## Known gaps (deliberate)

Native 6530 block-mode specifics from the 6530 Programmer's Guide are absent:
6530-specific cursor addressing, ETX/EOT block terminators, DC1 read triggers,
page-mode field definition sequences, status-line protocol. If a real NonStop
integration ever materializes, extend from captures — not from the manual
alone — and lift the conformance tests with it.
