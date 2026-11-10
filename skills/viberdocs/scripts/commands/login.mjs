import { AuthError } from '../auth/AuthClient.mjs';
import { normalizeAuth } from '../auth/readyAuth.mjs';
import { BROWSER_OUTCOMES } from '../auth/browser.mjs';
import { selfCommand } from '../plugin.mjs';

// How long a continuing login (`--resume`, or a login that finds a pending request) waits for approval. A fresh
// login does not wait at all: it returns the link and code first, so the agent can show them while the person approves.
export const APPROVAL_WAIT_MS = 90000;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const readyResult = auth => ({
  ok: true, status: 'ready', workspace_id: auth.workspace_id, workspace_reach: auth.workspace_reach, scope: auth.scope,
});

// The one-click approval link, derived from the already validated `verification_uri` and `user_code` and never
// stored, so an extra query parameter from the server cannot reach it.
export const approvalLink = pending => `${pending.verification_uri}?user_code=${pending.user_code}`;

// `resume_command` also feeds human output, so it has no `--json`; `next_step` is read by agents, which want JSON.
const resumeCommand = () => `${selfCommand()} login --resume`;

// What an agent should do with a pending result, with the code and link as ready-to-show lines (code first). It is
// read at the moment the agent acts, so it also says why: the person checks the code against the approval page, even
// when that page already opened. `stage` is 'new' (this command created the request) or 'waiting' (a continuing login
// that is still pending). Built only from the validated code and the derived link, never the device code.
function nextStep(pending, stage, browser) {
  const resumeJson = `${resumeCommand()} --json`;
  const lines = [`Code: ${pending.user_code}`, `Link: ${approvalLink(pending)}`];
  if (stage === 'waiting') {
    return [
      'Approval has not arrived yet. End your message with these two lines and do no other work until the person ' +
        `says they approved, then run ${resumeJson} again:`,
      ...lines,
    ].join('\n');
  }
  const check = browser === 'opened'
    ? 'The approval page is already open in their browser, and they check that its code matches:'
    : 'They open the link in their own browser (the code is already filled in) and check that it matches:';
  return [
    `Before you run anything else, show the person these two lines. ${check}`,
    ...lines,
    `Then run ${resumeJson} with a timeout of at least 2 minutes. It waits up to ${APPROVAL_WAIT_MS / 1000} ` +
      'seconds for approval.',
  ].join('\n');
}

const pendingResult = (pending, browser, stage) => ({
  ok: true, status: 'pending', verification_uri: pending.verification_uri, verification_uri_complete: approvalLink(pending),
  user_code: pending.user_code, browser, expires_at: new Date(pending.expires_at).toISOString(),
  resume_command: resumeCommand(), next_step: nextStep(pending, stage, browser),
});

// Runs the injected opener on a fresh request. A missing opener is `not_attempted`; an opener that throws, or answers
// outside the closed outcome set, is `failed`, so the person still gets the link and the agent sees the reason.
async function openApproval(pending, openBrowser) {
  if (!openBrowser) return 'not_attempted';
  try {
    const outcome = await openBrowser(approvalLink(pending));
    return BROWSER_OUTCOMES.includes(outcome) ? outcome : 'failed';
  } catch {
    return 'failed';
  }
}

export async function login(store, client, options, openBrowser = null) {
  return store.withLock(async () => {
    const auth = await store.read('auth.json');
    if (options.cancel) {
      await store.remove('pending-login.json');
      return { ok: true, status: 'cancelled' };
    }
    if (auth) {
      const ready = auth.state === 'ready' ? normalizeAuth(auth) : null;
      if (!ready || ready.origin !== client.origin || ready.client_id !== client.client) throw new AuthError('reauth_required');
      // A login for all workspaces satisfies any `--workspace`; a one-workspace login only its own.
      if (options.workspace && ready.workspace_reach === 'one' && options.workspace !== ready.workspace_id) throw new AuthError('workspace_mismatch');
      return readyResult(ready);
    }
    let pending = await store.read('pending-login.json');
    if (pending && (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(pending.user_code || '') ||
        pending.verification_uri !== `${client.origin}/api/oauth/device` ||
        typeof pending.device_code !== 'string' || !pending.device_code || pending.device_code.length > 512 ||
        !Number.isSafeInteger(pending.expires_at) || !Number.isSafeInteger(pending.next_poll_at) ||
        !Number.isInteger(pending.interval) || pending.interval < 1 || pending.interval > 600)) {
      throw new AuthError('invalid_state');
    }
    // A stale request can never complete: its code expired, it belongs to another API or client, or its last token
    // exchange was never confirmed (the server may already have consumed the code). It is never polled again.
    // `--resume` asked for that request, so it fails; a plain login replaces it with a fresh one.
    if (pending && (pending.origin !== client.origin || pending.client_id !== client.client || pending.expires_at <= Date.now() || pending.exchange_in_flight)) {
      await store.remove('pending-login.json');
      if (options.resume) throw new AuthError('login_expired');
      pending = null;
    }
    if (options.resume && !pending) throw new AuthError('no_pending_login');
    if (pending && options.workspace && pending.workspace_hint !== options.workspace) throw new AuthError('workspace_mismatch');
    if (!pending) {
      // A fresh request is saved before the browser opens, so a kill after opening leaves a resumable login. It
      // returns at once: the agent must see the link and code before anything waits for the person.
      pending = await client.begin(options.workspace);
      await store.write('pending-login.json', pending);
      return pendingResult(pending, await openApproval(pending, openBrowser), 'new');
    }
    if (!options.json) {
      console.log(`Approve this login in your browser: ${approvalLink(pending)}`);
      console.log(`Code: ${pending.user_code}`);
      console.log(`Waiting up to ${APPROVAL_WAIT_MS / 1000} seconds for approval...`);
    }
    const end = Date.now() + APPROVAL_WAIT_MS;
    while (pending.next_poll_at < end && pending.expires_at > Date.now()) {
      await wait(Math.max(0, pending.next_poll_at - Date.now()));
      if (Date.now() >= end) break;
      pending.exchange_in_flight = true;
      await store.write('pending-login.json', pending);
      const remaining = end - Date.now();
      if (remaining < 1000) {
        pending.exchange_in_flight = false;
        await store.write('pending-login.json', pending);
        break;
      }
      try {
        const result = await client.poll(pending.device_code, Math.min(15000, remaining));
        await store.write('auth.json', result);
        await store.remove('pending-login.json');
        return readyResult(result);
      } catch (error) {
        if (!['authorization_pending', 'slow_down'].includes(error.code)) {
          if (['access_denied', 'expired_token', 'invalid_grant'].includes(error.code)) await store.remove('pending-login.json');
          throw error;
        }
        if (error.code === 'slow_down') pending.interval += 5;
        pending.exchange_in_flight = false;
        pending.next_poll_at = Date.now() + pending.interval * 1000;
        await store.write('pending-login.json', pending);
      }
    }
    return pendingResult(pending, 'not_attempted', 'waiting');
  });
}
