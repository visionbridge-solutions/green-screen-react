"""Typed dataclasses mirroring the wire format of `green-screen-types`.

The canonical source is the TypeScript definitions in
`packages/types/src/index.ts`. This module keeps one-to-one parity with
those definitions so Python clients can work with the same shape the proxy
emits. Any fields added to the TS type must be reflected here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional

ProtocolType = Literal["tn5250", "tn3270", "vt", "hp6530"]

FieldColor = Literal["green", "white", "red", "turquoise", "yellow", "pink", "blue"]

ShiftType = Literal[
    "alpha",
    "alpha_only",
    "numeric_shift",
    "numeric_only",
    "katakana",
    "digits_only",
    "io",
    "signed_num",
]


@dataclass
class Field:
    """Field definition from the terminal data stream.

    Mirrors `Field` in green-screen-types. Only `row`, `col`, `length`,
    `is_input`, `is_protected` are guaranteed to be present; everything
    else is optional and may be absent on protocols that don't expose
    the underlying TN5250 FCW/FFW metadata.
    """

    row: int
    col: int
    length: int
    is_input: bool
    is_protected: bool
    is_highlighted: Optional[bool] = None
    is_reverse: Optional[bool] = None
    is_underscored: Optional[bool] = None
    is_non_display: Optional[bool] = None
    color: Optional[FieldColor] = None
    highlight_entry_attr: Optional[int] = None
    resequence: Optional[int] = None
    progression_id: Optional[int] = None
    pointer_aid: Optional[int] = None
    is_dbcs: Optional[bool] = None
    is_dbcs_either: Optional[bool] = None
    self_check_mod10: Optional[bool] = None
    self_check_mod11: Optional[bool] = None
    shift_type: Optional[ShiftType] = None
    monocase: Optional[bool] = None
    modified: Optional[bool] = None

    @classmethod
    def from_wire(cls, data: Dict[str, Any]) -> "Field":
        return cls(
            row=data["row"],
            col=data["col"],
            length=data["length"],
            is_input=data.get("is_input", False),
            is_protected=data.get("is_protected", False),
            is_highlighted=data.get("is_highlighted"),
            is_reverse=data.get("is_reverse"),
            is_underscored=data.get("is_underscored"),
            is_non_display=data.get("is_non_display"),
            color=data.get("color"),
            highlight_entry_attr=data.get("highlight_entry_attr"),
            resequence=data.get("resequence"),
            progression_id=data.get("progression_id"),
            pointer_aid=data.get("pointer_aid"),
            is_dbcs=data.get("is_dbcs"),
            is_dbcs_either=data.get("is_dbcs_either"),
            self_check_mod10=data.get("self_check_mod10"),
            self_check_mod11=data.get("self_check_mod11"),
            shift_type=data.get("shift_type"),
            monocase=data.get("monocase"),
            modified=data.get("modified"),
        )


@dataclass
class FieldValue:
    """Single field readout returned by the MDT read primitive."""

    row: int
    col: int
    length: int
    value: str
    modified: bool

    @classmethod
    def from_wire(cls, data: Dict[str, Any]) -> "FieldValue":
        return cls(
            row=data["row"],
            col=data["col"],
            length=data["length"],
            value=data.get("value", ""),
            modified=bool(data.get("modified", False)),
        )


@dataclass
class Window:
    row: int
    col: int
    height: int
    width: int
    title: Optional[str] = None
    footer: Optional[str] = None

    @classmethod
    def from_wire(cls, data: Dict[str, Any]) -> "Window":
        return cls(
            row=data["row"],
            col=data["col"],
            height=data["height"],
            width=data["width"],
            title=data.get("title"),
            footer=data.get("footer"),
        )


@dataclass
class SelectionChoice:
    text: str
    row: int
    col: int

    @classmethod
    def from_wire(cls, data: Dict[str, Any]) -> "SelectionChoice":
        return cls(text=data.get("text", ""), row=data["row"], col=data["col"])


@dataclass
class SelectionField:
    row: int
    col: int
    num_rows: int
    num_cols: int
    choices: List[SelectionChoice] = field(default_factory=list)

    @classmethod
    def from_wire(cls, data: Dict[str, Any]) -> "SelectionField":
        return cls(
            row=data["row"],
            col=data["col"],
            num_rows=data.get("num_rows", 0),
            num_cols=data.get("num_cols", 0),
            choices=[SelectionChoice.from_wire(c) for c in data.get("choices", [])],
        )


@dataclass
class CellExtAttr:
    color: Optional[int] = None
    highlight: Optional[int] = None
    char_set: Optional[int] = None

    @classmethod
    def from_wire(cls, data: Dict[str, Any]) -> "CellExtAttr":
        return cls(
            color=data.get("color"),
            highlight=data.get("highlight"),
            char_set=data.get("char_set"),
        )


@dataclass
class ScreenData:
    """Canonical representation of the terminal screen.

    Mirrors `ScreenData` in green-screen-types. All optional fields are
    populated by the proxy when the underlying protocol supports them.
    """

    content: str
    cursor_row: int
    cursor_col: int
    rows: int
    cols: int
    fields: List[Field]
    screen_signature: str
    timestamp: str
    keyboard_locked: Optional[bool] = None
    message_waiting: Optional[bool] = None
    alarm: Optional[bool] = None
    insert_mode: Optional[bool] = None
    windows: Optional[List[Window]] = None
    selection_fields: Optional[List[SelectionField]] = None
    screen_stack_depth: Optional[int] = None
    is_popup: Optional[bool] = None
    ext_attrs: Optional[Dict[int, CellExtAttr]] = None
    dbcs_cont: Optional[List[int]] = None
    code_page: Optional[str] = None

    @classmethod
    def from_wire(cls, data: Dict[str, Any]) -> "ScreenData":
        ext = None
        raw_ext = data.get("ext_attrs")
        if raw_ext:
            ext = {int(k): CellExtAttr.from_wire(v) for k, v in raw_ext.items()}
        return cls(
            content=data.get("content", ""),
            cursor_row=data.get("cursor_row", 0),
            cursor_col=data.get("cursor_col", 0),
            rows=data.get("rows", 24),
            cols=data.get("cols", 80),
            fields=[Field.from_wire(f) for f in data.get("fields", [])],
            screen_signature=data.get("screen_signature", ""),
            timestamp=data.get("timestamp", ""),
            keyboard_locked=data.get("keyboard_locked"),
            message_waiting=data.get("message_waiting"),
            alarm=data.get("alarm"),
            insert_mode=data.get("insert_mode"),
            windows=[Window.from_wire(w) for w in data["windows"]] if data.get("windows") else None,
            selection_fields=(
                [SelectionField.from_wire(s) for s in data["selection_fields"]]
                if data.get("selection_fields")
                else None
            ),
            screen_stack_depth=data.get("screen_stack_depth"),
            is_popup=data.get("is_popup"),
            ext_attrs=ext,
            dbcs_cont=data.get("dbcs_cont"),
            code_page=data.get("code_page"),
        )


@dataclass
class ConnectionStatus:
    connected: bool
    status: Literal["disconnected", "connecting", "connected", "authenticated", "error", "loading"]
    protocol: Optional[ProtocolType] = None
    host: Optional[str] = None
    username: Optional[str] = None
    error: Optional[str] = None

    @classmethod
    def from_wire(cls, data: Dict[str, Any]) -> "ConnectionStatus":
        return cls(
            connected=bool(data.get("connected", False)),
            status=data.get("status", "disconnected"),
            protocol=data.get("protocol"),
            host=data.get("host"),
            username=data.get("username"),
            error=data.get("error"),
        )


@dataclass
class ConnectConfig:
    host: str
    protocol: ProtocolType = "tn5250"
    port: Optional[int] = None
    username: Optional[str] = None
    password: Optional[str] = None
    terminal_type: Optional[str] = None
    code_page: Optional[Literal["cp37", "cp290"]] = None
    connect_timeout: Optional[int] = None

    def to_wire(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"host": self.host, "protocol": self.protocol}
        if self.port is not None:
            out["port"] = self.port
        if self.username is not None:
            out["username"] = self.username
        if self.password is not None:
            out["password"] = self.password
        if self.terminal_type is not None:
            out["terminalType"] = self.terminal_type
        if self.code_page is not None:
            out["codePage"] = self.code_page
        if self.connect_timeout is not None:
            out["connectTimeout"] = self.connect_timeout
        return out


@dataclass
class SendResult:
    """Result from a send operation. Mirrors the wire response shape."""

    success: bool
    cursor_row: Optional[int] = None
    cursor_col: Optional[int] = None
    content: Optional[str] = None
    screen_signature: Optional[str] = None
    error: Optional[str] = None

    @classmethod
    def from_wire(cls, data: Dict[str, Any]) -> "SendResult":
        return cls(
            success=bool(data.get("success", False)),
            cursor_row=data.get("cursor_row"),
            cursor_col=data.get("cursor_col"),
            content=data.get("content"),
            screen_signature=data.get("screen_signature"),
            error=data.get("error"),
        )
