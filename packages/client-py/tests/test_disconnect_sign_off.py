"""``disconnect(sign_off=False)`` asks the proxy to close WITHOUT typing.

The graceful exit types SIGNOFF + Enter into whatever screen is up — a submit
of that screen when it is not a menu — so an integrator that cannot prove its
session stands at one asks for the bare close (``{"signOff": false}``)."""
import asyncio

from green_screen_client.buffer import ProxyTerminalClient, ScreenBuffer
from green_screen_client.rest import RestClient


def _rest(calls):
    rest = RestClient.__new__(RestClient)
    rest._session_id = "s1"

    async def _request(method, path, *, json=None):
        calls.append((method, path, json))
        return {"success": True}

    rest._request = _request
    return rest


def test_a_bare_close_sends_sign_off_false():
    calls = []
    asyncio.run(_rest(calls).disconnect(sign_off=False))
    assert calls == [("POST", "/disconnect", {"signOff": False})]


def test_a_plain_disconnect_still_signs_off():
    calls = []
    asyncio.run(_rest(calls).disconnect())
    assert calls == [("POST", "/disconnect", None)]


def test_the_terminal_client_passes_it_through():
    calls = []
    client = ProxyTerminalClient.__new__(ProxyTerminalClient)
    client.screen = ScreenBuffer()
    client._rest = _rest(calls)

    async def _close():
        return None

    client._rest.close = _close
    client._connected = True
    asyncio.run(client.disconnect(sign_off=False))
    assert calls == [("POST", "/disconnect", {"signOff": False})]
    assert client._connected is False
