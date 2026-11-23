"""``probe_session`` tells "the proxy holds no such session" from "no answer".

``resume_session`` answers None for both, so an integrator keeping a session
alive could not tell a session that is gone from a proxy that timed out — and
either dropped a live session or kept a dead one."""
import asyncio

import httpx

from green_screen_client.rest import RestClient


class _Resp:
    def __init__(self, status, body=None, raw=None):
        self.status_code = status
        self._body = body
        self.content = raw if raw is not None else (b"{}" if body is not None else b"")

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body


def _probe(answer):
    rest = RestClient.__new__(RestClient)
    rest._session_id = "mine"
    rest._base_url = "http://proxy"
    rest._headers = lambda: {}

    class _Http:
        async def request(self, method, url, *, json=None, headers=None):
            assert (method, url, json) == ("POST", "http://proxy/session/resume", {"sessionId": "other"})
            if isinstance(answer, Exception):
                raise answer
            return answer

    async def _ensure():
        return _Http()

    rest._ensure_http = _ensure
    out = asyncio.run(rest.probe_session("other"))
    assert rest._session_id == "mine", "a probe never adopts the session it asks about"
    return out


def test_a_held_session_answers_its_status():
    held, status = _probe(_Resp(200, {"success": True, "status": {"connected": True}}))
    assert held is True
    assert status.connected is True


def test_a_held_session_whose_host_connection_is_down_says_so():
    held, status = _probe(_Resp(200, {"success": True, "status": {"connected": False}}))
    assert held is True
    assert status.connected is False


def test_the_proxys_own_404_is_no_such_session():
    assert _probe(_Resp(404, {"success": False, "error": "Session not found"})) == (False, None)


def test_a_failed_request_is_no_answer():
    assert _probe(httpx.ConnectTimeout("slow")) == (None, None)


def test_a_gateway_error_is_no_answer():
    assert _probe(_Resp(502, None, raw=b"<html>bad gateway</html>")) == (None, None)


def test_a_404_with_no_json_body_is_no_answer():
    assert _probe(_Resp(404, None, raw=b"not found")) == (None, None)


def test_a_404_that_is_not_the_proxys_own_body_is_no_answer():
    assert _probe(_Resp(404, {"detail": "Not Found"})) == (None, None)
