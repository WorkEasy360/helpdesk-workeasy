import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { SignJWT, exportJWK, jwtVerify, type JWK } from 'jose';

/**
 * A stand-in for Workeasy360, built from Node's http module and jose keys, living in the
 * test process: discovery, the key set, a token endpoint that really verifies the client
 * assertion (private_key_jwt) and the PKCE verifier, and an entitlement endpoint with
 * scripted answers. The test plays the browser: it takes the authorization URL the app
 * redirected to, asks `authorize` for a code (the person signing in at Workeasy360), and
 * hands the code and state back to the app's callback.
 */

export interface Identity {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  givenName?: string;
  familyName?: string;
  organizationId: string;
  organizationName?: string;
}

/** Things a broken or hostile provider could get wrong in the ID token. */
export interface TokenTweaks {
  aud?: string | string[];
  iss?: string;
  productCode?: string;
  nonce?: string;
  /** Seconds relative to now. */
  expOffset?: number;
  iatOffset?: number;
  typ?: string;
  /** Claims to leave out. */
  omit?: string[];
  /** Sign with HS256 (using the public key as the secret) or send `alg: none`. */
  alg?: 'none' | 'HS256';
  /** Sign with a key the key set does not contain. */
  unknownKey?: boolean;
  extra?: Record<string, unknown>;
}

export interface AuthorizeOptions {
  tweak?: TokenTweaks;
  /** Answer for the identity's organization even when the app asked for another. */
  ignoreOrganizationHint?: boolean;
  /** Bind a different PKCE challenge than the one the app sent. */
  tamperChallenge?: boolean;
  /** Seconds the code lives (negative: already expired). */
  codeLifetimeSeconds?: number;
}

export type Authorization =
  | { ok: true; code: string; state: string; callbackUrl: string }
  | { ok: false; error: string; state: string; callbackUrl: string | null };

interface IssuedCode {
  code: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string;
  identity: Identity;
  expiresAt: number;
  used: boolean;
  tweak: TokenTweaks;
}

export interface EntitlementAnswer {
  decision: 'allow' | 'deny';
  reason: string;
  write_allowed?: boolean;
  revalidate_after?: number;
}

export interface EntitlementCall {
  organizationId: string;
  subject: string | undefined;
  write: string | undefined;
  assertionOk: boolean;
}

export interface TokenRequest {
  code: string;
  redirectUri: string;
  assertionOk: boolean;
  pkceOk: boolean;
  outcome: 'issued' | 'refused';
}

export const ALLOW: EntitlementAnswer = { decision: 'allow', reason: 'entitled', write_allowed: true, revalidate_after: 900 };

const sha256Base64Url = (value: string): string => createHash('sha256').update(value, 'ascii').digest('base64url');

export class FakeWorkeasy360 {
  readonly clientId = 'hd-client-id';
  readonly keyId = 'hd-key-1';
  productCode = 'easy_helpdesk';
  /** Redirect URIs registered for the client (exact string comparison, as the real one). */
  registeredRedirectUris: string[];
  /** The `kid` of the key the ID tokens are signed with. */
  signingKid = 'idp-key-1';

  readonly tokenRequests: TokenRequest[] = [];
  readonly entitlementCalls: EntitlementCall[] = [];
  readonly authorizationUrls: string[] = [];
  /** HTTP status the token endpoint answers with instead of working (an outage). */
  tokenEndpointFailure: number | null = null;
  /** HTTP status the entitlement endpoint answers with instead of working. */
  entitlementFailure: number | null = null;

  private server!: Server;
  private port = 0;
  private readonly codes = new Map<string, IssuedCode>();
  private readonly seenAssertions = new Set<string>();
  private signingKey!: KeyObject;
  private readonly jwks: JWK[] = [];
  private readonly organizationAnswers = new Map<string, EntitlementAnswer>();
  private readonly personAnswers = new Map<string, EntitlementAnswer>();

  private constructor(
    private readonly originalRedirectUri: string,
    private readonly appPublicKey: KeyObject,
  ) {
    this.registeredRedirectUris = [originalRedirectUri];
  }

  static async start(options: { redirectUri: string; appPublicKey: KeyObject }): Promise<FakeWorkeasy360> {
    const provider = new FakeWorkeasy360(options.redirectUri, options.appPublicKey);
    await provider.listen();
    return provider;
  }

  get issuer(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }

  /** Back to a clean slate between tests. */
  reset(): void {
    this.codes.clear();
    this.seenAssertions.clear();
    this.tokenRequests.length = 0;
    this.entitlementCalls.length = 0;
    this.authorizationUrls.length = 0;
    this.organizationAnswers.clear();
    this.personAnswers.clear();
    this.tokenEndpointFailure = null;
    this.entitlementFailure = null;
    this.productCode = 'easy_helpdesk';
    this.registeredRedirectUris = [this.originalRedirectUri];
  }

  // --- scripting the entitlement API ------------------------------------------

  setOrganizationAnswer(organizationId: string, answer: EntitlementAnswer | null): void {
    if (answer) this.organizationAnswers.set(organizationId, answer);
    else this.organizationAnswers.delete(organizationId);
  }

  setPersonAnswer(organizationId: string, subject: string, answer: EntitlementAnswer | null): void {
    const key = `${organizationId}|${subject}`;
    if (answer) this.personAnswers.set(key, answer);
    else this.personAnswers.delete(key);
  }

  callsFor(organizationId: string, subject?: string): EntitlementCall[] {
    return this.entitlementCalls.filter((call) => call.organizationId === organizationId && call.subject === subject);
  }

  // --- the browser's half: the person signing in ----------------------------

  /**
   * What Workeasy360's authorization endpoint does with the URL the app redirected to:
   * checks the request, and (the person having signed in) answers with a code and the
   * state, or with an OAuth error. Returns the URL the browser would be sent back to.
   */
  authorize(authorizationUrl: string, identity: Identity, options: AuthorizeOptions = {}): Authorization {
    this.authorizationUrls.push(authorizationUrl);
    const url = new URL(authorizationUrl);
    const params = url.searchParams;
    const state = params.get('state') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    const fail = (error: string, redirect = true): Authorization => ({
      ok: false,
      error,
      state,
      callbackUrl: redirect ? this.redirectTo(redirectUri, { error, state }) : null,
    });

    if (params.get('client_id') !== this.clientId) return fail('unauthorized_client', false);
    // Exact string comparison, as the real provider: a mismatch is never redirected to.
    if (!this.registeredRedirectUris.includes(redirectUri)) return fail('invalid_redirect_uri', false);
    if (params.get('response_type') !== 'code') return fail('unsupported_response_type');
    if (params.get('code_challenge_method') !== 'S256') return fail('invalid_request');
    if (!(params.get('scope') ?? '').split(' ').includes('openid')) return fail('invalid_scope');

    const hint = params.get('organization');
    if (hint && hint.toLowerCase() !== identity.organizationId.toLowerCase() && !options.ignoreOrganizationHint) {
      return fail('membership_inactive');
    }

    const code = randomUUID().replace(/-/g, '');
    this.codes.set(code, {
      code,
      clientId: this.clientId,
      redirectUri,
      challenge: options.tamperChallenge ? sha256Base64Url('someone-elses-verifier') : (params.get('code_challenge') ?? ''),
      nonce: params.get('nonce') ?? '',
      identity,
      expiresAt: Date.now() + (options.codeLifetimeSeconds ?? 60) * 1000,
      used: false,
      tweak: options.tweak ?? {},
    });
    return { ok: true, code, state, callbackUrl: this.redirectTo(redirectUri, { code, state }) };
  }

  /** A fresh code for an already-issued one's identity but a new authorization request (reuse tests). */
  codeIssuedFor(code: string): IssuedCode | undefined {
    return this.codes.get(code);
  }

  private redirectTo(redirectUri: string, params: Record<string, string>): string {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  // --- HTTP ---------------------------------------------------------------------

  private async listen(): Promise<void> {
    const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.signingKey = signing.privateKey;
    this.jwks.push({ ...(await exportJWK(signing.publicKey)), kid: this.signingKid, alg: 'RS256', use: 'sig' });

    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'server_error', detail: String(error) }));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  }

  private async readForm(req: IncomingMessage): Promise<URLSearchParams> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', this.issuer).pathname;
    if (req.method === 'GET' && path === '/.well-known/openid-configuration') {
      return this.json(res, 200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        end_session_endpoint: `${this.issuer}/logout`,
        workeasy360_entitlement_endpoint: `${this.issuer}/entitlements`,
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (req.method === 'GET' && path === '/jwks') {
      return this.json(res, 200, { keys: this.jwks });
    }
    if (req.method === 'POST' && path === '/token') {
      return this.token(await this.readForm(req), res);
    }
    if (req.method === 'POST' && path === '/entitlements') {
      return this.entitlement(await this.readForm(req), res);
    }
    return this.json(res, 404, { error: 'not_found' });
  }

  /** private_key_jwt: signed by the app's key, iss = sub = client id, aud = the token endpoint, single use. */
  private async verifyAssertion(form: URLSearchParams): Promise<boolean> {
    const assertion = form.get('client_assertion');
    if (form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' || !assertion) {
      return false;
    }
    try {
      const { payload, protectedHeader } = await jwtVerify(assertion, this.appPublicKey, {
        issuer: this.clientId,
        subject: this.clientId,
        audience: `${this.issuer}/token`,
        algorithms: ['RS256', 'ES256'],
        requiredClaims: ['jti', 'iat', 'exp'],
      });
      if (protectedHeader.kid !== this.keyId) return false;
      if ((payload.exp ?? 0) - (payload.iat ?? 0) > 60) return false;
      const jti = String(payload.jti);
      if (this.seenAssertions.has(jti)) return false;
      this.seenAssertions.add(jti);
      return true;
    } catch {
      return false;
    }
  }

  private async token(form: URLSearchParams, res: ServerResponse): Promise<void> {
    if (this.tokenEndpointFailure) return this.json(res, this.tokenEndpointFailure, { error: 'temporarily_unavailable' });
    const assertionOk = await this.verifyAssertion(form);
    const code = form.get('code') ?? '';
    const redirectUri = form.get('redirect_uri') ?? '';
    const issued = this.codes.get(code);
    const record: TokenRequest = { code, redirectUri, assertionOk, pkceOk: false, outcome: 'refused' };
    this.tokenRequests.push(record);

    if (!assertionOk) return this.json(res, 401, { error: 'invalid_client' });
    if (form.get('grant_type') !== 'authorization_code') return this.json(res, 400, { error: 'unsupported_grant_type' });
    if (!issued || issued.used || issued.expiresAt < Date.now()) {
      if (issued) issued.used = true;
      return this.json(res, 400, { error: 'invalid_grant' });
    }
    issued.used = true;
    if (redirectUri !== issued.redirectUri || !this.registeredRedirectUris.includes(redirectUri)) {
      return this.json(res, 400, { error: 'invalid_grant' });
    }
    record.pkceOk = sha256Base64Url(form.get('code_verifier') ?? '') === issued.challenge;
    if (!record.pkceOk) return this.json(res, 400, { error: 'invalid_grant' });

    record.outcome = 'issued';
    return this.json(res, 200, {
      id_token: await this.mintIdToken(issued),
      access_token: randomUUID(),
      token_type: 'Bearer',
      expires_in: 300,
      scope: 'openid email profile organization',
    });
  }

  private async mintIdToken(issued: IssuedCode): Promise<string> {
    const { identity, tweak } = issued;
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: tweak.iss ?? this.issuer,
      sub: identity.sub,
      aud: tweak.aud ?? this.clientId,
      iat: now + (tweak.iatOffset ?? 0),
      exp: now + (tweak.expOffset ?? 300),
      jti: randomUUID(),
      typ: tweak.typ ?? 'id_token',
      nonce: tweak.nonce ?? issued.nonce,
      organization_id: identity.organizationId,
      organization_name: identity.organizationName,
      product_code: tweak.productCode ?? this.productCode,
      email: identity.email,
      email_verified: identity.emailVerified ?? true,
      name: identity.name,
      given_name: identity.givenName,
      family_name: identity.familyName,
      aal: 1,
      auth_time: now,
      ...tweak.extra,
    };
    for (const key of [...(tweak.omit ?? []), ...Object.keys(claims).filter((k) => claims[k] === undefined)]) {
      delete claims[key];
    }

    if (tweak.alg === 'none') {
      const header = Buffer.from(JSON.stringify({ alg: 'none', kid: this.signingKid })).toString('base64url');
      return `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
    }
    if (tweak.alg === 'HS256') {
      // The algorithm-confusion attack: sign with the PUBLIC key as an HMAC secret.
      const publicPem = createPublicKey(this.signingKey).export({ type: 'spki', format: 'pem' }).toString();
      return new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: this.signingKid }).sign(Buffer.from(publicPem));
    }
    if (tweak.unknownKey) {
      const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
      return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'not-in-the-key-set' }).sign(stranger.privateKey);
    }
    return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: this.signingKid }).sign(this.signingKey);
  }

  private async entitlement(form: URLSearchParams, res: ServerResponse): Promise<void> {
    const assertionOk = await this.verifyAssertion(form);
    const organizationId = form.get('organization_id') ?? '';
    const subject = form.get('subject') ?? undefined;
    this.entitlementCalls.push({ organizationId, subject, write: form.get('write') ?? undefined, assertionOk });

    if (!assertionOk) return this.json(res, 401, { error: 'invalid_client' });
    if (this.entitlementFailure) {
      return this.json(res, this.entitlementFailure, { error: this.entitlementFailure === 503 ? 'temporarily_unavailable' : 'forbidden' });
    }

    const personal = subject ? this.personAnswers.get(`${organizationId}|${subject}`) : undefined;
    const answer = this.organizationAnswers.get(organizationId);
    // The organization's answer first; only an allowed organization is asked about the person.
    const chosen = answer && answer.decision === 'deny' ? answer : (personal ?? answer ?? ALLOW);
    return this.json(res, 200, {
      decision: chosen.decision,
      reason: chosen.reason,
      product_code: this.productCode,
      organization_id: organizationId,
      write_allowed: chosen.decision === 'allow' ? (chosen.write_allowed ?? true) : false,
      checked_at: new Date().toISOString(),
      revalidate_after: chosen.revalidate_after ?? 900,
    });
  }
}
