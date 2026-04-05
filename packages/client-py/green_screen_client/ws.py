"""Async WebSocket client for green-screen-proxy.

Mirrors the TypeScript `WebSocketAdapter` from `packages/react`: opens a
single WS to `{base_url}/ws`, sends commands as JSON, and receives
real-time screen pushes. Supports reattach for session recovery across
process restarts.

Typical usage:

    async with WsClient("http://proxy:3001") as client:
        await client.reattach("abc-123")
        async for event in client.events():
            if event.type == "screen":
                handle(event.screen)

Screen pushes also update `client.screen` so callers that just want the
latest state can poll it instead of consuming the event stream.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable, Dict, List, Optional

import websockets
from websockets.client import WebSocketClientProtocol

from .types import (
    ConnectConfig,
    ConnectionStatus,
    FieldValue,
    ScreenData,
    SendResult,
)

logger = logging.getLogger(__name__)


@dataclass
class WsEvent:
    """A push event from the proxy WebSocket."""

    type: str
    raw: Dict[str, Any]
    screen: Optional[ScreenData] = None
    status: Optional[ConnectionStatus] = None
    session_id: Optional[str] = None
    error: Optional[str] = None


class WsClient:
    """Async WebSocket client for green-screen-proxy.

    Base URL may be http(s) or ws(s); `/ws` is appended automatically.
    """

    def __init__(
        self,
        base_url: str,
        *,
        session_id: Optional[str] = None,
    ) -> None:
        ws_url = base_url.rstrip("/")
        ws_url = ws_url.replace("https://", "wss://").replace("http://", "ws://")
        if not ws_url.startswith(("ws://", "wss://")):
            ws_url = f"ws://{ws_url}"
        self._ws_url = f"{ws_url}/ws"
        self._session_id: Optional[str] = session_id
        self._ws: Optional[WebSocketClientProtocol] = None
        self._screen: Optional[ScreenData] = None
        self._status: ConnectionStatus = ConnectionStatus(connected=False, status="disconnected")
        self._event_queue: "asyncio.Queue[WsEvent]" = asyncio.Queue()
        self._reader_task: Optional[asyncio.Task[None]] = None
        self._screen_listeners: List[Callable[[ScreenData], None]] = []
        self._status_listeners: List[Callable[[ConnectionStatus], None]] = []
        self._session_lost_listeners: List[Callable[[str, ConnectionStatus], None]] = []
        self._session_resumed_listeners: List[Callable[[str], None]] = []
        self._pending_mdt: Optional[asyncio.Future[List[FieldValue]]] = None

    @property
    def session_id(self) -> Optional[str]:
        return self._session_id

    @property
    def screen(self) -> Optional[ScreenData]:
        return self._screen

    @property
    def status(self) -> ConnectionStatus:
        return self._status

    async def __aenter__(self) -> "WsClient":
        await self._ensure_ws()
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def close(self) -> None:
        if self._reader_task and not self._reader_task.done():
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):
                pass
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None

    # ------------------------------------------------------------------
    # Subscription hooks
    # ------------------------------------------------------------------

    def on_screen(self, callback: Callable[[ScreenData], None]) -> Callable[[], None]:
        self._screen_listeners.append(callback)
        return lambda: self._screen_listeners.remove(callback) if callback in self._screen_listeners else None  # type: ignore[func-returns-value]

    def on_status(self, callback: Callable[[ConnectionStatus], None]) -> Callable[[], None]:
        self._status_listeners.append(callback)
        return lambda: self._status_listeners.remove(callback) if callback in self._status_listeners else None  # type: ignore[func-returns-value]

    def on_session_lost(self, callback: Callable[[str, ConnectionStatus], None]) -> Callable[[], None]:
        self._session_lost_listeners.append(callback)
        return lambda: self._session_lost_listeners.remove(callback) if callback in self._session_lost_listeners else None  # type: ignore[func-returns-value]

    def on_session_resumed(self, callback: Callable[[str], None]) -> Callable[[], None]:
        self._session_resumed_listeners.append(callback)
        return lambda: self._session_resumed_listeners.remove(callback) if callback in self._session_resumed_listeners else None  # type: ignore[func-returns-value]

    async def events(self) -> AsyncIterator[WsEvent]:
        """Async iterator yielding all WS events in order."""
        while True:
            yield await self._event_queue.get()

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    async def _ensure_ws(self) -> WebSocketClientProtocol:
        if self._ws is not None and not self._ws.closed:
            return self._ws
        self._ws = await websockets.connect(self._ws_url)
        self._reader_task = asyncio.create_task(self._reader_loop())
        return self._ws

    async def _reader_loop(self) -> None:
        assert self._ws is not None
        try:
            async for raw in self._ws:
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                await self._handle_message(data)
        except Exception as e:
            logger.debug("ws reader loop terminated: %s", e)

    async def _handle_message(self, msg: Dict[str, Any]) -> None:
        msg_type = msg.get("type")
        event = WsEvent(type=msg_type or "unknown", raw=msg)

        if msg_type == "screen":
            screen = ScreenData.from_wire(msg.get("data", {}))
            self._screen = screen
            event.screen = screen
            for cb in list(self._screen_listeners):
                try:
                    cb(screen)
                except Exception:
                    logger.exception("screen listener error")
        elif msg_type == "status":
            status = ConnectionStatus.from_wire(msg.get("data", {}))
            self._status = status
            event.status = status
            for cb in list(self._status_listeners):
                try:
                    cb(status)
                except Exception:
                    logger.exception("status listener error")
        elif msg_type == "connected":
            self._session_id = msg.get("sessionId")
            event.session_id = self._session_id
        elif msg_type == "session.lost":
            sid = msg.get("sessionId")
            status = ConnectionStatus.from_wire(msg.get("status", {}))
            event.session_id = sid
            event.status = status
            for cb in list(self._session_lost_listeners):
                try:
                    if sid is not None:
                        cb(sid, status)
                except Exception:
                    logger.exception("session.lost listener error")
        elif msg_type == "session.resumed":
            sid = msg.get("sessionId")
            event.session_id = sid
            for cb in list(self._session_resumed_listeners):
                try:
                    if sid is not None:
                        cb(sid)
                except Exception:
                    logger.exception("session.resumed listener error")
        elif msg_type == "mdt":
            if self._pending_mdt is not None and not self._pending_mdt.done():
                fields = [FieldValue.from_wire(f) for f in msg.get("data", {}).get("fields", [])]
                self._pending_mdt.set_result(fields)
        elif msg_type == "error":
            event.error = msg.get("message")

        await self._event_queue.put(event)

    async def _send(self, payload: Dict[str, Any]) -> None:
        ws = await self._ensure_ws()
        await ws.send(json.dumps(payload))

    # ------------------------------------------------------------------
    # Adapter operations
    # ------------------------------------------------------------------

    async def connect(self, config: ConnectConfig) -> SendResult:
        await self._ensure_ws()
        await self._send({"type": "connect", **config.to_wire()})
        return SendResult(success=True)

    async def reattach(self, session_id: str) -> SendResult:
        """Re-bind this WS to an existing proxy session (e.g. after page
        reload). The proxy keeps the TCP connection alive; this just
        reconnects the WebSocket and receives the current screen."""
        self._session_id = session_id
        await self._ensure_ws()
        await self._send({"type": "reattach", "sessionId": session_id})
        return SendResult(success=True)

    async def send_text(self, text: str) -> None:
        await self._send({"type": "text", "text": text})

    async def send_key(self, key: str) -> None:
        await self._send({"type": "key", "key": key})

    async def set_cursor(self, row: int, col: int) -> None:
        await self._send({"type": "setCursor", "row": row, "col": col})

    async def disconnect(self) -> None:
        await self._send({"type": "disconnect"})
        self._session_id = None

    async def read_mdt(self, modified_only: bool = True, timeout: float = 5.0) -> List[FieldValue]:
        loop = asyncio.get_running_loop()
        if self._pending_mdt is not None and not self._pending_mdt.done():
            self._pending_mdt.cancel()
        future: asyncio.Future[List[FieldValue]] = loop.create_future()
        self._pending_mdt = future
        await self._send({"type": "readMdt", "modifiedOnly": modified_only})
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            return []

    async def mark_authenticated(self, username: str) -> None:
        await self._send({"type": "markAuthenticated", "username": username})

    async def wait_for_fields(self, min_fields: int, *, timeout_ms: int = 5000) -> None:
        await self._send({"type": "waitForFields", "minFields": min_fields, "timeoutMs": timeout_ms})
