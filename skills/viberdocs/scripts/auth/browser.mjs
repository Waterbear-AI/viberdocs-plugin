import { spawn } from 'node:child_process';

// Why a browser did or did not open, as a closed set. `login` returns one of these as `browser`, so an agent can word
// its message by reason instead of guessing from a bare boolean.
export const BROWSER_OUTCOMES = ['opened', 'failed', 'unavailable', 'disabled', 'not_attempted'];

const LAUNCHER_WAIT_MS = 3000;
const REMOTE_VARIABLES = ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'CI'];
const DEVICE_PATH = '/api/oauth/device';
const DEVICE_SEARCH = /^\?user_code=[A-Z0-9]{4}-[A-Z0-9]{4}$/;

// "Non-empty" is literal: `0` and `false` count as set, so there is no truthiness parsing to get wrong.
const isSet = value => typeof value === 'string' && value !== '';

// Decides whether a browser may be opened here and with which launcher. Pure: no I/O, and the URL is appended by the
// caller. It fails closed: only macOS, and Linux with a display, are treated as a local desktop, and any sign of a
// remote or CI session, or an unknown platform, means no attempt. `SSH_AUTH_SOCK` is deliberately not a signal (a
// local ssh-agent sets it). WSL reports `linux` and follows the Linux rule: WSLg sets `DISPLAY`.
export function browserLaunch({ platform, env, noBrowser } = {}) {
  const environment = env && typeof env === 'object' ? env : {};
  if (noBrowser === true || isSet(environment.VIBERDOCS_NO_BROWSER)) return { outcome: 'disabled' };
  if (REMOTE_VARIABLES.some(name => isSet(environment[name]))) return { outcome: 'unavailable' };
  if (platform === 'darwin') return { command: 'open', args: [] };
  if (platform === 'linux') {
    if (!isSet(environment.DISPLAY) && !isSet(environment.WAYLAND_DISPLAY)) return { outcome: 'unavailable' };
    return { command: 'xdg-open', args: [] };
  }
  return { outcome: 'unavailable' };
}

// The prefilled approval link `login` builds, re-checked right before it reaches a process argument: https, no
// credentials or fragment, the device page, and exactly one `user_code` of the fixed shape. Returns the normalised
// link, or null. The origin was already pinned by `AuthClient`; this guards the part that becomes an argument.
function approvalUrl(url) {
  // The URL parser silently drops tabs and newlines, so whitespace and control characters are refused up front.
  if (typeof url !== 'string' || url.includes('#') || /[\s\u0000-\u001f\u007f]/.test(url)) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const ok = parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' &&
    parsed.hash === '' && parsed.pathname === DEVICE_PATH && DEVICE_SEARCH.test(parsed.search);
  return ok ? parsed.href : null;
}

// A draft preview link, re-checked right before it reaches a process argument: https, no credentials, query or
// fragment, a `pv-<id>` host label, and a plain host and path. The link came from the server, so it is held to the
// shape a preview URL has (`https://pv-<26 characters>.<content domain>/`) and nothing else.
const PREVIEW_HOST = /^pv-[a-z2-7]{26}\.[a-z0-9.-]+$/;

export function previewUrl(url) {
  if (typeof url !== 'string' || url.includes('#') ||/[\s\u0000-\u001f\u007f]/.test(url)) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const ok = parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.search === '' &&
    parsed.hash === '' && parsed.pathname === '/' && PREVIEW_HOST.test(parsed.hostname);
  return ok ? parsed.href : null;
}

// Opens `url` with the OS URL launcher and reports what happened. Never throws and never writes to stdout or stderr:
// every failure is a `BrowserOutcome`. `spawnFn` is the test seam (defaults to `node:child_process.spawn`).
export function openBrowser(url, options = {}) {
  return launchUrl(url, approvalUrl, browserLaunch, options);
}

// The same for a draft preview link (`preview`), with the same launchers and refusals: any sign of a sandbox, an SSH
// or CI session, or no opener is an outcome, not an error, so the command still prints the link and succeeds. There is
// no Windows launcher: the CLI refuses to keep a login on Windows (`unsupported_host`), so it never gets this far there.
export function openPreview(url, options = {}) {
  return launchUrl(url, previewUrl, browserLaunch, options);
}

function launchUrl(url, validate, decide, { platform, env, noBrowser, spawnFn = spawn } = {}) {
  return new Promise(resolve => {
    try {
      const launch = decide({ platform, env, noBrowser });
      if (launch.outcome) return resolve(launch.outcome);
      const link = validate(url);
      if (!link) return resolve('failed');

      let timer = null;
      let child = null;
      let settled = false;
      const settle = outcome => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(outcome);
      };

      try {
        child = spawnFn(launch.command, [...launch.args, link], {
          shell: false, stdio: 'ignore', detached: true, env,
        });
        // `on`, not `once`: an `error` or `exit` after the outcome is known must be absorbed, not crash the process.
        child.on('error', () => settle('failed'));
        child.on('exit', (code, signal) => settle(code === 0 && !signal ? 'opened' : 'failed'));
      } catch {
        return settle('failed');
      }

      if (settled) return;
      // Still running after the wait: the launcher handed the page to a long-lived desktop process.
      timer = setTimeout(() => {
        if (settled) return;
        try {
          child.unref();
        } catch {
          // The handle is already gone; the outcome stands.
        }
        settle('opened');
      }, LAUNCHER_WAIT_MS);
    } catch {
      resolve('failed');
    }
  });
}
