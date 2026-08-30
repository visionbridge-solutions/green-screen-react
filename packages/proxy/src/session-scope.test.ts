import { describe, it, expect, afterEach } from 'vitest';
import { createSession, getSession, getAllSessions } from './session.js';
import { getSessionStore } from './session-store.js';

// createSession tags a session with the caller's auth scope (see
// security.resolveAuth). The route layer uses that tag to keep one tenant's
// sessions invisible/untouchable to another; this pins the tag itself so a
// refactor can't silently drop it and collapse the isolation boundary.

function purge() {
  for (const s of Array.from(getAllSessions())) getSessionStore().delete(s.id);
}
afterEach(purge);

describe('session scope tagging', () => {
  it('defaults to null (unscoped) when no scope is given', () => {
    const s = createSession('tn5250');
    expect(s.scope).toBeNull();
    expect(getSession(s.id)?.scope).toBeNull();
  });

  it('records the scope it was created under', () => {
    const s = createSession('tn5250', 'org-abc');
    expect(s.scope).toBe('org-abc');
    expect(getSession(s.id)?.scope).toBe('org-abc');
  });

  it('keeps each tenant\'s sessions distinguishable in the shared store', () => {
    const a = createSession('tn5250', 'org-a');
    const b = createSession('tn5250', 'org-b');
    const forA = getAllSessions().filter(x => x.scope === 'org-a');
    expect(forA.map(x => x.id)).toEqual([a.id]);
    expect(forA.map(x => x.id)).not.toContain(b.id);
  });
});
