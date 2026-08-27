import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as net from 'net';
import * as tls from 'tls';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { TN5250Connection } from './connection.js';

// Telnet-over-TLS (IBM i "Telnet SSL", port 992). The contract under test:
//  - tls:true completes a handshake BEFORE any telnet byte flows, and a
//    handshake failure rejects the connect — there is NO plaintext fallback;
//  - certificate verification is ON by default, a self-signed host cert is
//    rejected unless pinned via caCert or explicitly waived via tlsVerify;
//  - isTls reports ACTUAL socket state (false for plaintext, false after
//    disconnect) — this feeds the routes' `security.tls` echo that clients
//    assert to prove no plaintext leg exists.
//
// The keypair is generated at runtime (not committed — the repo's secret
// scanning rightly dislikes PEM private keys in-tree).

let tmpDir: string;
let certPem: string;

function generateSelfSignedCert(dir: string): { cert: string; key: string } {
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'pipe' });
  return { cert: fs.readFileSync(certPath, 'utf8'), key: fs.readFileSync(keyPath, 'utf8') };
}

let tlsServer: tls.Server | null = null;
let netServer: net.Server | null = null;
const conns: TN5250Connection[] = [];

function listen(server: tls.Server | net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

function newConn(): TN5250Connection {
  const conn = new TN5250Connection();
  // Socket errors after connect are expected noise in the failure cases.
  conn.on('error', () => {});
  conns.push(conn);
  return conn;
}

let tlsPort = 0;
let netPort = 0;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-tls-test-'));
  const pair = generateSelfSignedCert(tmpDir);
  certPem = pair.cert;
  tlsServer = tls.createServer({ cert: pair.cert, key: pair.key });
  netServer = net.createServer();
  tlsPort = await listen(tlsServer);
  netPort = await listen(netServer);
});

afterEach(() => {
  for (const c of conns.splice(0)) c.disconnect();
});

afterAll(() => {
  tlsServer?.close();
  netServer?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('TN5250Connection — telnet-over-TLS', () => {
  it('connects with TLS when the host cert is pinned via caCert (verify on)', async () => {
    const port = tlsPort;
    const conn = newConn();
    await conn.connect('localhost', port, { tls: true, caCert: certPem });
    expect(conn.isConnected).toBe(true);
    expect(conn.isTls).toBe(true);
  });

  it('rejects a self-signed host cert when verification is on and no CA is pinned', async () => {
    const port = tlsPort;
    const conn = newConn();
    await expect(
      conn.connect('localhost', port, { tls: true }),
    ).rejects.toThrow(/self[- ]signed|unable to verify|certificate/i);
    expect(conn.isConnected).toBe(false);
    expect(conn.isTls).toBe(false);
  });

  it('connects to a self-signed host with tlsVerify:false (encrypted, unverified)', async () => {
    const port = tlsPort;
    const conn = newConn();
    await conn.connect('localhost', port, { tls: true, tlsVerify: false });
    expect(conn.isConnected).toBe(true);
    expect(conn.isTls).toBe(true);
  });

  it('fails closed against a plaintext listener — never falls back to plaintext', async () => {
    const port = netPort;
    const conn = newConn();
    await expect(
      conn.connect('localhost', port, { tls: true, tlsVerify: false, connectTimeout: 1000 }),
    ).rejects.toThrow();
    expect(conn.isConnected).toBe(false);
    expect(conn.isTls).toBe(false);
  });

  it('plaintext mode still works and reports isTls false', async () => {
    const port = netPort;
    const conn = newConn();
    await conn.connect('localhost', port, {});
    expect(conn.isConnected).toBe(true);
    expect(conn.isTls).toBe(false);
  });

  it('isTls drops back to false after disconnect', async () => {
    const port = tlsPort;
    const conn = newConn();
    await conn.connect('localhost', port, { tls: true, caCert: certPem });
    expect(conn.isTls).toBe(true);
    conn.disconnect();
    expect(conn.isTls).toBe(false);
  });
});
