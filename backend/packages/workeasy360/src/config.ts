import { readFileSync } from 'node:fs';

/** A PEM pasted into a one-line environment variable usually arrives with literal backslash-n sequences. */
const ESCAPED_NEWLINE = String.fromCharCode(92) + 'n';

/** The private key: from a file when one is named, else inline (literal backslash-n allowed). */
export function readPrivateKeyPem(source: { file?: string | undefined; inline?: string | undefined }): string {
  if (source.file) return readFileSync(source.file, 'utf8');
  return (source.inline ?? '').split(ESCAPED_NEWLINE).join('\n');
}

/** Everything a client needs for the entitlement API is present (it says nothing about reachability). */
export function hasClientCredentials(env: {
  WORKEASY360_ISSUER?: string | undefined;
  WORKEASY360_CLIENT_ID?: string | undefined;
  WORKEASY360_KEY_ID?: string | undefined;
  WORKEASY360_PRIVATE_KEY?: string | undefined;
  WORKEASY360_PRIVATE_KEY_FILE?: string | undefined;
}): boolean {
  return Boolean(
    env.WORKEASY360_ISSUER &&
      env.WORKEASY360_CLIENT_ID &&
      env.WORKEASY360_KEY_ID &&
      (env.WORKEASY360_PRIVATE_KEY || env.WORKEASY360_PRIVATE_KEY_FILE),
  );
}
