import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { FakeHost, expectBytes, sendBytes, closeConnection } from './fake-host.js';

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => resolve(socket));
    socket.once('error', reject);
  });
}

describe('FakeHost', () => {
  it('walks a send/expect script against a real socket', async () => {
    const host = await FakeHost.start([
      sendBytes([0x01, 0x02]),
      expectBytes([0xaa, 0xbb], 'client-hello'),
      sendBytes([0x03]),
      closeConnection(),
    ]);
    const socket = await connect(host.port);
    const got: Buffer[] = [];
    socket.on('data', (c) => got.push(c));
    const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
    socket.write(Buffer.from([0xaa, 0xbb]));
    await host.finished;
    await closed;
    expect(Buffer.concat(got)).toEqual(Buffer.from([0x01, 0x02, 0x03]));
    await host.stop();
  });

  it('rejects on the first mismatching byte with offset detail', async () => {
    const host = await FakeHost.start([expectBytes([0x10, 0x20], 'greeting')], {
      timeoutMs: 2000,
    });
    const socket = await connect(host.port);
    socket.write(Buffer.from([0x10, 0x99]));
    await expect(host.finished).rejects.toThrow(/offset 1: expected 0x20, got 0x99/);
    socket.destroy();
    await host.stop();
  });

  it('times out with the pending expectation in the error', async () => {
    const host = await FakeHost.start([expectBytes([0x01], 'never-sent')], { timeoutMs: 200 });
    const socket = await connect(host.port);
    await expect(host.finished).rejects.toThrow(/never-sent/);
    socket.destroy();
    await host.stop();
  });
});
