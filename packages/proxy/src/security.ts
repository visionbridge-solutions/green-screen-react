/**
 * Opt-in security controls for the proxy — auth, egress (SSRF) validation, CORS.
 *
 * The proxy is a protocol-generic bridge that opens raw TCP to a caller-supplied
 * host:port and, once a session is live, will drive/read that session for anyone
 * who can reach it. That is acceptable ONLY when the listener is unreachable to
 * untrusted parties. These controls are the defense-in-depth for when it isn't
 * (a shared network, a published port, a flat VPN). They are **all opt-in via
 * env** so the default developer experience is unchanged; an integrator that
 * exposes the proxy beyond localhost should turn them on.
 *
 *   GS_PROXY_AUTH_TOKEN     — when set, every REST route and WS upgrade must
 *                             present `Authorization: Bearer <token>` (constant-
 *                             time compared). Unset ⇒ anonymous (legacy default).
 *   GS_PROXY_BLOCK_PRIVATE  — "1"/"true" ⇒ reject connect targets that resolve to
 *                             loopback / link-local / RFC-1918 / ULA / cloud
 *                             metadata (169.254.169.254). Off by default (a dev
 *                             proxy legitimately connects to a LAN host).
 *   GS_PROXY_HOST_ALLOWLIST — comma-separated host:port (or host, any port)
 *                             allowlist. When set, a connect target not on it is
 *                             rejected. Takes precedence as an explicit allow.
 *   GS_PROXY_CORS_ORIGINS   — comma-separated allowed origins. Unset ⇒ NO CORS
 *                             headers (same-origin only); "*" ⇒ explicit wildcard
 *                             (opt in, not the default).
 *   GS_PROXY_BIND           — listen interface (default 0.0.0.0). Integrators on
 *                             a shared host set 127.0.0.1.
 *
 * This module is pure config + validators (no Express/ws imports) so it is unit-
 * testable in isolation and safe to import anywhere.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { isIP } from 'net';

function envList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function envBool(name: string): boolean {
  const v = (process.env[name] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** The bearer token gate, or null when auth is disabled (no token configured). */
export function getAuthToken(): string | null {
  const t = (process.env.GS_PROXY_AUTH_TOKEN || '').trim();
  return t.length > 0 ? t : null;
}

export function authEnabled(): boolean {
  return getAuthToken() !== null;
}

/** Constant-time compare of two same-purpose strings, length-safe. */
function constantTimeEquals(a: string, b: string): boolean {
  const pa = Buffer.from(a);
  const pb = Buffer.from(b);
  if (pa.length !== pb.length) {
    // Spend a compare on a same-length dummy so length isn't a timing oracle.
    timingSafeEqual(pb, pb);
    return false;
  }
  return timingSafeEqual(pa, pb);
}

function bearerValue(authorization: string | undefined | null): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return m ? m[1] : null;
}

/** Constant-time bearer check. Returns true when auth is disabled (open) or the
 *  presented token matches the base token. `authorization` is the raw header
 *  value. Scoped tokens (see {@link resolveAuth}) are NOT accepted here — this
 *  remains the base-token-only primitive. */
export function checkBearer(authorization: string | undefined | null): boolean {
  const expected = getAuthToken();
  if (expected === null) return true; // auth disabled ⇒ allow
  const presented = bearerValue(authorization);
  if (presented === null) return false;
  return constantTimeEquals(presented, expected);
}

/**
 * A caller's authenticated **scope** — an opaque tenant label the proxy uses to
 * keep one caller's sessions invisible and untouchable to another. The proxy
 * never interprets it (it is not "org id" here — that meaning lives in the
 * integrator); it only compares it against the scope a session was created
 * under.
 *
 * A scoped token is ``<scope>.<hmac>`` where ``hmac`` is
 * ``HMAC-SHA256(base-token, scope)`` in lowercase hex. The base token is the
 * unscoped/all-access credential (the integrator's control plane); a scoped
 * token proves the holder was issued exactly that scope by someone who knows
 * the base secret, WITHOUT the holder ever learning the base secret — so a
 * per-tenant worker handed only its own scoped token cannot forge another
 * tenant's. Keep this protocol-generic: mint scoped tokens per tenant in the
 * integrator, hand each worker only its own.
 */
export function mintScopedToken(scope: string, baseToken?: string | null): string {
  const base = baseToken ?? getAuthToken();
  if (!base) throw new Error('mintScopedToken requires an auth token (GS_PROXY_AUTH_TOKEN)');
  const sig = createHmac('sha256', base).update(scope, 'utf8').digest('hex');
  return `${scope}.${sig}`;
}

export interface AuthResult {
  /** Whether the presented credential is accepted at all. */
  ok: boolean;
  /** The caller's scope: ``null`` means unscoped/all-access (the base token, or
   *  auth disabled) — such a caller may see and drive any session. A non-null
   *  scope confines the caller to sessions created under the same scope. */
  scope: string | null;
}

/**
 * Resolve a request's authorization into an {@link AuthResult}. Accepts, in
 * order: auth-disabled (open, unscoped); the exact base token (unscoped); a
 * valid ``<scope>.<hmac>`` scoped token (confined to that scope). Anything else
 * is rejected. All comparisons are constant-time.
 */
export function resolveAuth(authorization: string | undefined | null): AuthResult {
  const base = getAuthToken();
  if (base === null) return { ok: true, scope: null }; // auth disabled ⇒ open
  const presented = bearerValue(authorization);
  if (presented === null) return { ok: false, scope: null };
  if (constantTimeEquals(presented, base)) return { ok: true, scope: null };
  // Scoped token: split on the LAST dot so a scope containing dots still works.
  const dot = presented.lastIndexOf('.');
  if (dot > 0) {
    const scope = presented.slice(0, dot);
    const sig = presented.slice(dot + 1);
    const expectedSig = createHmac('sha256', base).update(scope, 'utf8').digest('hex');
    if (constantTimeEquals(sig, expectedSig)) return { ok: true, scope };
  }
  return { ok: false, scope: null };
}

/** Listen interface for the HTTP/WS server. */
export function bindAddress(): string {
  return (process.env.GS_PROXY_BIND || '0.0.0.0').trim() || '0.0.0.0';
}

/** Allowed CORS origins, or null to emit NO CORS headers (same-origin only). */
export function corsOrigins(): string[] | '*' | null {
  const list = envList('GS_PROXY_CORS_ORIGINS');
  if (list.length === 0) return null;
  if (list.includes('*')) return '*';
  return list;
}

// ── Egress (SSRF) validation ──────────────────────────────────────────────

const METADATA_IPS = new Set(['169.254.169.254', 'fd00:ec2::254']);

/** True if `ip` is a literal in a range we treat as internal/unsafe. */
export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const p = ip.split('.').map((n) => parseInt(n, 10));
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
    const [a, b] = p;
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 127) return true;                      // loopback
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;         // 192.168.0.0/16
    if (a === 169 && b === 254) return true;         // link-local + metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10 (tailnet)
    if (a === 0) return true;                         // 0.0.0.0/8
    return false;
  }
  if (kind === 6) {
    const s = ip.toLowerCase();
    if (s === '::1') return true;                    // loopback
    if (s.startsWith('fe80')) return true;           // link-local
    if (s.startsWith('fc') || s.startsWith('fd')) return true; // ULA
    if (s === '::' ) return true;
    if (METADATA_IPS.has(s)) return true;
    return false;
  }
  return false; // not a literal IP — hostname, handled by the caller after resolve
}

export interface EgressPolicy {
  blockPrivate: boolean;
  /** host → allowed (any port), or host:port → that port only. Empty = no allowlist. */
  allowlist: Set<string>;
}

export function getEgressPolicy(): EgressPolicy {
  return {
    blockPrivate: envBool('GS_PROXY_BLOCK_PRIVATE'),
    allowlist: new Set(envList('GS_PROXY_HOST_ALLOWLIST').map((s) => s.toLowerCase())),
  };
}

export interface EgressCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Validate a connect target BEFORE any socket is opened. Checks:
 *   1. host is a non-empty string, port is an integer in 1..65535;
 *   2. if an allowlist is set, host or host:port must be on it (explicit allow);
 *   3. if blockPrivate is on, a literal-IP host in an internal range is rejected.
 *
 * Hostname (non-literal) targets pass the private-range check here; the caller
 * should re-validate the RESOLVED address to defeat DNS rebinding (see
 * assertResolvedAllowed).
 */
export function validateEgressTarget(host: unknown, port: unknown, policy = getEgressPolicy()): EgressCheck {
  if (typeof host !== 'string' || host.trim().length === 0) {
    return { ok: false, reason: 'host must be a non-empty string' };
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: 'port must be an integer in 1..65535' };
  }
  const h = host.trim().toLowerCase();
  if (policy.allowlist.size > 0) {
    if (!policy.allowlist.has(h) && !policy.allowlist.has(`${h}:${port}`)) {
      return { ok: false, reason: `host ${host}:${port} not in GS_PROXY_HOST_ALLOWLIST` };
    }
    // An explicit allowlist entry is a deliberate allow — honour it even for a
    // private IP (integrators allowlist their own LAN host on purpose).
    return { ok: true };
  }
  if (policy.blockPrivate && isIP(h) && isPrivateIp(h)) {
    return { ok: false, reason: `host ${host} is in a blocked internal range` };
  }
  return { ok: true };
}

/** Re-check a resolved IP against blockPrivate (DNS-rebinding defense). Only
 *  meaningful when blockPrivate is on and no allowlist forced an allow. */
export function assertResolvedAllowed(resolvedIp: string, policy = getEgressPolicy()): EgressCheck {
  if (policy.allowlist.size > 0) return { ok: true }; // allowlist already decided
  if (policy.blockPrivate && isPrivateIp(resolvedIp)) {
    return { ok: false, reason: `resolved address ${resolvedIp} is in a blocked internal range` };
  }
  return { ok: true };
}
