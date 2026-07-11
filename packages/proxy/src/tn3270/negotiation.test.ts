import { describe, it, expect } from 'vitest';
import { TN3270Handler } from '../protocols/tn3270-handler.js';
import { FakeHost, expectBytes, sendBytes } from '../test-utils/fake-host.js';
import { TELNET } from '../net/telnet.js';
import { TN3270E, CMD, WCC } from './constants.js';

const { IAC, SB, SE, DO, WILL, WONT, EOR } = TELNET;
const E = TELNET.OPT_TN3270E;

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

describe('TN3270 negotiation over a real socket', () => {
  it('classic RFC 1576: TTYPE + EOR + BINARY when the server has no TN3270E', async () => {
    const host = await FakeHost.start([
      sendBytes([IAC, DO, TELNET.OPT_TTYPE]),
      expectBytes([IAC, WILL, TELNET.OPT_TTYPE], 'WILL TTYPE'),
      sendBytes([IAC, SB, TELNET.OPT_TTYPE, TELNET.TTYPE_SEND, IAC, SE]),
      expectBytes(
        [IAC, SB, TELNET.OPT_TTYPE, TELNET.TTYPE_IS, ...ascii('IBM-3278-2'), IAC, SE],
        'TTYPE IS IBM-3278-2',
      ),
      sendBytes([IAC, DO, TELNET.OPT_EOR, IAC, DO, TELNET.OPT_BINARY]),
      expectBytes([IAC, WILL, TELNET.OPT_EOR, IAC, WILL, TELNET.OPT_BINARY], 'WILL EOR+BINARY'),
      // Paint a minimal screen so we can assert data flows unheadered
      sendBytes([CMD.ERASE_WRITE, WCC.KEYBOARD_RESTORE, 0xc8, 0xc9, IAC, EOR]), // 'HI'
    ]);

    const handler = new TN3270Handler();
    const screenChanged = new Promise<void>((resolve) =>
      handler.once('screenChange', () => resolve()),
    );
    await handler.connect('127.0.0.1', host.port, { tn3270e: false });
    await host.finished;
    await screenChanged;
    expect(handler.getScreenData().content).toContain('HI');
    expect(handler.connection.isTn3270e).toBe(false);
    handler.destroy();
    await host.stop();
  });

  it('refuses TN3270E with WONT when tn3270e:false', async () => {
    const host = await FakeHost.start([
      sendBytes([IAC, DO, E]),
      expectBytes([IAC, WONT, E], 'WONT TN3270E'),
    ]);
    const handler = new TN3270Handler();
    await handler.connect('127.0.0.1', host.port, { tn3270e: false });
    await host.finished;
    handler.destroy();
    await host.stop();
  });

  it('full RFC 2355: device-type REQUEST/IS, empty FUNCTIONS, 5-byte headers both ways', async () => {
    const host = await FakeHost.start([
      // Option negotiation
      sendBytes([IAC, DO, E]),
      expectBytes([IAC, WILL, E], 'WILL TN3270E'),
      // DEVICE-TYPE handshake — we request the -E variant
      sendBytes([IAC, SB, E, TN3270E.SEND, TN3270E.DEVICE_TYPE, IAC, SE]),
      expectBytes(
        [IAC, SB, E, TN3270E.DEVICE_TYPE, TN3270E.REQUEST, ...ascii('IBM-3278-2-E'), IAC, SE],
        'DEVICE-TYPE REQUEST',
      ),
      sendBytes([
        IAC, SB, E, TN3270E.DEVICE_TYPE, TN3270E.IS,
        ...ascii('IBM-3278-2-E'), TN3270E.CONNECT, ...ascii('TCP00001'),
        IAC, SE,
      ]),
      // FUNCTIONS — we propose the empty set, server agrees with IS
      expectBytes([IAC, SB, E, TN3270E.FUNCTIONS, TN3270E.REQUEST, IAC, SE], 'FUNCTIONS REQUEST []'),
      sendBytes([IAC, SB, E, TN3270E.FUNCTIONS, TN3270E.IS, IAC, SE]),
      // Headered 3270-DATA record: Erase/Write + restore + 'HI'
      sendBytes([
        TN3270E.DT_3270_DATA, 0x00, 0x00, 0x00, 0x00,
        CMD.ERASE_WRITE, WCC.KEYBOARD_RESTORE, 0xc8, 0xc9,
        IAC, EOR,
      ]),
      // Client reply to Enter must carry the outbound 5-byte header
      expectBytes([TN3270E.DT_3270_DATA, 0x00, 0x00, 0x00, 0x00, 0x7d], 'headered AID'),
    ]);

    const handler = new TN3270Handler();
    const screenChanged = new Promise<void>((resolve) =>
      handler.once('screenChange', () => resolve()),
    );
    await handler.connect('127.0.0.1', host.port);
    await screenChanged;
    expect(handler.connection.isTn3270e).toBe(true);
    expect(handler.connection.assignedLuName).toBe('TCP00001');
    expect(handler.getScreenData().content).toContain('HI');
    expect(handler.getScreenData().keyboard_locked).toBe(false);

    handler.sendKey('Enter');
    await host.finished;
    handler.destroy();
    await host.stop();
  });

  it('retries without -E when the host rejects the extended device type', async () => {
    const host = await FakeHost.start([
      sendBytes([IAC, DO, E]),
      expectBytes([IAC, WILL, E]),
      sendBytes([IAC, SB, E, TN3270E.SEND, TN3270E.DEVICE_TYPE, IAC, SE]),
      expectBytes([IAC, SB, E, TN3270E.DEVICE_TYPE, TN3270E.REQUEST, ...ascii('IBM-3278-2-E'), IAC, SE]),
      sendBytes([IAC, SB, E, TN3270E.DEVICE_TYPE, TN3270E.REJECT, TN3270E.REASON, 0x00, IAC, SE]),
      expectBytes(
        [IAC, SB, E, TN3270E.DEVICE_TYPE, TN3270E.REQUEST, ...ascii('IBM-3278-2'), IAC, SE],
        'retry without -E',
      ),
    ]);
    const handler = new TN3270Handler();
    await handler.connect('127.0.0.1', host.port);
    await host.finished;
    handler.destroy();
    await host.stop();
  });

  it('SSCP-LU data (VTAM USS screens) renders through the command-less fallback', async () => {
    const host = await FakeHost.start([
      sendBytes([IAC, DO, E]),
      expectBytes([IAC, WILL, E]),
      sendBytes([IAC, SB, E, TN3270E.SEND, TN3270E.DEVICE_TYPE, IAC, SE]),
      expectBytes([IAC, SB, E, TN3270E.DEVICE_TYPE, TN3270E.REQUEST, ...ascii('IBM-3278-2-E'), IAC, SE]),
      sendBytes([IAC, SB, E, TN3270E.DEVICE_TYPE, TN3270E.IS, ...ascii('IBM-3278-2-E'), IAC, SE]),
      expectBytes([IAC, SB, E, TN3270E.FUNCTIONS, TN3270E.REQUEST, IAC, SE]),
      sendBytes([IAC, SB, E, TN3270E.FUNCTIONS, TN3270E.IS, IAC, SE]),
      // SSCP-LU data record: raw EBCDIC text, no 3270 command byte
      sendBytes([TN3270E.DT_SSCP_LU_DATA, 0x00, 0x00, 0x00, 0x00, 0xd3, 0xd6, 0xc7, 0xd6, 0xd5, IAC, EOR]), // LOGON
    ]);
    const handler = new TN3270Handler();
    const screenChanged = new Promise<void>((resolve) =>
      handler.once('screenChange', () => resolve()),
    );
    await handler.connect('127.0.0.1', host.port);
    await screenChanged;
    expect(handler.getScreenData().content).toContain('LOGON');
    handler.destroy();
    await host.stop();
  });
});

describe('alternate screen sizes', () => {
  it('EWA switches a Model 4 to 43x80 and EW back to 24x80', async () => {
    const host = await FakeHost.start([
      sendBytes([CMD.ERASE_WRITE_ALTERNATE, WCC.KEYBOARD_RESTORE, 0xc8, IAC, EOR]),
    ]);
    const handler = new TN3270Handler();
    const screenChanged = new Promise<void>((resolve) =>
      handler.once('screenChange', () => resolve()),
    );
    await handler.connect('127.0.0.1', host.port, {
      terminalType: 'IBM-3278-4',
      tn3270e: false,
    });
    await screenChanged;
    expect(handler.getScreenData().rows).toBe(43);
    expect(handler.getScreenData().cols).toBe(80);

    // A plain Erase/Write drops back to the 24x80 default size
    handler.parser.parseRecord(Buffer.from([CMD.ERASE_WRITE, WCC.KEYBOARD_RESTORE]));
    expect(handler.screen.rows).toBe(24);
    handler.destroy();
    await host.stop();
  });
});
