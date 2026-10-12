/**
 * Fields the request logger removes. Credentials never reach the log stream; neither do the
 * Workeasy360 sign-in redirects, whose Location carries state, nonce and the PKCE challenge.
 */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'res.headers.location',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.token',
];
