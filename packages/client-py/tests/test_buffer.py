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


def test_apply_projects_the_declared_width_provenance():
    """``length_source`` is the host's own statement that a width is a fact,
    not a measurement — dropping it here made every declared width read as an
    inferred gap downstream (no width constraint was ever enforced)."""
    buf = ScreenBuffer()
    buf.apply(_screen(fields=[
        {"row": 3, "col": 20, "length": 4, "is_input": True, "is_protected": False,
         "length_source": "declared"},
        {"row": 5, "col": 20, "length": 43, "is_input": True, "is_protected": False},
    ]))
    assert buf.fields[0]["length_source"] == "declared"
    assert buf.fields[1]["length_source"] is None


def test_every_field_attribute_reaches_the_projected_dict():
    """Structural: ``_field_to_dict`` is LOSSLESS over ``Field``.

    The dict — not the dataclass — is what integrators consume, so an attribute
    the parser fills and this projection omits is indistinguishable from a host
    that never sent it. Four FFW bits were dropped this way for months
    (auto_enter, field_exit_required, dup_enable, is_numeric), silently pinning
    the DDS AUTO(RA/RAB) TAB-suppression, the CHECK(ER) Field-Exit requirement
    and the numeric-shift hint permanently OFF downstream.

    Asserting against ``dataclasses.fields`` rather than a hand-written list is
    the point: a newly parsed attribute fails here until it is projected too.
    """
    import dataclasses

    from green_screen_client.types import Field

    # The single deliberate rename in the projection.
    aliases = {"mandatory_entry": "is_mandatory"}

    projected = ScreenBuffer._field_to_dict(Field.from_wire(
        {"row": 0, "col": 0, "length": 1, "is_input": True, "is_protected": False}
    ))
    missing = [
        f.name for f in dataclasses.fields(Field)
        if aliases.get(f.name, f.name) not in projected
    ]
    assert not missing, (
        "Field attributes parsed off the wire but never projected to the dict "
        f"integrators read: {missing}"
    )


def test_the_ffw_typing_bits_survive_the_projection():
    """Behavioural counterpart: the bits the 5250 proxy actually sets."""
    buf = ScreenBuffer()
    buf.apply(_screen(fields=[{
        "row": 2, "col": 10, "length": 6,
        "is_input": True, "is_protected": False,
        "auto_enter": True, "field_exit_required": True,
        "dup_enable": True, "is_numeric": True,
        "is_dbcs_either": True, "pointer_aid": 7,
    }]))
    f = buf.fields[0]
    assert f["auto_enter"] is True
    assert f["field_exit_required"] is True
    assert f["dup_enable"] is True
    assert f["is_numeric"] is True
    assert f["is_dbcs_either"] is True
    assert f["pointer_aid"] == 7


def test_an_absent_ffw_bit_projects_false_not_missing():
    """Absent must be a VERDICT (False), never a missing key — a consumer
    doing ``f["auto_enter"]`` must not KeyError on a host that omits it."""
    buf = ScreenBuffer()
    buf.apply(_screen(fields=[
        {"row": 0, "col": 0, "length": 3, "is_input": True, "is_protected": False},
    ]))
    f = buf.fields[0]
    assert f["auto_enter"] is False
    assert f["field_exit_required"] is False
    assert f["dup_enable"] is False
    assert f["is_numeric"] is False
    assert f["pointer_aid"] is None  # an int attribute, not a flag
