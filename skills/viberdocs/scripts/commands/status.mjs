import { normalizeAuth } from '../auth/readyAuth.mjs';

export async function status(store, release) {
  return store.withLock(async () => {
    const auth = await store.read('auth.json');
    const pending = await store.read('pending-login.json');
    // A stored login that is not ready, or whose fields are not valid, is reported rather than thrown on.
    const ready = auth?.state === 'ready' ? normalizeAuth(auth) : null;
    const state = auth ? (ready ? 'ready' : 'reauth_required') : (pending ? 'pending' : 'signed_out');
    return {
      ok: true, status: state, workspace_id: ready?.workspace_id ?? null,
      workspace_reach: ready?.workspace_reach ?? null, scope: ready?.scope ?? null,
      release: release.version, authorization: 'local_state_only',
    };
  });
}
