"""Async REST client for green-screen-proxy.

Thin, typed wrapper over the proxy's HTTP endpoints. Mirrors the
TerminalAdapter contract from the TypeScript package so Python integrators
have the same shape available.

Example:

    async with RestClient("http://proxy:3001") as client:
        await client.connect(ConnectConfig(host="pub400.com", protocol="tn5250",
                                           username="alice", password="secret"))
        screen = await client.get_screen()
        await client.send_text("1")
        await client.send_key("Enter")
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

import httpx

from .types import (
    ConnectConfig,
    ConnectionStatus,
    FieldValue,
    ScreenData,
    SendResult,
)

logger = logging.getLogger(__name__)


class RestClient:
    """Async REST client for green-screen-proxy.

    Constructor takes the base URL of the proxy (no trailing slash).
    Optional `session_id` is persisted and sent as the `X-Session-Id`
    header on every request so multiple clients can coexist on one proxy.
    """

    def __init__(
        self,
        base_url: str,
        *,
        session_id: Optional[str] = None,
        timeout: float = 30.0,
        http: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._session_id: Optional[str] = session_id
        self._timeout = timeout
        self._http = http
        self._owns_http = http is None

    # ------------------------------------------------------------------
    # Session management
    # ------------------------------------------------------------------

    @property
    def session_id(self) -> Optional[str]:
        return self._session_id

    @session_id.setter
    def session_id(self, value: Optional[str]) -> None:
        self._session_id = value

    async def __aenter__(self) -> "RestClient":
        await self._ensure_http()
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def close(self) -> None:
        if self._http is not None and self._owns_http:
            await self._http.aclose()
            self._http = None

    async def _ensure_http(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=self._timeout)
        return self._http

    def _headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self._session_id:
            headers["X-Session-Id"] = self._session_id
        return headers

    def _capture_session(self, resp: httpx.Response) -> None:
        sid = resp.headers.get("X-Session-Id")
        if sid:
            self._session_id = sid

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        http = await self._ensure_http()
        try:
            resp = await http.request(
                method,
                f"{self._base_url}{path}",
                json=json,
                headers=self._headers(),
            )
        except httpx.HTTPError as e:
            logger.error("proxy %s %s failed: %s", method, path, e)
            return None
        self._capture_session(resp)
        if resp.status_code >= 400:
            logger.warning("proxy %s %s → %d: %s", method, path, resp.status_code, resp.text[:200])
            return None
        if not resp.content:
            return {}
        return resp.json()

    # ------------------------------------------------------------------
    # TerminalAdapter contract
    # ------------------------------------------------------------------

    async def connect(self, config: ConnectConfig) -> SendResult:
        data = await self._request("POST", "/connect", json=config.to_wire())
        if data is None:
            return SendResult(success=False, error="proxy connect failed")
        return SendResult.from_wire(data)

    async def disconnect(self) -> SendResult:
        data = await self._request("POST", "/disconnect") or {}
        self._session_id = None
        return SendResult.from_wire({"success": True, **data})

    async def reconnect(self) -> SendResult:
        data = await self._request("POST", "/reconnect") or {}
        return SendResult.from_wire(data)

    async def get_status(self) -> ConnectionStatus:
        data = await self._request("GET", "/status") or {}
        return ConnectionStatus.from_wire(data)

    async def get_screen(self) -> Optional[ScreenData]:
        data = await self._request("GET", "/screen")
        if not data or not data.get("content"):
            return None
        return ScreenData.from_wire(data)

    async def send_text(self, text: str) -> SendResult:
        data = await self._request("POST", "/send-text", json={"text": text}) or {"success": False}
        return SendResult.from_wire(data)

    async def send_key(self, key: str) -> SendResult:
        data = await self._request("POST", "/send-key", json={"key": key}) or {"success": False}
        return SendResult.from_wire(data)

    async def set_cursor(self, row: int, col: int) -> SendResult:
        data = await self._request("POST", "/set-cursor", json={"row": row, "col": col}) or {"success": False}
        return SendResult.from_wire(data)

    async def execute_batch(
        self,
        operations: List[Dict[str, Any]],
        *,
        read_screen: bool = True,
    ) -> Optional[Dict[str, Any]]:
        return await self._request(
            "POST",
            "/batch",
            json={"operations": operations, "readScreen": read_screen},
        )

    # ------------------------------------------------------------------
    # v1.2.0 primitives (B1 / B10 / B11)
    # ------------------------------------------------------------------

    async def read_mdt(self, modified_only: bool = True) -> List[FieldValue]:
        """Read input field values. `modified_only=True` returns only
        fields whose per-field MDT bit is set — the cheap post-write
        verification path."""
        qs = "" if modified_only else "?includeUnmodified=1"
        data = await self._request("GET", f"/read-mdt{qs}")
        if not data:
            return []
        return [FieldValue.from_wire(f) for f in data.get("fields", [])]

    async def resume_session(self, session_id: str) -> Optional[ConnectionStatus]:
        """Probe whether a session still exists on the proxy. Returns the
        current ConnectionStatus on success, None on 404."""
        self._session_id = session_id
        data = await self._request("POST", "/session/resume", json={"sessionId": session_id})
        if not data or not data.get("success"):
            return None
        return ConnectionStatus.from_wire(data.get("status", {}))

    async def mark_authenticated(self, username: str) -> SendResult:
        """Flip the session status to 'authenticated'. Call this after
        your own sign-on cascade completes; the proxy has no
        protocol-specific knowledge of what signed-on means."""
        data = await self._request(
            "POST",
            "/session/authenticated",
            json={"username": username},
        ) or {"success": False}
        return SendResult.from_wire(data)

    async def wait_for_fields(
        self,
        min_fields: int,
        *,
        timeout_ms: int = 5000,
    ) -> Optional[ScreenData]:
        """Wait until the current screen has at least `min_fields` input
        fields, or the timeout elapses. Short-circuits if the current
        screen already satisfies."""
        data = await self._request(
            "POST",
            "/wait-for-fields",
            json={"minFields": min_fields, "timeoutMs": timeout_ms},
        )
        if not data or not data.get("matched"):
            return None
        return ScreenData.from_wire(data)
