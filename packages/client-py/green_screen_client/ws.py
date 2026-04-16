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
from dataclasses import dataclass, replace
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
        # Pending response resolvers — one in-flight at a time per type,
        # mirroring the TS WebSocketAdapter's pendingXResolver pattern.
        self._pending_mdt: Optional[asyncio.Future[List[FieldValue]]] = None
        self._pending_connect: Optional[asyncio.Future[SendResult]] = None
        self._pending_screen: Optional[asyncio.Future[Optional[ScreenData]]] = None
        self._pending_disconnect_ack: Optional[asyncio.Future[None]] = None

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
        """Close the WebSocket and cancel the reader task. Does NOT send
        a disconnect — the proxy-side session stays alive and can be
        re-bound later with reattach(). Use disconnect() to terminate
        the session on the proxy and host."""
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

    def dispose(self) -> None:
        """Fire-and-forget WS close (mirrors TS WebSocketAdapter.dispose).
        Does not await the close handshake; the reader loop will exit
        on its own. Session on proxy is preserved."""
        if self._ws is not None:
            try:
                asyncio.ensure_future(self._ws.close())
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
        finally:
            # Mirror TS ws.onclose — surface a disconnected status to
            # listeners so callers can react to network drops.
            self._status = ConnectionStatus(connected=False, status="disconnected")
            for cb in list(self._status_listeners):
                try:
                    cb(self._status)
                except Exception:
                    logger.exception("status listener error")

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
            self._resolve_screen(screen)
        elif msg_type == "cursor":
            # Lightweight cursor-only response for local ops (Tab, Backtab,
            # arrows, Home, End). Update cached screen's cursor AND notify
            # screen listeners so UIs re-render the cursor position.
            cursor_data = msg.get("data", {})
            cur_row = cursor_data.get("cursor_row")
            cur_col = cursor_data.get("cursor_col")
            if self._screen is not None and cur_row is not None and cur_col is not None:
                self._screen = replace(self._screen, cursor_row=cur_row, cursor_col=cur_col)
                event.screen = self._screen
                for cb in list(self._screen_listeners):
                    try:
                        cb(self._screen)
                    except Exception:
                        logger.exception("screen listener error")
            # Resolve any pending screen-wait with the cursor-updated screen.
            if self._pending_screen is not None and not self._pending_screen.done():
                self._pending_screen.set_result(self._screen)
                self._pending_screen = None
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
            if self._pending_connect is not None and not self._pending_connect.done():
                self._pending_connect.set_result(SendResult(success=True))
                self._pending_connect = None
        elif msg_type == "disconnected":
            # Server ack for disconnect() — SIGNOFF has been sent (or
            # attempted) and the proxy-side session is destroyed.
            if self._pending_disconnect_ack is not None and not self._pending_disconnect_ack.done():
                self._pending_disconnect_ack.set_result(None)
                self._pending_disconnect_ack = None
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
                self._pending_mdt = None
        elif msg_type == "error":
            err = msg.get("message")
            event.error = err
            # Flush pending resolvers with failure, matching TS behavior.
            if self._pending_connect is not None and not self._pending_connect.done():
                self._pending_connect.set_result(SendResult(success=False, error=err))
                self._pending_connect = None
            elif self._pending_screen is not None and not self._pending_screen.done():
                self._pending_screen.set_result(None)
                self._pending_screen = None

        await self._event_queue.put(event)

    def _resolve_screen(self, screen: ScreenData) -> None:
        if self._pending_screen is not None and not self._pending_screen.done():
            self._pending_screen.set_result(screen)
            self._pending_screen = None

    async def _send(self, payload: Dict[str, Any]) -> None:
        ws = await self._ensure_ws()
        await ws.send(json.dumps(payload))

    # ------------------------------------------------------------------
    # Adapter operations
    # ------------------------------------------------------------------

    async def connect(self, config: ConnectConfig, *, timeout: float = 30.0) -> SendResult:
        """Request the proxy to open a TCP connection to the host. Waits
        for the server's `connected` or `error` reply, with a 30s default
        timeout (matching the TS WebSocketAdapter)."""
        await self._ensure_ws()
        loop = asyncio.get_running_loop()
        if self._pending_connect is not None and not self._pending_connect.done():
            self._pending_connect.cancel()
        future: asyncio.Future[SendResult] = loop.create_future()
        self._pending_connect = future
        await self._send({"type": "connect", **config.to_wire()})
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending_connect = None
            return SendResult(success=False, error="Connection timeout")

    async def reattach(self, session_id: str, *, timeout: float = 10.0) -> SendResult:
        """Re-bind this WS to an existing proxy session (e.g. after process
        restart). Waits up to 10s for the server's `connected` reply."""
        self._session_id = session_id
        await self._ensure_ws()
        loop = asyncio.get_running_loop()
        if self._pending_connect is not None and not self._pending_connect.done():
            self._pending_connect.cancel()
        future: asyncio.Future[SendResult] = loop.create_future()
        self._pending_connect = future
        await self._send({"type": "reattach", "sessionId": session_id})
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending_connect = None
            return SendResult(success=False, error="Reattach timeout")

    async def send_text(self, text: str) -> SendResult:
        return await self._send_and_wait_for_screen({"type": "text", "text": text})

    async def send_key(self, key: str) -> SendResult:
        return await self._send_and_wait_for_screen({"type": "key", "key": key})

    async def set_cursor(self, row: int, col: int) -> SendResult:
        return await self._send_and_wait_for_screen({"type": "setCursor", "row": row, "col": col})

    async def disconnect(self, *, timeout: float = 3.0) -> SendResult:
        """Ask the proxy to send SIGNOFF to the host and tear down the
        session. Waits for the server's `disconnected` ack (3s hard cap)
        before closing the WS — closing earlier orphans the session on
        the proxy and, for IBM i with LMTDEVSSN=*YES, trips CPF1220 on
        the next login."""
        loop = asyncio.get_running_loop()
        future: asyncio.Future[None] = loop.create_future()
        self._pending_disconnect_ack = future
        try:
            await self._send({"type": "disconnect"})
        except Exception:
            self._pending_disconnect_ack = None
            future.cancel()

        try:
            await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            pass
        finally:
            self._pending_disconnect_ack = None

        self._status = ConnectionStatus(connected=False, status="disconnected")
        self._session_id = None
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None
        return SendResult(success=True)

    async def reconnect(self) -> SendResult:
        """Not supported on the WS adapter — use disconnect() then
        connect() instead. Returns the same failure shape as the TS
        WebSocketAdapter so callers can treat them identically."""
        return SendResult(success=False, error="Use disconnect() then connect() instead")

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
            self._pending_mdt = None
            return []

    async def mark_authenticated(self, username: str) -> None:
        await self._send({"type": "markAuthenticated", "username": username})

    async def wait_for_fields(self, min_fields: int, *, timeout_ms: int = 5000) -> None:
        await self._send({"type": "waitForFields", "minFields": min_fields, "timeoutMs": timeout_ms})

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _send_and_wait_for_screen(self, payload: Dict[str, Any], *, timeout: float = 5.0) -> SendResult:
        """Send a command and wait for the next `screen` or `cursor`
        push. Mirrors TS WebSocketAdapter.sendAndWaitForScreen — returns
        a SendResult populated with cursor_row/col/content/signature from
        the next screen update. On timeout, returns success with the
        cached screen (if any), matching TS behavior."""
        loop = asyncio.get_running_loop()
        # Flush any existing pending resolver with the current screen.
        if self._pending_screen is not None and not self._pending_screen.done():
            self._pending_screen.set_result(self._screen)
            self._pending_screen = None
        future: asyncio.Future[Optional[ScreenData]] = loop.create_future()
        self._pending_screen = future
        try:
            await self._send(payload)
        except Exception as e:
            self._pending_screen = None
            future.cancel()
            return SendResult(success=False, error=str(e))

        try:
            screen = await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending_screen = None
            return SendResult(
                success=True,
                cursor_row=self._screen.cursor_row if self._screen else None,
                cursor_col=self._screen.cursor_col if self._screen else None,
                content=self._screen.content if self._screen else None,
                screen_signature=self._screen.screen_signature if self._screen else None,
            )

        if screen is None:
            return SendResult(success=False, error="No screen data received")
        return SendResult(
            success=True,
            cursor_row=screen.cursor_row,
            cursor_col=screen.cursor_col,
            content=screen.content,
            screen_signature=screen.screen_signature,
        )
