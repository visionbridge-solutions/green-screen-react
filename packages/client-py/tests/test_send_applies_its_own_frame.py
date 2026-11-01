"""A send applies the frame its own round trip returned; ``animate`` reaches the wire.

``/send-text``, ``/send-key`` and ``/batch`` answer ``{success, ...screenData}``
— the screen as it stood after the keystroke. The client used to follow every
successful send with a second ``GET /screen`` for the same instant: one more
hop per keystroke (25 a document on the 2026-10-30 batch). Now the result
carries the parsed frame and the buffer applies it; only a response with no
frame is followed by a read.

``animate=False`` (send_text, execute_batch) is the proxy's knob for typing
in one burst with no per-keystroke frames — an automated driver's typing;
the default stays animated for a person's own.
"""
import asyncio
from typing import Any, Dict, Optional

from green_screen_client.buffer import ProxyTerminalClient, ScreenBuffer
from green_screen_client.rest import RestClient
from green_screen_client.types import SendResult


def _frame(content: str, **overrides: Any) -> Dict[str, Any]:
    base = {
        "success": True,
        "content": content,
        "cursor_row": 7,
        "cursor_col": 9,
        "rows": 24,
        "cols": 80,
        "fields": [],
        "screen_signature": f"sig-{content}",
        "timestamp": "2026-01-01T00:00:00Z",
    }
    base.update(overrides)
    return base


# --- the wire ----------------------------------------------------------------

class _FakeResponse:
    def __init__(self, payload: Dict[str, Any], status_code: int = 200):
        self._payload = payload
        self.status_code = status_code
        self.headers: Dict[str, str] = {}
        self.content = b"x"
        self.text = ""

    def json(self) -> Dict[str, Any]:
        return self._payload


class _FakeHttp:
    """Stands in for httpx.AsyncClient — records requests, serves canned responses."""

    def __init__(self, responses: Dict[str, Dict[str, Any]]):
        self.responses = responses
        self.requests: list = []

    async def request(self, method: str, url: str, **kwargs: Any) -> _FakeResponse:
        path = url.rsplit("/", 1)[-1]
        self.requests.append((method, path, kwargs.get("json")))
        payload = self.responses.get(path)
        if payload is None:
            return _FakeResponse({}, status_code=404)
        return _FakeResponse(payload)


def _rest(responses: Dict[str, Dict[str, Any]]) -> "tuple[RestClient, _FakeHttp]":
    fake = _FakeHttp(responses)
    return RestClient("http://proxy:3001", http=fake), fake  # type: ignore[arg-type]


def test_a_send_result_carries_the_frame_the_proxy_returned():
    result = SendResult.from_wire(_frame("AFTER"))
    assert result.success is True
    assert result.screen is not None
    assert result.screen.content == "AFTER"
    assert (result.screen.cursor_row, result.screen.cursor_col) == (7, 9)


def test_a_result_with_no_frame_carries_none():
    assert SendResult.from_wire({"success": True}).screen is None
    assert SendResult.from_wire({"success": False, "error": "nope"}).screen is None


def test_send_text_puts_animate_on_the_wire_and_animates_by_default():
    client, fake = _rest({"send-text": _frame("X")})
    asyncio.run(client.send_text("abc"))
    asyncio.run(client.send_text("abc", animate=False))
    assert fake.requests == [
        ("POST", "send-text", {"text": "abc", "animate": True}),
        ("POST", "send-text", {"text": "abc", "animate": False}),
    ]


def test_execute_batch_puts_animate_on_the_wire_and_animates_by_default():
    client, fake = _rest({"batch": _frame("X")})
    ops = [{"type": "text", "value": "abc"}]
    asyncio.run(client.execute_batch(ops))
    asyncio.run(client.execute_batch(ops, animate=False))
    assert fake.requests == [
        ("POST", "batch", {"operations": ops, "readScreen": True, "animate": True}),
        ("POST", "batch", {"operations": ops, "readScreen": True, "animate": False}),
    ]


# --- the buffer ----------------------------------------------------------------

class _RecordingRest:
    """The REST layer as the buffer sees it: records every call, serves a
    canned result per send and a canned frame per read."""

    def __init__(self, send: SendResult, read: Optional[Dict[str, Any]] = None):
        self._send = send
        self._read = read
        self.calls: list = []

    async def send_text(self, text: str, *, animate: bool = True) -> SendResult:
        self.calls.append(("send_text", text, animate))
        return self._send

    async def send_key(self, key: str) -> SendResult:
        self.calls.append(("send_key", key))
        return self._send

    async def get_screen(self):
        self.calls.append(("get_screen",))
        from green_screen_client.types import ScreenData

        return ScreenData.from_wire(self._read) if self._read else None


def _client(rest: _RecordingRest) -> ProxyTerminalClient:
    client = ProxyTerminalClient.__new__(ProxyTerminalClient)
    client.screen = ScreenBuffer()
    client._rest = rest
    return client


def test_send_text_is_one_round_trip_and_the_buffer_shows_its_frame():
    rest = _RecordingRest(SendResult.from_wire(_frame("TYPED")))
    client = _client(rest)
    assert asyncio.run(client.send_text("abc", animate=False)) is True
    assert rest.calls == [("send_text", "abc", False)]
    assert client.screen.content == "TYPED"
    assert (client.screen.cursor_row, client.screen.cursor_col) == (7, 9)
    assert client.screen.screen_signature == "sig-TYPED"


def test_send_key_is_one_round_trip_and_the_buffer_shows_its_frame():
    rest = _RecordingRest(SendResult.from_wire(_frame("AFTER ENTER")))
    client = _client(rest)
    assert asyncio.run(client.send_key("Enter")) is True
    assert rest.calls == [("send_key", "Enter")]
    assert client.screen.content == "AFTER ENTER"


def test_the_buffers_send_text_animates_by_default():
    rest = _RecordingRest(SendResult.from_wire(_frame("X")))
    asyncio.run(_client(rest).send_text("abc"))
    assert rest.calls == [("send_text", "abc", True)]


def test_a_response_without_a_frame_is_followed_by_one_read():
    rest = _RecordingRest(SendResult.from_wire({"success": True}), read=_frame("READ BACK"))
    client = _client(rest)
    assert asyncio.run(client.send_key("F3")) is True
    assert rest.calls == [("send_key", "F3"), ("get_screen",)]
    assert client.screen.content == "READ BACK"


def test_a_refused_send_reads_nothing_and_leaves_the_buffer():
    rest = _RecordingRest(SendResult.from_wire({"success": False, "error": "Cannot type at current cursor position"}))
    client = _client(rest)
    client.screen.content = "BEFORE"
    assert asyncio.run(client.send_text("abc")) is False
    assert rest.calls == [("send_text", "abc", True)]
    assert client.screen.content == "BEFORE"
