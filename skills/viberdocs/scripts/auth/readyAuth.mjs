import { AuthError } from './AuthClient.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPES = ['docs:read', 'docs:publish'];
const REACHES = ['one', 'all'];

// The login fields of a stored `auth.json`, read as the current shape, or null when they are not valid.
// A 1.0.0 file has neither `scope` nor `workspace_reach` and a UUID `workspace_id`: it was always one
// workspace with read & write, and reads as exactly that. A file with only one of the two new fields, or
// any field outside its set, is not a login this CLI can trust. Every reader of the stored login goes
// through here, so an upgraded install keeps working and the refresh check compares like with like.
export function normalizeAuth(auth) {
  if (!auth || typeof auth !== 'object' || !UUID.test(auth.grant_id || '')) return null;
  const legacy = auth.scope === undefined && auth.workspace_reach === undefined;
  const scope = legacy ? 'docs:publish' : auth.scope;
  const reach = legacy ? 'one' : auth.workspace_reach;
  if (!SCOPES.includes(scope) || !REACHES.includes(reach)) return null;
  const workspaceOk = reach === 'one' ? UUID.test(auth.workspace_id || '') : auth.workspace_id === null;
  return workspaceOk ? { ...auth, scope, workspace_reach: reach } : null;
}

// Reads `auth.json`, refuses anything but a complete `ready` login for this origin and client, and refreshes
// the access token when it is within 60 s of expiry. The caller must already hold `store.withLock`, because
// `refreshLocked` rotates the refresh token.
export async function loadReadyAuth(store, authClient) {
  const stored = await store.read('auth.json');
  let auth = stored?.state === 'ready' ? normalizeAuth(stored) : null;
  if (!auth || auth.origin !== authClient.origin || auth.client_id !== authClient.client ||
      typeof auth.access_token !== 'string' || typeof auth.refresh_token !== 'string' ||
      !Number.isFinite(auth.access_expires_at)) {
    throw new AuthError('reauth_required');
  }
  if (auth.access_expires_at <= Date.now() + 60000) auth = await authClient.refreshLocked(store, auth);
  return auth;
}
