# green-screen-client

Python client for [`green-screen-proxy`](https://github.com/legacybridge-software/green-screen-react/tree/main/packages/proxy) — typed async REST + WebSocket adapter for TN5250, TN3270, VT, and HP 6530 terminal emulation.

This is a **standalone package**. It is not bundled with or required by `green-screen-react` — install it separately when your integration runs on Python.

## Install

```bash
pip install green-screen-client
```

## Three layers, pick what fits

### 1. Low-level REST (`RestClient`)

Thin wrapper over the proxy's HTTP endpoints. One method per endpoint, dataclasses in/out.

```python
from green_screen_client import RestClient, ConnectConfig

async with RestClient("http://proxy:3001") as client:
    await client.connect(ConnectConfig(
        host="pub400.com",
        protocol="tn5250",
        username="alice",
        password="secret",
    ))
    screen = await client.get_screen()
    print(screen.content)
    await client.send_text("1")
    await client.send_key("Enter")
```

### 2. Low-level WebSocket (`WsClient`)

Single WebSocket, real-time screen pushes, reattach for session recovery, lifecycle events (`session.lost`, `session.resumed`).

```python
from green_screen_client import WsClient

async with WsClient("http://proxy:3001") as client:
    await client.reattach("abc-123")   # reattach after page reload / process restart
    client.on_screen(lambda s: print("screen update:", s.cursor_row, s.cursor_col))
    client.on_session_lost(lambda sid, status: print("lost:", sid, status.status))
    async for event in client.events():
        if event.type == "screen":
            ...
```

### 3. High-level `ProxyTerminalClient` + `ScreenBuffer`

Drop-in shape for integrations that already read `client.screen.fields`, `client.screen.cursor_row`, etc.

```python
from green_screen_client import ProxyTerminalClient

async with ProxyTerminalClient("http://proxy:3001", host="pub400.com") as client:
    await client.login("alice", "secret")
    await client.send_key("PF3")
    print(client.screen.cursor_row, client.screen.cursor_col)
    for field in client.screen.fields:
        print(field)
```

## v1.2.0 primitives

- `read_mdt(modified_only=True)` — cheap post-write verification via per-field MDT bits.
- `resume_session(session_id)` — REST probe for "is this session still alive?"
- `mark_authenticated(username)` — flip session status after your own sign-on cascade (the proxy stays protocol-generic).
- `wait_for_fields(min_fields, timeout_ms=...)` — wait until a form with N input fields appears.

## License

MIT.
