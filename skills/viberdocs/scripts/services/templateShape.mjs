// What the CLI accepts from, and prints about, a template draft. Shared by `TemplateClient` (which checks the
// server's answer), `OperationJournal` (which checks a saved result) and the error printer in `viberdocs.mjs`
// (which checks the server details it is about to show), so all three agree.

export const TEMPLATE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const SERVER_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
export const DRAFT_STATUSES = ['processing', 'ready', 'invalid'];

export const MAX_PROBLEMS = 20;
const FIELD_MAX = 200;
const MESSAGE_MAX = 300;
const OFFENDING_MAX = 120;

// A template draft as the server describes it: a usable handle, a revision and a status from the closed set.
export function isDraftResult(data) {
  return Boolean(data) && typeof data === 'object' && typeof data.handle === 'string' && TEMPLATE_HANDLE.test(data.handle) &&
    Number.isSafeInteger(data.draft_revision) && data.draft_revision >= 1 && DRAFT_STATUSES.includes(data.draft_status);
}

// Turns the server's 422 body into what an agent can act on: which field, what is wrong, and for unsafe content
// the offending token. Only two shapes are understood; anything else gives none. Values that are not strings are
// skipped and every string is cut to a fixed length, so a hostile or buggy server cannot flood the output.
//   VALIDATION_ERROR with array `details`    -> up to 20 {field, message}
//   UNSAFE_TEMPLATE_CONTENT with object `details` -> one {field, message: "<reason>: <hint>", offending?}
export function sanitizeProblems(server) {
  if (!server || typeof server !== 'object') return undefined;
  let problems = [];
  if (server.code === 'VALIDATION_ERROR' && Array.isArray(server.details)) {
    for (const item of server.details) {
      if (problems.length === MAX_PROBLEMS) break;
      if (item && typeof item === 'object' && typeof item.field === 'string' && typeof item.message === 'string') {
        problems.push({ field: item.field.slice(0, FIELD_MAX), message: item.message.slice(0, MESSAGE_MAX) });
      }
    }
  } else if (server.code === 'UNSAFE_TEMPLATE_CONTENT' && server.details && typeof server.details === 'object' &&
             !Array.isArray(server.details)) {
    const { field, reason, hint, offending } = server.details;
    if (typeof field === 'string' && typeof reason === 'string') {
      const problem = {
        field: field.slice(0, FIELD_MAX),
        message: (typeof hint === 'string' ? `${reason}: ${hint}` : reason).slice(0, MESSAGE_MAX),
      };
      if (typeof offending === 'string') problem.offending = offending.slice(0, OFFENDING_MAX);
      problems = [problem];
    }
  }
  return problems.length ? problems : undefined;
}

// The printer's second look at `problems` before they reach stdout: the whole list is dropped unless every
// entry has the exact shape and length limits, so nothing unexpected is ever printed.
export function printableProblems(problems) {
  if (!Array.isArray(problems) || problems.length < 1 || problems.length > MAX_PROBLEMS) return undefined;
  const clean = [];
  for (const item of problems) {
    if (!item || typeof item !== 'object' || typeof item.field !== 'string' || item.field.length > FIELD_MAX ||
        typeof item.message !== 'string' || item.message.length > MESSAGE_MAX ||
        (item.offending !== undefined && (typeof item.offending !== 'string' || item.offending.length > OFFENDING_MAX))) {
      return undefined;
    }
    const entry = { field: item.field, message: item.message };
    if (item.offending !== undefined) entry.offending = item.offending;
    clean.push(entry);
  }
  return clean;
}
