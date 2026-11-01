import type { SessionAccess } from "../src/auth/public.js";
export const testSessionId = "00000000-0000-4000-8000-000000000001";
/** Explicit unit-test authority; database/session integration tests use the real adapter. */
export const testSessions: SessionAccess = {
  authenticate: async () => ({ ownerId: "owner", sessionId: testSessionId }),
  active: async () => true,
};
