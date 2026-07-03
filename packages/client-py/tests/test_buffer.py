"""ScreenBuffer.apply() must mirror every ScreenData attribute integrators
read off the cached buffer. Regression guard for the CA/CF key-mask field,
which was silently dropped here (the buffer is the shape REST integrations
actually consume, so a field missing from apply() is invisible to them even
when the proxy emits it).
"""

from green_screen_client.buffer import ScreenBuffer
from green_screen_client.types import ScreenData


def _screen(**overrides) -> ScreenData:
    base = {
        "content": "HELLO",
        "cursor_row": 1,
        "cursor_col": 2,
        "rows": 24,
        "cols": 80,
        "fields": [],
        "screen_signature": "sig",
        "timestamp": "2026-01-01T00:00:00Z",
    }
    base.update(overrides)
    return ScreenData.from_wire(base)


def test_apply_retains_command_keys_no_transmit():
    buf = ScreenBuffer()
    assert buf.command_keys_no_transmit is None

    buf.apply(_screen(command_keys_no_transmit=["F3", "F10", "F12"]))
    assert buf.command_keys_no_transmit == ["F3", "F10", "F12"]


def test_apply_clears_stale_mask_when_next_screen_has_none():
    buf = ScreenBuffer()
    buf.apply(_screen(command_keys_no_transmit=["F6"]))
    assert buf.command_keys_no_transmit == ["F6"]

    # Next screen carries no SOH key mask — a stale CA list must not
    # survive, or the integrator would warn about the wrong screen.
    buf.apply(_screen())
    assert buf.command_keys_no_transmit is None
