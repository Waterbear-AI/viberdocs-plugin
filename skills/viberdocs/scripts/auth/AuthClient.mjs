const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPES = ['docs:read', 'docs:publish'];
const REACHES = ['one', 'all'];

// Reach and scope of a token response, or null when the response is not acceptable. A response that
// names a `workspace_reach` must pair it consistently: a UUID workspace for `one`, JSON null for `all`.
// A response without the field is the shape an older API sends (also mid-rollout or after a rollback):
// one workspace and read & write, nothing else.
function grantShape(data) {
  if (!('workspace_reach' in data)) {
    return data.scope === 'docs:publish' && UUID.test(data.workspace_id || '')
      ? { workspace_reach: 'one', scope: 'docs:publish', workspace_id: data.workspace_id } : null;
  }
  if (!REACHES.includes(data.workspace_reach) || !SCOPES.includes(data.scope)) return null;
  const workspaceOk = data.workspace_reach === 'one' ? UUID.test(data.workspace_id || '') : data.workspace_id === null;
  return workspaceOk ? { workspace_reach: data.workspace_reach, scope: data.scope, workspace_id: data.workspace_id } : null;
}

export class AuthError extends Error {
  constructor(code, retryable = false) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

export class AuthClient {
  constructor(release, fetcher = fetch) {
    const url = new URL(release.api_origin);
    if (url.protocol !== 'https:' || url.origin !== release.api_origin || !release.client_id || release.protocol_version !== 1) {
      throw new AuthError('invalid_release');
    }
    this.origin = url.origin;
    this.client = release.client_id;
    this.fetch = fetcher;
  }

  // `deviceFlow` marks the two requests of a login (the device request and the device-code token exchange). On those,
  // a 503 `temporarily_unavailable` means this server has CLI login switched off, which retrying cannot fix, so it
  // is `login_unavailable` and not retryable. Refresh and revoke keep `request_failed`, retryable on a 503.
  async post(route, params, timeout = 15000, deviceFlow = false) {
    let response;
    try {
      response = await this.fetch(`${this.origin}${route}`, {
        method: 'POST', body: new URLSearchParams(params), redirect: 'error', signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw new AuthError('network_error', true);
    }
    if (Number(response.headers.get('content-length') || 0) > 65536) throw new AuthError('invalid_response');
    let body;
    try {
      const chunks = [];
      let size = 0;
      if (response.body) {
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 65536) throw new Error();
          chunks.push(chunk);
        }
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      body = raw ? JSON.parse(raw) : {};
    } catch {
      throw new AuthError('invalid_response');
    }
    if (!response.ok) {
      if (deviceFlow && response.status === 503 && body.error === 'temporarily_unavailable') throw new AuthError('login_unavailable');
      const allowed = ['authorization_pending', 'slow_down', 'access_denied', 'expired_token', 'invalid_grant', 'invalid_client'];
      throw new AuthError(allowed.includes(body.error) ? body.error : 'request_failed', response.status >= 500 || response.status === 429);
    }
    return body;
  }

  async begin(workspace) {
    // `cli_protocol` tells the API this CLI can hold an all-workspaces or read-only login. It is unrelated
    // to the release descriptor's `protocol_version`, which stays 1.
    const params = { client_id: this.client, scope: 'docs:publish', cli_protocol: '2' };
    if (workspace) params.workspace_hint = workspace;
    const data = await this.post('/api/oauth/device_authorization', params, undefined, true);
    const verification = new URL(data.verification_uri);
    const complete = new URL(data.verification_uri_complete);
    if (verification.origin !== this.origin || complete.origin !== this.origin ||
        verification.username || verification.password || verification.search || verification.hash ||
        complete.username || complete.password || complete.hash ||
        verification.pathname !== '/api/oauth/device' || complete.pathname !== '/api/oauth/device' ||
        typeof data.device_code !== 'string' || !data.device_code || data.device_code.length > 512 ||
        typeof data.user_code !== 'string' || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(data.user_code) ||
        !Number.isInteger(data.expires_in) || data.expires_in < 1 || data.expires_in > 600 ||
        !Number.isInteger(data.interval) || data.interval < 1 || data.interval > 60) {
      throw new AuthError('invalid_response');
    }
    return {
      device_code: data.device_code, user_code: data.user_code, verification_uri: verification.href,
      expires_at: Date.now() + data.expires_in * 1000, interval: data.interval,
      next_poll_at: Date.now() + data.interval * 1000, workspace_hint: workspace || null,
      origin: this.origin, client_id: this.client,
    };
  }

  async token(params, timeout, deviceFlow = false) {
    const data = await this.post('/api/oauth/token', { client_id: this.client, ...params }, timeout, deviceFlow);
    if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 8192 ||
        typeof data.refresh_token !== 'string' || !data.refresh_token || data.refresh_token.length > 8192 ||
        data.token_type !== 'Bearer' || !UUID.test(data.grant_id || '') ||
        !Number.isInteger(data.expires_in) || data.expires_in <= 0 || !Number.isFinite(Date.parse(data.grant_expires_at))) {
      throw new AuthError('invalid_response');
    }
    const grant = grantShape(data);
    if (!grant) throw new AuthError('invalid_response');
    return {
      origin: this.origin, client_id: this.client, access_token: data.access_token,
      refresh_token: data.refresh_token, workspace_id: grant.workspace_id, workspace_reach: grant.workspace_reach,
      scope: grant.scope, grant_id: data.grant_id,
      grant_expires_at: data.grant_expires_at, access_expires_at: Date.now() + data.expires_in * 1000,
      state: 'ready',
    };
  }

  poll(deviceCode, timeout) { return this.token({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode }, timeout, true); }
  refresh(refreshToken) { return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken }); }
  revoke(refreshToken) { return this.post('/api/oauth/revoke', { client_id: this.client, token: refreshToken, token_type_hint: 'refresh_token' }); }

  async refreshLocked(store, auth) {
    if (auth.state !== 'ready' || auth.origin !== this.origin || auth.client_id !== this.client) throw new AuthError('reauth_required');
    await store.write('auth.json', { ...auth, state: 'refresh_in_flight' });
    try {
      const next = await this.refresh(auth.refresh_token);
      // A refresh never changes what the login covers. `auth` is the normalized stored login, so an
      // upgraded 1.0.0 file already reads as one workspace with read & write.
      if (next.grant_id !== auth.grant_id || next.workspace_id !== auth.workspace_id ||
          next.workspace_reach !== auth.workspace_reach || next.scope !== auth.scope) throw new AuthError('invalid_response');
      await store.write('auth.json', next);
      return next;
    } catch {
      await store.write('auth.json', { ...auth, state: 'reauth_required' });
      throw new AuthError('reauth_required');
    }
  }
}
