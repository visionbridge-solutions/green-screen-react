"""ScreenBuffer-style convenience wrapper over RestClient.

Provides a synchronous-looking cached view of the current screen state
(cursor position, fields, content, signature, OIA flags) that mirrors the
attribute shape many IBM i integrations already use. Each `refresh()` or
mutating operation updates the cache from the underlying RestClient.

This module exists so that existing Python integrations that were reading
attributes like `client.screen.fields`, `client.screen.cursor_row` can
adopt green-screen-client with minimal code churn.
"""

from __future__ import annotations

import logging
from typing import List, Optional

from .rest import RestClient
from .types import ConnectConfig, ConnectionStatus, FieldValue, ScreenData, SendResult

logger = logging.getLogger(__name__)


class ScreenBuffer:
    """Mutable cache of the current screen state.

    Fields are populated from the most recent RestClient response. A fresh
    ScreenBuffer (before any operation has been performed) has empty
    strings and zero counters — callers should check `.content` or call
    `refresh()` before reading.
    """

    def __init__(self) -> None:
        self.rows: int = 24
        self.cols: int = 80
        self.cursor_row: int = 0
        self.cursor_col: int = 0
        self.content: str = ""
        self.screen_signature: str = ""
        self.fields: List[dict] = []
        self.keyboard_locked: bool = False
        self.message_waiting: bool = False
        self.alarm: bool = False
        self.insert_mode: bool = False
        self.windows: List[dict] = []
        self.selection_fields: List[dict] = []
        self.screen_stack_depth: int = 0
        self.is_popup: bool = False
        self.ext_attrs: dict = {}
        self.dbcs_cont: List[int] = []
        self.code_page: str = "cp37"

    def apply(self, screen: Optional[ScreenData]) -> None:
        if screen is None:
            return
        self.rows = screen.rows
        self.cols = screen.cols
        self.cursor_row = screen.cursor_row
        self.cursor_col = screen.cursor_col
        self.content = screen.content
        self.screen_signature = screen.screen_signature
        self.fields = [self._field_to_dict(f) for f in screen.fields]
        self.keyboard_locked = bool(screen.keyboard_locked)
        self.message_waiting = bool(screen.message_waiting)
        self.alarm = bool(screen.alarm)
        self.insert_mode = bool(screen.insert_mode)
        self.windows = [vars(w) for w in (screen.windows or [])]
        self.selection_fields = [
            {
                "row": sf.row,
                "col": sf.col,
                "num_rows": sf.num_rows,
                "num_cols": sf.num_cols,
                "choices": [vars(c) for c in sf.choices],
            }
            for sf in (screen.selection_fields or [])
        ]
        self.screen_stack_depth = screen.screen_stack_depth or 0
        self.is_popup = bool(screen.is_popup)
        self.ext_attrs = {k: vars(v) for k, v in (screen.ext_attrs or {}).items()}
        self.dbcs_cont = list(screen.dbcs_cont or [])
        self.code_page = screen.code_page or "cp37"

    @staticmethod
    def _field_to_dict(field) -> dict:  # type: ignore[no-untyped-def]
        # Reconstruct a dict shape that legacy code expects, including the
        # conventional 5250 'attr' byte (bit 0x08 = protected).
        attr = 0x28 if field.is_protected else 0x20
        if field.is_highlighted:
            attr |= 0x02
        return {
            "row": field.row,
            "col": field.col,
            "length": field.length,
            "attr": attr,
            "is_input": field.is_input,
            "is_protected": field.is_protected,
            "is_highlighted": bool(field.is_highlighted),
            "is_reverse": bool(field.is_reverse),
            "is_underscored": bool(field.is_underscored),
            "is_non_display": bool(field.is_non_display),
            "is_mandatory": False,
            "color": field.color,
            "shift_type": field.shift_type,
            "monocase": bool(field.monocase),
            "is_dbcs": bool(field.is_dbcs),
            "self_check_mod10": bool(field.self_check_mod10),
            "self_check_mod11": bool(field.self_check_mod11),
            "resequence": field.resequence,
            "progression_id": field.progression_id,
            "highlight_entry_attr": field.highlight_entry_attr,
            "modified": bool(field.modified) if field.modified is not None else False,
        }


class ProxyTerminalClient:
    """High-level drop-in replacement for legacy ProxyTN5250Client-style
    classes. Owns a RestClient + a ScreenBuffer cache and exposes the
    familiar async method shape (connect, login, send_text, send_key,
    set_cursor, get_screen, read_mdt, disconnect).

    Example (LegacyBridge migration path):

        client = ProxyTerminalClient("http://proxy:3001", host="pub400.com")
        await client.connect()
        await client.login("alice", "secret")      # uses proxy auto sign-on
        await client.send_key("PF3")
        print(client.screen.cursor_row, client.screen.cursor_col)
        await client.disconnect()
    """

    def __init__(
        self,
        proxy_url: str,
        *,
        host: str,
        port: int = 23,
        protocol: str = "tn5250",
        terminal_type: Optional[str] = None,
        timeout: float = 30.0,
    ) -> None:
        self._rest = RestClient(proxy_url, timeout=timeout)
        self._host = host
        self._port = port
        self._protocol = protocol
        self._terminal_type = terminal_type
        self.screen = ScreenBuffer()
        self._connected = False
        self._error_message: Optional[str] = None

    @property
    def is_connected(self) -> bool:
        return self._connected

    @property
    def session_id(self) -> Optional[str]:
        return self._rest.session_id

    @property
    def error_message(self) -> Optional[str]:
        return self._error_message

    async def __aenter__(self) -> "ProxyTerminalClient":
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.disconnect()

    async def connect(self) -> bool:
        result = await self._rest.connect(
            ConnectConfig(
                host=self._host,
                port=self._port,
                protocol=self._protocol,  # type: ignore[arg-type]
                terminal_type=self._terminal_type,
                connect_timeout=int(self._rest._timeout * 1000),
            )
        )
        self._connected = result.success
        self._error_message = result.error
        # Snap an initial screen if one is available
        try:
            self.screen.apply(await self._rest.get_screen())
        except Exception as e:
            logger.debug("initial get_screen after connect failed: %s", e)
        return result.success

    async def login(self, username: str, password: str) -> bool:
        """Connect with the proxy's built-in auto-sign-on (sends credentials
        in the /connect body). For multi-step IBM i post-sign-on cascades,
        prefer composing: `connect()` → type credentials → Enter → drive
        intermediate screens → `mark_authenticated(username)`."""
        result = await self._rest.connect(
            ConnectConfig(
                host=self._host,
                port=self._port,
                protocol=self._protocol,  # type: ignore[arg-type]
                terminal_type=self._terminal_type,
                username=username,
                password=password,
                connect_timeout=int(self._rest._timeout * 1000),
            )
        )
        self._connected = result.success
        self._error_message = result.error
        try:
            self.screen.apply(await self._rest.get_screen())
        except Exception:
            pass
        return result.success

    async def disconnect(self) -> None:
        try:
            await self._rest.disconnect()
        finally:
            self._connected = False
            await self._rest.close()

    async def get_screen(self) -> str:
        screen = await self._rest.get_screen()
        self.screen.apply(screen)
        return self.screen.content

    async def send_text(self, text: str) -> bool:
        result = await self._rest.send_text(text)
        if result.success:
            # Fetch the updated screen so callers see the effect
            self.screen.apply(await self._rest.get_screen())
        return result.success

    async def send_key(self, key: str) -> bool:
        result = await self._rest.send_key(key)
        if result.success:
            self.screen.apply(await self._rest.get_screen())
        return result.success

    async def send_enter(self) -> bool:
        return await self.send_key("Enter")

    async def send_tab(self) -> bool:
        return await self.send_key("Tab")

    async def set_cursor(self, row: int, col: int) -> bool:
        result = await self._rest.set_cursor(row, col)
        if result.success:
            self.screen.cursor_row = result.cursor_row or row
            self.screen.cursor_col = result.cursor_col or col
        return result.success

    async def read_mdt(self, modified_only: bool = True) -> List[FieldValue]:
        return await self._rest.read_mdt(modified_only=modified_only)

    async def mark_authenticated(self, username: str) -> bool:
        result = await self._rest.mark_authenticated(username)
        return result.success

    async def wait_for_fields(self, min_fields: int, *, timeout_ms: int = 5000) -> bool:
        return await self._rest.wait_for_fields(min_fields, timeout_ms=timeout_ms) is not None

    async def get_status(self) -> ConnectionStatus:
        return await self._rest.get_status()
