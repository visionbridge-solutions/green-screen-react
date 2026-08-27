"""TLS fail-closed contract of the REST client.

A TLS-required connect must never reach a proxy that could silently open a
plaintext socket: (a) the client probes /status capabilities BEFORE sending
/connect (the connect body carries credentials), and (b) it asserts the
response's ``security.tls`` echo, which the proxy reads from actual socket
state. Both failures are hard errors, never a degrade.
"""

import asyncio
import json
from typing import Any, Dict, Optional

from green_screen_client.rest import RestClient
from green_screen_client.types import ConnectConfig


class _FakeResponse:
    def __init__(self, payload: Dict[str, Any], status_code: int = 200):
        self._payload = payload
        self.status_code = status_code
        self.headers: Dict[str, str] = {}
        self.content = json.dumps(payload).encode()
        self.text = json.dumps(payload)

    def json(self) -> Dict[str, Any]:
        return self._payload


class _FakeHttp:
    """Stands in for httpx.AsyncClient — records requests, serves canned responses."""

    def __init__(self, status_payload: Dict[str, Any], connect_payload: Optional[Dict[str, Any]] = None):
        self.status_payload = status_payload
        self.connect_payload = connect_payload or {"success": True}
        self.requests: list = []

    async def request(self, method: str, url: str, **kwargs: Any) -> _FakeResponse:
        self.requests.append((method, url, kwargs.get("json")))
        if url.endswith("/status"):
            return _FakeResponse(self.status_payload)
        if url.endswith("/connect"):
            return _FakeResponse(self.connect_payload)
        if url.endswith("/disconnect"):
            return _FakeResponse({"success": True})
        return _FakeResponse({}, status_code=404)


def _client(fake: _FakeHttp) -> RestClient:
    return RestClient("http://proxy:3001", http=fake)  # type: ignore[arg-type]


def test_tls_connect_refused_when_proxy_lacks_capability():
    fake = _FakeHttp(status_payload={"ok": True, "sessions": 0})  # old proxy: no capabilities
    client = _client(fake)
    result = asyncio.run(client.connect(ConnectConfig(host="h", tls=True)))
    assert result.success is False
    assert "tls" in (result.error or "").lower()
    # The credentials-bearing /connect must never have been sent.
    assert not any(url.endswith("/connect") for _, url, _ in fake.requests)


def test_tls_connect_succeeds_with_capability_and_true_echo():
    fake = _FakeHttp(
        status_payload={"ok": True, "sessions": 0, "capabilities": ["tls"]},
        connect_payload={"success": True, "security": {"tls": True}},
    )
    client = _client(fake)
    result = asyncio.run(client.connect(ConnectConfig(host="h", tls=True, ca_cert="PEM")))
    assert result.success is True
    wire = next(body for _, url, body in fake.requests if url.endswith("/connect"))
    assert wire["tls"] is True and wire["caCert"] == "PEM"


def test_tls_connect_rejected_when_security_echo_missing():
    # A middle layer swallowed the option: connect "succeeds" but the socket
    # is not TLS. The client must disconnect and fail.
    fake = _FakeHttp(
        status_payload={"ok": True, "sessions": 0, "capabilities": ["tls"]},
        connect_payload={"success": True},  # no security field
    )
    client = _client(fake)
    result = asyncio.run(client.connect(ConnectConfig(host="h", tls=True)))
    assert result.success is False
    assert any(url.endswith("/disconnect") for _, url, _ in fake.requests)


def test_capability_probe_reads_per_session_status_shape():
    # With one live session, a bare /status resolves the default session —
    # capabilities must still be honoured from that shape.
    fake = _FakeHttp(
        status_payload={"connected": True, "status": "connected", "capabilities": ["tls"]},
        connect_payload={"success": True, "security": {"tls": True}},
    )
    client = _client(fake)
    result = asyncio.run(client.connect(ConnectConfig(host="h", tls=True)))
    assert result.success is True


def test_plaintext_connect_skips_probe_and_sends_no_tls_fields():
    fake = _FakeHttp(status_payload={"ok": True, "sessions": 0})
    client = _client(fake)
    result = asyncio.run(client.connect(ConnectConfig(host="h")))
    assert result.success is True
    assert not any(url.endswith("/status") for _, url, _ in fake.requests)
    wire = next(body for _, url, body in fake.requests if url.endswith("/connect"))
    assert "tls" not in wire and "tlsVerify" not in wire and "caCert" not in wire


def test_to_wire_tls_fields():
    cfg = ConnectConfig(host="h", tls=True, tls_verify=False, ca_cert="PEM")
    wire = cfg.to_wire()
    assert wire["tls"] is True
    assert wire["tlsVerify"] is False
    assert wire["caCert"] == "PEM"
