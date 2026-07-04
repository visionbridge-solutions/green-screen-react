import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  checkBearer,
  authEnabled,
  isPrivateIp,
  validateEgressTarget,
  assertResolvedAllowed,
  corsOrigins,
  bindAddress,
  getEgressPolicy,
} from './security.js';

// The proxy's security controls are all opt-in via env. These tests pin both
// the "disabled ⇒ legacy open behaviour" default AND the "enabled ⇒ enforced"
// behaviour, so a regression that silently disables auth/SSRF is caught.

const SAVED = { ...process.env };
function resetEnv() {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('GS_PROXY_')) delete process.env[k];
  }
}
beforeEach(resetEnv);
afterEach(() => {
  resetEnv();
  Object.assign(process.env, SAVED);
});

describe('bearer auth (GS_PROXY_AUTH_TOKEN)', () => {
  it('is disabled by default and allows any request', () => {
    expect(authEnabled()).toBe(false);
    expect(checkBearer(undefined)).toBe(true);
    expect(checkBearer('Bearer whatever')).toBe(true);
  });

  it('enforces the token when set', () => {
    process.env.GS_PROXY_AUTH_TOKEN = 's3cret-token';
    expect(authEnabled()).toBe(true);
    expect(checkBearer('Bearer s3cret-token')).toBe(true);
    expect(checkBearer('Bearer wrong')).toBe(false);
    expect(checkBearer('s3cret-token')).toBe(false); // missing "Bearer "
    expect(checkBearer(undefined)).toBe(false);
    expect(checkBearer('')).toBe(false);
  });

  it('is case-insensitive on the scheme and tolerant of extra whitespace', () => {
    process.env.GS_PROXY_AUTH_TOKEN = 'abc';
    expect(checkBearer('bearer abc')).toBe(true);
    expect(checkBearer('  Bearer   abc  ')).toBe(true);
  });

  it('rejects a token that is a prefix/suffix of the real one (length guard)', () => {
    process.env.GS_PROXY_AUTH_TOKEN = 'abcdef';
    expect(checkBearer('Bearer abc')).toBe(false);
    expect(checkBearer('Bearer abcdefg')).toBe(false);
  });
});

describe('isPrivateIp', () => {
  it('flags loopback, RFC-1918, link-local/metadata, CGNAT, ULA', () => {
    for (const ip of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255',
      '192.168.1.25', '169.254.169.254', '100.90.155.50', '0.0.0.0',
      '::1', 'fe80::1', 'fd00::1',
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
  it('does not flag public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.5', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
});

describe('validateEgressTarget', () => {
  it('always enforces host/port shape even with all controls off', () => {
    expect(validateEgressTarget('', 23).ok).toBe(false);
    expect(validateEgressTarget('host', 0).ok).toBe(false);
    expect(validateEgressTarget('host', 70000).ok).toBe(false);
    expect(validateEgressTarget('host', 23.5).ok).toBe(false);
    expect(validateEgressTarget('host', '23' as unknown).ok).toBe(false);
    expect(validateEgressTarget('pub400.com', 23).ok).toBe(true);
  });

  it('does NOT block private ranges by default (legacy LAN-friendly behaviour)', () => {
    expect(validateEgressTarget('10.1.2.3', 23).ok).toBe(true);
  });

  it('blocks private ranges when GS_PROXY_BLOCK_PRIVATE is on', () => {
    process.env.GS_PROXY_BLOCK_PRIVATE = '1';
    expect(validateEgressTarget('10.1.2.3', 23).ok).toBe(false);
    expect(validateEgressTarget('169.254.169.254', 80).ok).toBe(false);
    expect(validateEgressTarget('8.8.8.8', 23).ok).toBe(true); // public still ok
    // a hostname (non-literal) passes here; resolved IP is re-checked separately
    expect(validateEgressTarget('pub400.com', 23).ok).toBe(true);
  });

  it('restricts to an allowlist when set, and an allowlist entry overrides block-private', () => {
    process.env.GS_PROXY_BLOCK_PRIVATE = '1';
    process.env.GS_PROXY_HOST_ALLOWLIST = 'ibmi.internal:23, 10.1.2.3';
    expect(validateEgressTarget('ibmi.internal', 23).ok).toBe(true);
    expect(validateEgressTarget('ibmi.internal', 24).ok).toBe(false); // wrong port
    expect(validateEgressTarget('10.1.2.3', 999).ok).toBe(true);      // host-only entry, any port
    expect(validateEgressTarget('evil.com', 23).ok).toBe(false);      // not listed
  });

  it('re-checks a resolved address for DNS rebinding when block-private is on', () => {
    process.env.GS_PROXY_BLOCK_PRIVATE = '1';
    const policy = getEgressPolicy();
    expect(assertResolvedAllowed('8.8.8.8', policy).ok).toBe(true);
    expect(assertResolvedAllowed('169.254.169.254', policy).ok).toBe(false);
  });
});

describe('CORS + bind config', () => {
  it('emits NO CORS headers by default (null)', () => {
    expect(corsOrigins()).toBeNull();
  });
  it('supports explicit wildcard and an origin list', () => {
    process.env.GS_PROXY_CORS_ORIGINS = '*';
    expect(corsOrigins()).toBe('*');
    process.env.GS_PROXY_CORS_ORIGINS = 'https://a.com, https://b.com';
    expect(corsOrigins()).toEqual(['https://a.com', 'https://b.com']);
  });
  it('defaults bind to 0.0.0.0 and honours the override', () => {
    expect(bindAddress()).toBe('0.0.0.0');
    process.env.GS_PROXY_BIND = '127.0.0.1';
    expect(bindAddress()).toBe('127.0.0.1');
  });
});
