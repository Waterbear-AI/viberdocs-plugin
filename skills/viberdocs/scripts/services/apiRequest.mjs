import { AuthError } from '../auth/AuthClient.mjs';

const DEFAULT_MAX_BYTES = 262144;
const RETRYABLE_STATUSES = [502, 503, 504];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Reads a response body into one Buffer, refusing more than `maxBytes`. Throws a plain Error when over the cap;
// the caller turns that into `invalid_response`.
async function readBody(response, maxBytes) {
  const chunks = [];
  let size = 0;
  if (response.body) for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// A published doc's address as the API gives it (`/s/<workspace slug>/<doc slug>/`), made absolute on the API origin,
// or null for anything else. The result is printed for an agent to open or share, so a server answer can never turn
// it into a link to another site or another scheme.
export function siteUrl(origin, value) {
  return typeof value === 'string' && /^\/s\/[a-z0-9-]+\/[a-z0-9-]+\/$/.test(value) ? `${origin}${value}` : null;
}

// What the server said about a failed request: its `code` and `details`, when the body was a JSON object.
function serverError(data) {
  return data && typeof data === 'object' && !Array.isArray(data) ? { code: data.code, details: data.details } : undefined;
}

// A GET whose answer is read as a stream by the caller (a document's bytes, a file of a version): the same policy as
// `requestJson` (bearer header, no redirects, 60 s timeout, three attempts on a network failure or 502-504, one token
// refresh on 401) but the successful `Response` is returned unread, so the caller can check its size and hash while it
// streams. Throws `AuthError('http_<status>')` (retryable for 5xx and 429) or `network_error`. `session` is as for
// `requestJson`.
export async function sendRaw(session, route) {
  let refreshed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await session.fetch(`${session.authClient.origin}${route}`, {
        method: 'GET', headers: { Authorization: `Bearer ${session.auth.access_token}` },
        redirect: 'error', signal: AbortSignal.timeout(60000),
      });
    } catch {
      if (attempt < 2) { await pause(100 * 2 ** attempt); continue; }
      throw new AuthError('network_error', true);
    }
    if (response.status === 401 && !refreshed) {
      await response.body?.cancel().catch(() => {});
      session.auth = await session.authClient.refreshLocked(session.store, session.auth);
      refreshed = true;
      attempt--;
      continue;
    }
    if (response.ok) return response;
    await response.body?.cancel().catch(() => {});
    if (RETRYABLE_STATUSES.includes(response.status) && attempt < 2) {
      await pause(100 * 2 ** attempt);
      continue;
    }
    throw new AuthError(`http_${response.status}`, response.status >= 500 || response.status === 429);
  }
  throw new AuthError('network_error', true);
}

// Sends one API request and returns its JSON body, with the policy every CLI request shares: no redirects, a 60 s
// timeout, one token refresh on 401, and a response size cap.
//
// `session` is `{fetch, authClient, store, auth}`; `auth` is replaced in place when the token is refreshed, so the
// caller keeps using the new one. Options:
//   method, body, headers   as for `fetch`.
//   anonymous               send no `Authorization` header and never refresh on 401 (an upload ticket carries its
//                           own authority).
//   retry                   up to three attempts on a network failure or a 502-504, with a short backoff. Only for
//                           requests that are safe to send again (same idempotency key, or a read).
//   maxBytes                response size cap; over it is `invalid_response`.
//   passthroughConflicts    409 `code`s that are results, not failures: returned as `{code, details}`.
//
// Returns `{data, raw}` for a 2xx (`raw` is the response Buffer; an empty body gives `data` = `{}`), or
// `{code, details}` for a passed-through conflict. Otherwise throws `AuthError('http_<status>')`, retryable for 5xx
// and 429, with `error.server = {code, details}` when the body parsed. A 409 with a known conflict code gets a more
// specific error code. A body that is not JSON, or is over the cap, is `invalid_response`.
export async function requestJson(session, route, options = {}) {
  const {
    method = 'GET', body, headers = {}, anonymous = false, retry = false,
    maxBytes = DEFAULT_MAX_BYTES, passthroughConflicts = [],
  } = options;
  let refreshed = false;
  for (let attempt = 0; attempt < (retry ? 3 : 1); attempt++) {
    let response;
    try {
      response = await session.fetch(`${session.authClient.origin}${route}`, {
        method, body, headers: anonymous ? headers : { ...headers, Authorization: `Bearer ${session.auth.access_token}` },
        redirect: 'error', signal: AbortSignal.timeout(60000),
      });
    } catch {
      if (retry && attempt < 2) { await pause(100 * 2 ** attempt); continue; }
      throw new AuthError('network_error', true);
    }
    if (response.status === 401 && !anonymous && !refreshed) {
      await response.body?.cancel().catch(() => {});
      session.auth = await session.authClient.refreshLocked(session.store, session.auth);
      refreshed = true;
      attempt--;
      continue;
    }
    try {
      const raw = await readBody(response, maxBytes);
      const text = raw.toString('utf8');
      const data = text ? JSON.parse(text) : {};
      if (response.ok) return { data, raw };
      if (RETRYABLE_STATUSES.includes(response.status) && retry && attempt < 2) {
        await pause(100 * 2 ** attempt);
        continue;
      }
      if (response.status === 409 && passthroughConflicts.includes(data?.code)) {
        return { code: data.code, details: data.details };
      }
      const error = new AuthError(`http_${response.status}`, response.status >= 500 || response.status === 429);
      const server = serverError(data);
      if (server) error.server = server;
      if (response.status === 409) {
        if (['IDEMPOTENCY_KEY_CONFLICT', 'IDEMPOTENCY_CONFLICT'].includes(data?.code)) error.code = 'idempotency_conflict';
        else if (data?.code === 'DRAFT_REVISION_CONFLICT') error.code = 'draft_revision_conflict';
      }
      throw error;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError('invalid_response');
    }
  }
  throw new AuthError('network_error', true);
}
