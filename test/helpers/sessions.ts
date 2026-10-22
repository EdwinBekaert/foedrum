// SessionRef values for tests, built from what the claims read: the session, the one it resumes
// and the worktree it runs in. #324 removes `claudeVersion` from SessionRef, and with it this line.

import type { SessionRef } from '../../src/schemas/events.ts';

export const sessionRef = (session: Omit<SessionRef, 'claudeVersion'>): SessionRef => ({
  ...session,
  claudeVersion: '2.1.300',
});
