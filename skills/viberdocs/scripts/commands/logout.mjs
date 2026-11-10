export async function logout(store, client) {
  return store.withLock(async () => {
    const auth = await store.read('auth.json');
    let remote = 'not_applicable';
    if (auth?.refresh_token) {
      remote = 'unconfirmed';
      if (auth.origin === client.origin && auth.client_id === client.client) {
        try {
          await client.revoke(auth.refresh_token);
          remote = 'confirmed';
        } catch {
          // Local credentials are still removed when remote revocation is unavailable.
        }
      }
    }
    await store.remove('auth.json');
    await store.remove('pending-login.json');
    return { ok: true, status: 'logged_out', remote_revocation: remote };
  });
}
