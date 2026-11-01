/**
 * The bearer gate every REST route passes when GS_PROXY_AUTH_TOKEN is set.
 *
 * One request is let through without a credential: the bare healthcheck
 * (`GET /status` naming no session), which orchestrators poll anonymously.
 * It is stamped `gsAnonymous` so the route answers it with the SERVER's
 * liveness and capabilities only — never a session's host or user, which
 * the default-session resolution would otherwise hand to anyone who can
 * reach the port while exactly one session is live.
 *
 * Every other request resolves to a scope (`resolveAuth`): null for the base
 * token (all-access), a tenant label for a scoped token, 401 for the rest.
 */
import type { NextFunction, Request, Response } from 'express';
import { resolveAuth } from './security.js';

export interface GatedRequest extends Request {
  /** The caller's scope: null = all-access; a string confines to that scope. */
  gsScope?: string | null;
  /** True for the one credential-less request the gate admits. */
  gsAnonymous?: boolean;
}

export function isBareHealthcheck(req: Request): boolean {
  return req.method === 'GET' && req.path === '/status' &&
    !req.headers['x-session-id'] && !req.query.sessionId;
}

export function authGate(req: Request, res: Response, next: NextFunction): void {
  const gated = req as GatedRequest;
  // Only a CREDENTIAL-LESS bare probe is anonymous: a caller that presents a
  // token on it is resolved like anyone else (the control plane's bare probe
  // still finds its lone session; a scoped caller counts its own).
  if (isBareHealthcheck(req) && !req.headers.authorization) {
    gated.gsAnonymous = true;
    return next();
  }
  const auth = resolveAuth(req.headers.authorization);
  if (!auth.ok) {
    res.status(401).json({ success: false, error: 'unauthorized' });
    return;
  }
  gated.gsScope = auth.scope;
  next();
}
