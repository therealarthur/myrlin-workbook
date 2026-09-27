/**
 * errors.js: the error shape and response helpers of the mobile v2 protocol.
 *
 * WHY: every non 2xx body the phone sees must be exactly
 * {"error": "<sentence>", "code": "<UPPER_SNAKE>"} plus the extra fields that
 * PROTOCOL.md section 13 lists for that code, and every response from the
 * mobile listener carries X-Myrlin-Api and Cache-Control: no-store (section
 * 0.5). One module owns that shape so B1, B2 and B3 cannot drift apart
 * (BUILD-CONTRACT 3.1: "Errors go through B1's errors.js helpers").
 *
 * The helpers work on a raw http.ServerResponse and on an Express response
 * alike, because the admin routes (main server) and the mobile listener both
 * use them.
 */
'use strict';

/** Protocol major version (PROTOCOL.md 12). */
const API_VERSION = 2;
/** Additive revision within v2 (PROTOCOL.md 12). */
const API_REVISION = 0;
/** Response header name carried by every mobile listener response. */
const API_HEADER = 'X-Myrlin-Api';
/** Header value, "<apiVersion>.<apiRevision>". */
const API_HEADER_VALUE = API_VERSION + '.' + API_REVISION;

/** Milliseconds in one second, for Retry-After rounding. */
const MS_PER_SECOND = 1000;

/**
 * The code catalog of PROTOCOL.md section 13: status, the extra fields a body
 * may carry, and the default sentence used when a caller gives none. Codes
 * owned by B2 and B3 are listed too, so their routes get the same defaults.
 */
const CODES = {
  INVALID_JSON: { status: 400, extras: [], message: 'The request body is not valid JSON.' },
  INVALID_FIELD: { status: 400, extras: ['field'], message: 'A field in the request is missing or invalid.' },
  BODY_TOO_LARGE: { status: 413, extras: [], message: 'The request body is too large.' },
  NOT_FOUND: { status: 404, extras: [], message: 'Nothing is served at this path.' },
  METHOD_NOT_ALLOWED: { status: 405, extras: [], message: 'This path does not accept that method.' },
  WEB_ORIGIN_REFUSED: { status: 403, extras: [], message: 'Requests from a web page are not accepted here.' },
  SUBPROTOCOL_REQUIRED: { status: 400, extras: [], message: 'Open this path as a WebSocket with the myrlin.v2 subprotocol.' },
  AUTH_REQUIRED: { status: 401, extras: [], message: 'Sign in again to continue.' },
  SESSION_EXPIRED: { status: 401, extras: [], message: 'The session expired. Sign in again to continue.' },
  DEVICE_REVOKED: { status: 401, extras: ['computerId', 'deviceId', 'clientNonce', 'revokedAtMs', 'sig'], message: 'This iPhone was removed from this computer.' },
  SCOPE_REQUIRED: { status: 403, extras: ['scope'], message: 'This iPhone is not allowed to do that on this computer.' },
  RATE_LIMITED: { status: 429, extras: ['retryAfterMs'], message: 'Too many requests. Try again shortly.' },
  SERVICE_UNAVAILABLE: { status: 503, extras: ['retryAfterMs'], message: 'The phone connection is restarting. Try again shortly.' },
  INTERNAL: { status: 500, extras: [], message: 'Something went wrong on this computer.' },
  CURSOR_EXPIRED: { status: 410, extras: [], message: 'That page is no longer available. Start again from the top.' },
  APP_TOO_OLD: { status: 426, extras: [], message: 'Update Myrlin to connect to this computer.' },
  IDEMPOTENCY_KEY_REQUIRED: { status: 428, extras: [], message: 'This request needs an Idempotency-Key header.' },
  INVALID_PUBLIC_KEY: { status: 400, extras: [], message: 'The device key is not a valid P-256 public key.' },
  INVALID_SIGNATURE_ENCODING: { status: 400, extras: [], message: 'The signature is not a raw 64 byte P-256 signature.' },
  SIGNATURE_INVALID: { status: 401, extras: [], message: 'The signature did not verify.' },
  NONCE_INVALID: { status: 401, extras: [], message: 'The server nonce is unknown or expired. Say hello again.' },
  WRONG_COMPUTER: { status: 400, extras: [], message: 'This request was meant for a different computer.' },
  DEVICE_UNKNOWN: { status: 404, extras: [], message: 'This computer does not know this iPhone.' },
  DEVICE_ALREADY_PAIRED: { status: 409, extras: [], message: 'This iPhone is already paired with this computer.' },
  PAIR_OFFER_UNKNOWN: { status: 403, extras: [], message: 'That pairing code is not known on this computer.' },
  PAIR_OFFER_EXPIRED: { status: 410, extras: [], message: 'That pairing code expired. Scan the new code.' },
  PAIR_OFFER_USED: { status: 410, extras: [], message: 'That pairing code was already used. Scan the new code.' },
  PAIR_OFFER_BURNED: { status: 410, extras: [], message: 'That pairing code was blocked after too many wrong tries. Scan the new code.' },
  PAIR_SECRET_INVALID: { status: 403, extras: [], message: 'The pairing secret does not match.' },
  PAIR_BUSY: { status: 429, extras: ['retryAfterMs'], message: 'Other phones are waiting to be allowed. Try again shortly.' },
  PAIR_UNKNOWN: { status: 404, extras: [], message: 'That pairing request is not known.' },
  PAIR_EXPIRED: { status: 410, extras: [], message: 'That pairing request expired.' },
  INVALID_SCOPE: { status: 400, extras: [], message: 'One of the permissions is unknown or cannot be granted.' },
  LEGACY_PAIR_DISABLED: { status: 410, extras: [], message: 'Pairing moved to the Myrlin app. Update the app and scan again.' },
  PATH_NOT_FOUND: { status: 404, extras: [], message: 'That folder does not exist.' },
  PATH_NOT_ALLOWED: { status: 403, extras: [], message: 'That folder cannot be opened.' },
  SESSION_NOT_FOUND: { status: 404, extras: [], message: 'That session is not known.' },
  SESSION_READ_ONLY: { status: 409, extras: ['owner', 'reason'], message: 'That session is read only here.' },
  SESSION_LIVE_ELSEWHERE: { status: 409, extras: [], message: 'That session is open somewhere else.' },
  SESSION_BUSY: { status: 409, extras: [], message: 'That session is busy.' },
  BRANCH_POINT_UNSUPPORTED: { status: 422, extras: [], message: 'This session cannot branch from that message.' },
  SEND_QUEUE_FULL: { status: 409, extras: [], message: 'Too many messages are waiting for this session.' },
  TEXT_TOO_LONG: { status: 413, extras: [], message: 'The message is too long.' },
  NOTHING_TO_SEND: { status: 422, extras: [], message: 'There is nothing to send.' },
  SEND_NOT_FOUND: { status: 404, extras: [], message: 'That message is not known.' },
  NOT_YOUR_SEND: { status: 403, extras: [], message: 'That message was sent from another device.' },
  SEND_NOT_CANCELLABLE: { status: 409, extras: [], message: 'That message can no longer be cancelled.' },
  NOT_RUNNING: { status: 409, extras: [], message: 'Nothing is running in that session.' },
  PROMPT_OPEN: { status: 409, extras: ['promptId'], message: 'A question is waiting for an answer.' },
  PROMPT_NOT_FOUND: { status: 404, extras: [], message: 'That question is not known.' },
  PROMPT_ALREADY_RESOLVED: { status: 409, extras: ['by'], message: 'That question was already answered.' },
  PROMPT_CHANGED: { status: 409, extras: [], message: 'That question changed.' },
  PROMPT_NOT_ANSWERABLE: { status: 409, extras: [], message: 'That question cannot be answered from the phone.' },
  INVALID_ANSWER: { status: 422, extras: ['field'], message: 'That answer is not valid.' },
  PROMPT_ANSWER_UNCONFIRMED: { status: 504, extras: [], message: 'The answer could not be confirmed.' },
  MESSAGE_NOT_FOUND: { status: 404, extras: [], message: 'That message is not known.' },
  PART_NOT_FOUND: { status: 404, extras: [], message: 'That part is not known.' },
  PART_NOT_TEXT: { status: 400, extras: [], message: 'That part is not text.' },
  PART_NOT_IMAGE: { status: 400, extras: [], message: 'That part is not an image.' },
  ANCHOR_NOT_FOUND: { status: 404, extras: [], message: 'That message is not known.' },
  TRANSCRIPT_UNAVAILABLE: { status: 409, extras: [], message: 'The transcript is not available.' },
  PROVIDER_NOT_FOUND: { status: 404, extras: [], message: 'That provider is not known.' },
  INVALID_SETTING: { status: 422, extras: ['field'], message: 'That setting is not valid.' },
  WORKING_DIR_NOT_FOUND: { status: 422, extras: [], message: 'That folder does not exist.' },
  PROJECT_REQUIRED: { status: 422, extras: [], message: 'Choose a project first.' },
  NOT_CHATGPT_THREAD: { status: 409, extras: [], message: 'That session is not a ChatGPT thread.' },
  NOT_HANDED_OFF: { status: 409, extras: [], message: 'That session was not handed off.' },
  CONFIRM_REQUIRED: { status: 422, extras: [], message: 'Confirm to continue.' },
  PROJECT_NOT_FOUND: { status: 404, extras: [], message: 'That project is not known.' },
  FOLDER_NOT_FOUND: { status: 404, extras: [], message: 'That folder is not known.' },
  NOT_RENAMABLE: { status: 409, extras: [], message: 'That project cannot be renamed.' },
  TAB_GROUP_FULL: { status: 409, extras: ['groupId'], message: 'That tab group is full.' },
  LAST_TAB_GROUP: { status: 409, extras: [], message: 'The last tab group cannot be removed.' },
  TABS_OP_INVALID: { status: 409, extras: ['opIndex', 'current'], message: 'A tab change could not be applied.' },
  REVISION_MISMATCH: { status: 412, extras: ['current'], message: 'The tabs changed. Reload and try again.' },
  QUERY_TOO_SHORT: { status: 400, extras: [], message: 'Type at least two characters.' },
  UPLOAD_NOT_FOUND: { status: 404, extras: [], message: 'That upload is not known.' },
  UPLOAD_NOT_READY: { status: 409, extras: [], message: 'That upload is not finished.' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, extras: [], message: 'That file type is not supported.' },
  UPLOAD_TOO_LARGE: { status: 413, extras: [], message: 'That file is too large.' },
  UPLOAD_QUOTA_EXCEEDED: { status: 413, extras: ['quotaBytes', 'usedBytes'], message: 'The upload space for this iPhone is full.' },
  UPLOAD_OFFSET_MISMATCH: { status: 409, extras: ['receivedBytes'], message: 'The upload resumed at the wrong place.' },
  UPLOAD_OVERFLOW: { status: 400, extras: [], message: 'The upload is larger than announced.' },
  UPLOAD_INCOMPLETE: { status: 409, extras: [], message: 'The upload is not complete.' },
  UPLOAD_CHECKSUM_MISMATCH: { status: 422, extras: [], message: 'The upload checksum does not match.' },
  UPLOAD_IN_USE: { status: 409, extras: [], message: 'That upload is attached to a message.' },
  ACCOUNT_NOT_FOUND: { status: 404, extras: [], message: 'That account is not known.' },
  ACCOUNT_NOT_SWAPPABLE: { status: 409, extras: [], message: 'That account cannot be switched to.' },
  CODEX_RUNNING: { status: 409, extras: ['processes'], message: 'Codex is running.' },
  SWAPS_PAUSED: { status: 409, extras: ['reason'], message: 'Switching is paused.' },
  SWAP_IN_PROGRESS: { status: 409, extras: [], message: 'A switch is already in progress.' },
  SWAP_REFUSED: { status: 409, extras: ['retryAfterMs'], message: 'The switch was refused.' },
  SWAP_TIMEOUT: { status: 504, extras: [], message: 'The switch timed out.' },
  SWAP_FAILED: { status: 502, extras: [], message: 'The switch failed.' },
  GLASS_UNAVAILABLE: { status: 503, extras: [], message: 'Myrlin Glass is not available on this computer.' },
  LOGIN_FLOW_NOT_FOUND: { status: 404, extras: [], message: 'That sign in is not known.' },
  LOGIN_IN_PROGRESS: { status: 409, extras: ['flowId'], message: 'A sign in is already running.' },
  LOGIN_CANCEL_UNSUPPORTED: { status: 409, extras: [], message: 'That sign in cannot be cancelled from the phone.' },
  LOGIN_TOO_LATE: { status: 409, extras: [], message: 'That sign in already finished.' },
  MIGRATION_NOT_FOUND: { status: 404, extras: [], message: 'That migration is not known.' },
  MIGRATION_ACTIVE: { status: 409, extras: [], message: 'A migration is already running for this session.' },
  SOURCE_BUSY: { status: 409, extras: [], message: 'The session is busy.' },
  COST_CONFIRM_REQUIRED: { status: 409, extras: [], message: 'Confirm the cost to continue.' },
  INVALID_TARGET: { status: 422, extras: [], message: 'That target is not valid.' },
  ACCOUNT_NOT_READY: { status: 424, extras: [], message: 'The account is not ready.' },
  FORK_TOO_LARGE: { status: 413, extras: [], message: 'The session is too large to copy.' },
  DISK_FULL: { status: 507, extras: [], message: 'The disk is full.' },
  MIGRATION_NOT_AWAITING: { status: 409, extras: [], message: 'That migration is not waiting for approval.' },
  MIGRATION_NOT_RETRYABLE: { status: 409, extras: [], message: 'That migration cannot be retried.' },
  MIGRATION_NOT_CANCELLABLE: { status: 409, extras: [], message: 'That migration cannot be cancelled.' },
  REPORT_NOT_READY: { status: 404, extras: [], message: 'The report is not ready.' },
  TURN_NOT_FOUND: { status: 404, extras: [], message: 'That turn is not known.' },
  PORT_IN_USE: { status: 409, extras: [], message: 'Another program already uses that port.' },
  LISTENER_OFF: { status: 409, extras: [], message: 'The phone connection is off on this computer.' },
  INVALID_APNS_KEY: { status: 400, extras: [], message: 'That APNs key could not be loaded.' },
  PUSH_NOT_REGISTERED: { status: 409, extras: [], message: 'This iPhone has not registered for notifications.' },
  PUSH_NOT_CONFIGURED: { status: 503, extras: [], message: 'Notifications need an APNs key on this computer.' },
  APNS_ERROR: { status: 502, extras: ['reason'], message: 'Apple refused the notification.' },
};

/**
 * An error that carries its HTTP status, protocol code and extra fields, so a
 * route can throw and the router turns it into the protocol body.
 */
class MobileError extends Error {
  /**
   * @param {number} status - HTTP status.
   * @param {string} code - UPPER_SNAKE code from the catalog.
   * @param {string} [message] - Sentence a person can read; defaults to the catalog's.
   * @param {object} [extra] - Extra body fields (section 13), e.g. {field} or {retryAfterMs}.
   */
  constructor(status, code, message, extra) {
    const entry = CODES[code];
    super(message || (entry && entry.message) || 'Something went wrong on this computer.');
    this.name = 'MobileError';
    this.status = status || (entry && entry.status) || 500;
    this.code = code;
    this.extra = extra || {};
  }
}

/**
 * Build a MobileError from the catalog, with the catalog's status.
 *
 * @param {string} code - Catalog code.
 * @param {string} [message] - Optional sentence.
 * @param {object} [extra] - Optional extra fields.
 * @returns {MobileError}
 */
function fail(code, message, extra) {
  const entry = CODES[code];
  return new MobileError(entry ? entry.status : 500, code, message, extra);
}

/**
 * Set the headers every mobile listener response carries.
 *
 * @param {object} res - http.ServerResponse or Express response.
 */
function setProtocolHeaders(res) {
  if (res.headersSent) return;
  res.setHeader(API_HEADER, API_HEADER_VALUE);
}

/**
 * Write a JSON response with no-store caching.
 *
 * @param {object} res - http.ServerResponse or Express response.
 * @param {number} status - HTTP status.
 * @param {object} body - JSON body.
 * @param {object} [headers] - Extra headers.
 */
function sendJson(res, status, body, headers) {
  if (res.headersSent || res.writableEnded) return;
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (headers) {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  }
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

/**
 * Write an empty response (204 and similar).
 *
 * @param {object} res - Response.
 * @param {number} [status=204] - HTTP status.
 */
function sendEmpty(res, status) {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = status || 204;
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

/**
 * Build the error body for a code: {error, code} plus only the extras the
 * catalog allows for that code (section 0.4). Unknown extras are dropped.
 *
 * @param {string} code - Catalog code.
 * @param {string} message - Sentence.
 * @param {object} [extra] - Candidate extra fields.
 * @returns {object} The body.
 */
function errorBody(code, message, extra) {
  const entry = CODES[code];
  const body = { error: message || (entry && entry.message) || 'Something went wrong on this computer.', code };
  const allowed = entry ? entry.extras : Object.keys(extra || {});
  for (const key of allowed) {
    if (extra && extra[key] !== undefined) body[key] = extra[key];
  }
  return body;
}

/**
 * Send a protocol error: status, body of section 0.4, and Retry-After in whole
 * seconds when the body carries retryAfterMs (429 and 503, section 0.5).
 *
 * @param {object} res - Response.
 * @param {number} status - HTTP status.
 * @param {string} code - Catalog code.
 * @param {string} [message] - Sentence.
 * @param {object} [extra] - Extra fields.
 */
function send(res, status, code, message, extra) {
  const body = errorBody(code, message, extra);
  const headers = {};
  if (typeof body.retryAfterMs === 'number') {
    headers['Retry-After'] = String(Math.max(1, Math.ceil(body.retryAfterMs / MS_PER_SECOND)));
  }
  sendJson(res, status, body, headers);
}

/**
 * Send a MobileError (or any thrown value) as its protocol body. A value that
 * is not a MobileError becomes 500 INTERNAL, and only its message is logged.
 *
 * @param {object} res - Response.
 * @param {*} err - Thrown value.
 * @param {Function} [log] - Logger for unexpected errors.
 */
function sendThrown(res, err, log) {
  if (err instanceof MobileError || (err && err.name === 'MobileError' && err.code)) {
    send(res, err.status, err.code, err.message, err.extra);
    return;
  }
  if (log) log('[mobile] internal error: ' + ((err && err.message) || String(err)));
  send(res, 500, 'INTERNAL');
}

module.exports = {
  API_VERSION,
  API_REVISION,
  API_HEADER,
  API_HEADER_VALUE,
  CODES,
  MobileError,
  fail,
  send,
  sendError: send,
  sendThrown,
  sendJson,
  sendEmpty,
  errorBody,
  setProtocolHeaders,
};
