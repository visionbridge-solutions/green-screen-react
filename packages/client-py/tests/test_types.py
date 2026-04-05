"""Round-trip tests for wire-type dataclasses.

Each dataclass has a from_wire() constructor that must tolerate the exact
JSON shape the proxy emits. These tests exercise representative payloads
captured from the proxy to guard against drift between the TS wire type
and the Python dataclasses.
"""

from green_screen_client.types import (
    CellExtAttr,
    ConnectConfig,
    ConnectionStatus,
    Field,
    FieldValue,
    ScreenData,
    SelectionField,
    SendResult,
    Window,
)


def test_field_minimal():
    f = Field.from_wire({"row": 5, "col": 10, "length": 8, "is_input": True, "is_protected": False})
    assert f.row == 5 and f.col == 10 and f.length == 8
    assert f.is_input is True and f.is_protected is False
    assert f.shift_type is None
    assert f.modified is None


def test_field_full_v1_2():
    wire = {
        "row": 3,
        "col": 20,
        "length": 10,
        "is_input": True,
        "is_protected": False,
        "is_highlighted": True,
        "is_non_display": False,
        "color": "turquoise",
        "shift_type": "numeric_only",
        "monocase": True,
        "self_check_mod10": True,
        "self_check_mod11": False,
        "resequence": 5,
        "progression_id": 2,
        "pointer_aid": 0x31,
        "highlight_entry_attr": 0x22,
        "is_dbcs": False,
        "modified": True,
    }
    f = Field.from_wire(wire)
    assert f.is_highlighted is True
    assert f.color == "turquoise"
    assert f.shift_type == "numeric_only"
    assert f.monocase is True
    assert f.self_check_mod10 is True
    assert f.resequence == 5
    assert f.modified is True


def test_field_value():
    fv = FieldValue.from_wire({"row": 1, "col": 2, "length": 5, "value": "HELLO", "modified": True})
    assert fv.value == "HELLO"
    assert fv.modified is True


def test_screen_data_round_trip():
    wire = {
        "content": "line1\nline2",
        "cursor_row": 1,
        "cursor_col": 0,
        "rows": 24,
        "cols": 80,
        "fields": [
            {"row": 0, "col": 0, "length": 10, "is_input": False, "is_protected": True},
            {"row": 1, "col": 0, "length": 10, "is_input": True, "is_protected": False, "modified": True},
        ],
        "screen_signature": "abc123",
        "timestamp": "2026-04-05T00:00:00Z",
        "keyboard_locked": False,
        "message_waiting": True,
        "alarm": False,
        "insert_mode": True,
        "windows": [{"row": 5, "col": 5, "height": 10, "width": 40, "title": "Hi"}],
        "selection_fields": [
            {"row": 2, "col": 0, "num_rows": 5, "num_cols": 20, "choices": [
                {"text": "1. Option A", "row": 2, "col": 0},
                {"text": "2. Option B", "row": 3, "col": 0},
            ]},
        ],
        "screen_stack_depth": 1,
        "is_popup": True,
        "ext_attrs": {"42": {"color": 3, "highlight": 1}},
        "dbcs_cont": [80, 82],
        "code_page": "cp290",
    }
    s = ScreenData.from_wire(wire)
    assert s.rows == 24 and s.cols == 80
    assert len(s.fields) == 2 and s.fields[1].modified is True
    assert s.message_waiting is True
    assert s.insert_mode is True
    assert s.windows is not None and s.windows[0].title == "Hi"
    assert s.selection_fields is not None
    assert len(s.selection_fields[0].choices) == 2
    assert s.selection_fields[0].choices[0].text == "1. Option A"
    assert s.is_popup is True
    assert s.ext_attrs is not None and 42 in s.ext_attrs
    assert s.ext_attrs[42].color == 3
    assert s.dbcs_cont == [80, 82]
    assert s.code_page == "cp290"


def test_connection_status():
    s = ConnectionStatus.from_wire({"connected": True, "status": "authenticated", "username": "alice"})
    assert s.connected is True and s.status == "authenticated" and s.username == "alice"


def test_connect_config_to_wire():
    cfg = ConnectConfig(
        host="pub400.com",
        port=23,
        username="u",
        password="p",
        terminal_type="IBM-3179-2",
        connect_timeout=30000,
    )
    wire = cfg.to_wire()
    assert wire["host"] == "pub400.com"
    assert wire["terminalType"] == "IBM-3179-2"
    assert wire["connectTimeout"] == 30000
    assert "codePage" not in wire  # unset optional fields are omitted


def test_send_result():
    r = SendResult.from_wire({"success": True, "cursor_row": 5, "cursor_col": 10})
    assert r.success is True and r.cursor_row == 5 and r.cursor_col == 10
    r2 = SendResult.from_wire({"success": False, "error": "boom"})
    assert r2.success is False and r2.error == "boom"


def test_cell_ext_attr():
    e = CellExtAttr.from_wire({"color": 3, "highlight": 1, "char_set": 0})
    assert e.color == 3 and e.highlight == 1 and e.char_set == 0


def test_selection_field_without_choices():
    sf = SelectionField.from_wire({"row": 0, "col": 0, "num_rows": 3, "num_cols": 10})
    assert sf.choices == []


def test_window_optional_title():
    w = Window.from_wire({"row": 0, "col": 0, "height": 5, "width": 20})
    assert w.title is None and w.footer is None
