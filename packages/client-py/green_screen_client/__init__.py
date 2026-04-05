"""green-screen-client — Python client for green-screen-proxy.

Typed async REST + WebSocket adapter that mirrors the wire format of
`green-screen-types` and the adapter contract of `green-screen-react`.

Three layers, pick the one that matches your integration style:

1. `RestClient` — low-level async REST wrapper. One method per HTTP
   endpoint; raw dataclasses in/out; bring your own session management.

2. `WsClient` — low-level async WebSocket wrapper. Single WS, real-time
   `onScreen`/`onStatus`/`onSessionLost` callbacks plus an async event
   iterator.

3. `ProxyTerminalClient` + `ScreenBuffer` — high-level drop-in for
   integrations that already have code reading `client.screen.fields`,
   `client.screen.cursor_row`, etc. Owns the REST client and maintains
   an up-to-date buffer cache on every operation.

Published separately from `green-screen-react` — install via PyPI:

    pip install green-screen-client
"""

from .buffer import ProxyTerminalClient, ScreenBuffer
from .rest import RestClient
from .types import (
    CellExtAttr,
    ConnectConfig,
    ConnectionStatus,
    Field,
    FieldColor,
    FieldValue,
    ProtocolType,
    ScreenData,
    SelectionChoice,
    SelectionField,
    SendResult,
    ShiftType,
    Window,
)
from .ws import WsClient, WsEvent

__version__ = "1.2.0"

__all__ = [
    # Clients
    "RestClient",
    "WsClient",
    "WsEvent",
    "ProxyTerminalClient",
    "ScreenBuffer",
    # Types
    "CellExtAttr",
    "ConnectConfig",
    "ConnectionStatus",
    "Field",
    "FieldColor",
    "FieldValue",
    "ProtocolType",
    "ScreenData",
    "SelectionChoice",
    "SelectionField",
    "SendResult",
    "ShiftType",
    "Window",
]
