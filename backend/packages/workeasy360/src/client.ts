import {
  createHash,
  createPrivateKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import {
  SignJWT,
  createLocalJWKSet,
  errors as joseErrors,
  jwtVerify,
  type FlattenedJWSInput,
  type JSONWebKeySet,
  type JWSHeaderParameters,
  type JWTPayload,
} from 'jose';
import { Workeasy360Error } from './errors';
import { fetchTransport, type Transport } from './transport';

/** How long discovery metadata and the key set are reused before a refetch. */
export const METADATA_TTL_SECONDS = 3600;
/** An unknown `kid` refreshes the key set once, but not more often than this. */
export const JWKS_REFRESH_COOLDOWN_SECONDS = 10;
/** Clock skew tolerated on exp / nbf / iat (the integration guide's +-30 s). */
export const LEEWAY_SECONDS = 30;
/** A client assertion is single-use and short-lived; the provider caps it. */
export const ASSERTION_LIFETIME_SECONDS = 60;
export const ID_TOKEN_ALGORITHMS = ['RS256', 'ES256'];
const REQUIRED_CLAIMS = ['iss', 'sub', 'aud', 'exp', 'iat', 'jti', 'typ'];
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

export interface Workeasy360ClientConfig {
  issuer: string;
  clientId: string;
  /** Needed for sign-in only; the entitlement API does not use it. */
  redirectUri?: string;
  keyId: string;
  privateKeyPem: string;
  scopes?: readonly string[];
  transport?: Transport;
  /** Milliseconds since the epoch; replaced in tests. */
  now?: () => number;
  /** Refuse discovery documents whose endpoints are not https (production). */
  requireHttps?: boolean;
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface EntitlementAnswer {
  decision: 'allow' | 'deny';
  reason: string;
  writeAllowed: boolean;
  /** Seconds the answer may be trusted, as advertised by the provider (default 900). */
  revalidateAfter: number;
}

export interface VerifiedIdToken extends JWTPayload {
  sub: string;
  organization_id: string;
  product_code?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  organization_name?: string;
}

interface Metadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  workeasy360_entitlement_endpoint?: string;
}

const base64Url = (raw: Buffer): string => raw.toString('base64url');

/** (code_verifier, S256 code_challenge). 43 characters of verifier. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier, 'ascii').digest());
  return { verifier, challenge };
}

/** Constant-time string comparison that does not leak the length either. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

/**
 * The Workeasy360 OpenID Connect client: authorization code + PKCE with `private_key_jwt`
 * client authentication, plus the entitlement API.
 *
 * Only the issuer is configured; every endpoint is learnt from the discovery document and
 * nothing a browser sent is ever fetched. The ID token is verified offline in the seven
 * steps of the product integration guide, each of which closes a named attack.
 */
export class Workeasy360Client {
  readonly issuer: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  private readonly redirectUri: string | undefined;
  private readonly keyId: string;
  private readonly privateKeyPem: string;
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly requireHttps: boolean;

  private metadata: Metadata | null = null;
  private metadataAt = 0;
  private metadataFlight: Promise<Metadata> | null = null;
  private jwks: JSONWebKeySet | null = null;
  private jwksAt = 0;
  private jwksFlight: Promise<JSONWebKeySet> | null = null;
  private signingKey: { key: KeyObject; alg: 'RS256' | 'ES256' } | null = null;

  constructor(config: Workeasy360ClientConfig) {
    this.issuer = config.issuer;
    this.clientId = config.clientId;
    this.redirectUri = config.redirectUri;
    this.keyId = config.keyId;
    this.privateKeyPem = config.privateKeyPem;
    this.scopes = config.scopes ?? ['openid', 'email', 'profile', 'organization'];
    this.transport = config.transport ?? fetchTransport();
    this.now = config.now ?? Date.now;
    this.requireHttps = config.requireHttps ?? false;
  }

  // --- discovery -----------------------------------------------------------

  async discover(): Promise<Metadata> {
    const fresh = this.metadata && this.now() - this.metadataAt < METADATA_TTL_SECONDS * 1000;
    if (this.metadata && fresh) return this.metadata;
    if (!this.metadataFlight) {
      this.metadataFlight = this.fetchMetadata().finally(() => {
        this.metadataFlight = null;
      });
    }
    return this.metadataFlight;
  }

  private async fetchMetadata(): Promise<Metadata> {
    const url = `${this.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const { status, body } = await this.transport('GET', url);
    if (status !== 200 || Object.keys(body).length === 0) {
      throw new Workeasy360Error('provider_unavailable', `discovery returned ${status}`);
    }
    // A document naming another issuer describes somebody else's authorization server.
    // Exact string equality, as OpenID Connect Core requires.
    if (body['issuer'] !== this.issuer) {
      throw new Workeasy360Error('provider_misconfigured', 'discovery names a different issuer');
    }
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      const value = body[key];
      if (typeof value !== 'string' || !isHttpUrl(value, this.requireHttps)) {
        throw new Workeasy360Error('provider_misconfigured', `discovery has no usable ${key}`);
      }
    }
    for (const key of ['end_session_endpoint', 'workeasy360_entitlement_endpoint']) {
      const value = body[key];
      if (value !== undefined && (typeof value !== 'string' || !isHttpUrl(value, this.requireHttps))) {
        throw new Workeasy360Error('provider_misconfigured', `discovery has an unusable ${key}`);
      }
    }
    this.metadata = body as unknown as Metadata;
    this.metadataAt = this.now();
    return this.metadata;
  }

  private async keySet(refresh: boolean): Promise<JSONWebKeySet> {
    const fresh = this.jwks && this.now() - this.jwksAt < METADATA_TTL_SECONDS * 1000;
    if (this.jwks && fresh && !refresh) return this.jwks;
    if (!this.jwksFlight) {
      this.jwksFlight = this.fetchKeySet().finally(() => {
        this.jwksFlight = null;
      });
    }
    return this.jwksFlight;
  }

  private async fetchKeySet(): Promise<JSONWebKeySet> {
    const { jwks_uri } = await this.discover();
    const { status, body } = await this.transport('GET', jwks_uri);
    if (status !== 200 || !Array.isArray(body['keys'])) {
      throw new Workeasy360Error('provider_unavailable', `key set returned ${status}`);
    }
    this.jwks = body as unknown as JSONWebKeySet;
    this.jwksAt = this.now();
    return this.jwks;
  }

  // --- the flow ------------------------------------------------------------

  async authorizationRequest(options: { organizationId?: string } = {}): Promise<AuthorizationRequest> {
    if (!this.redirectUri) {
      throw new Workeasy360Error('provider_misconfigured', 'no redirect URI is configured');
    }
    const state = base64Url(randomBytes(32));
    const nonce = base64Url(randomBytes(32));
    const { verifier, challenge } = pkcePair();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: this.scopes.join(' '),
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (options.organizationId) {
      // The launcher names the organization the person chose; without it the provider
      // shows its own organization chooser.
      params.set('organization', options.organizationId);
    }
    const { authorization_endpoint } = await this.discover();
    const separator = authorization_endpoint.includes('?') ? '&' : '?';
    return { url: `${authorization_endpoint}${separator}${params.toString()}`, state, nonce, codeVerifier: verifier };
  }

  /**
   * RP-initiated logout (OpenID Connect RP-Initiated Logout 1.0), or '' when the provider
   * advertises no `end_session_endpoint`. The provider asks the person to confirm, then
   * returns them to `postLogoutRedirectUri`, which must be registered for this client.
   */
  async endSessionUrl(postLogoutRedirectUri: string): Promise<string> {
    const { end_session_endpoint } = await this.discover();
    if (!end_session_endpoint) return '';
    const query = new URLSearchParams({
      client_id: this.clientId,
      post_logout_redirect_uri: postLogoutRedirectUri,
    });
    const separator = end_session_endpoint.includes('?') ? '&' : '?';
    return `${end_session_endpoint}${separator}${query.toString()}`;
  }

  /** RFC 7523 section 3: iss = sub = client id, aud = token endpoint. */
  async clientAssertion(): Promise<string> {
    const { token_endpoint } = await this.discover();
    const { key, alg } = this.loadSigningKey();
    const issuedAt = Math.floor(this.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg, kid: this.keyId })
      .setIssuer(this.clientId)
      .setSubject(this.clientId)
      .setAudience(token_endpoint)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ASSERTION_LIFETIME_SECONDS)
      .setJti(randomUUID())
      .sign(key);
  }

  /** RS256 for an RSA key, ES256 for a P-256 key: derived so the two cannot disagree. */
  private loadSigningKey(): { key: KeyObject; alg: 'RS256' | 'ES256' } {
    if (this.signingKey) return this.signingKey;
    let key: KeyObject;
    try {
      key = createPrivateKey(this.privateKeyPem);
    } catch {
      throw new Workeasy360Error('provider_misconfigured', 'the client private key is unreadable');
    }
    if (key.asymmetricKeyType === 'rsa') {
      this.signingKey = { key, alg: 'RS256' };
    } else if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1') {
      this.signingKey = { key, alg: 'ES256' };
    } else {
      throw new Workeasy360Error('provider_misconfigured', 'the client key must be RSA or EC P-256');
    }
    return this.signingKey;
  }

  /** Exchanges the code and returns the verified ID token's claims. */
  async complete(input: {
    code: string;
    returnedState: string;
    expectedState: string;
    nonce: string;
    codeVerifier: string;
  }): Promise<VerifiedIdToken> {
    // Constant-time: a callback whose state is not ours is not ours.
    if (!input.expectedState || !safeEqual(input.returnedState, input.expectedState)) {
      throw new Workeasy360Error('state_mismatch');
    }
    if (!input.code) {
      throw new Workeasy360Error('invalid_request', 'no code');
    }
    if (!this.redirectUri) {
      throw new Workeasy360Error('provider_misconfigured', 'no redirect URI is configured');
    }
    const { token_endpoint } = await this.discover();
    const { status, body } = await this.transport('POST', token_endpoint, {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: this.redirectUri,
      code_verifier: input.codeVerifier,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: await this.clientAssertion(),
    });
    if (status !== 200) {
      const error = typeof body['error'] === 'string' ? body['error'] : '';
      if (status === 429) throw new Workeasy360Error('rate_limited', `token endpoint ${status}`);
      if (status >= 500 || error === 'temporarily_unavailable') {
        throw new Workeasy360Error('provider_unavailable', `token endpoint ${status} ${error}`);
      }
      // invalid_grant is routine (expired code, membership changed since the redirect):
      // the person simply starts again.
      throw new Workeasy360Error('sign_in_refused', `token endpoint ${status} ${error}`);
    }
    const idToken = body['id_token'];
    if (typeof idToken !== 'string' || idToken.length === 0) {
      throw new Workeasy360Error('invalid_token', 'token response has no id_token');
    }
    return this.verifyIdToken(idToken, { nonce: input.nonce });
  }

  // --- ID token verification -------------------------------------------------

  async verifyIdToken(idToken: string, options: { nonce: string }): Promise<VerifiedIdToken> {
    const header = decodeHeader(idToken);
    const kid = header['kid'];
    if (typeof kid !== 'string' || kid.length === 0) {
      throw new Workeasy360Error('invalid_token', 'no kid');
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(
        idToken,
        // 1. The key comes from OUR cached key set, selected by kid. Unknown kid refreshes
        //    the set once (rotation), then fails.
        async (protectedHeader, token) => this.keyFor(protectedHeader, token),
        {
          // 2. Algorithms are an allow-list, never what the token header asks for: this is
          //    what stops an attacker presenting our public key as an HMAC secret, or `none`.
          algorithms: ID_TOKEN_ALGORITHMS,
          // 3. Audience confusion: a token minted for another product.
          audience: this.clientId,
          // 4. Token substitution from another issuer.
          issuer: this.issuer,
          // 5. exp / nbf with the guide's +-30 s.
          clockTolerance: LEEWAY_SECONDS,
          currentDate: new Date(this.now()),
          requiredClaims: REQUIRED_CLAIMS,
        },
      ));
    } catch (error) {
      if (error instanceof Workeasy360Error) throw error;
      const name = error instanceof Error ? error.name : 'Error';
      const code = error instanceof joseErrors.JOSEError ? error.code : name;
      throw new Workeasy360Error('invalid_token', `verification failed (${code})`);
    }

    const nowSeconds = Math.floor(this.now() / 1000);
    if (typeof payload.iat !== 'number' || payload.iat > nowSeconds + LEEWAY_SECONDS) {
      throw new Workeasy360Error('invalid_token', 'iat is in the future');
    }
    // 3b. The audience is exactly us: a token that is also addressed to another client (a
    //     multi-valued aud) is not an assertion meant for this product alone.
    const audience = payload.aud;
    const audiences = Array.isArray(audience) ? audience : [audience];
    if (audiences.length !== 1 || audiences[0] !== this.clientId) {
      throw new Workeasy360Error('invalid_token', 'aud is not exactly this client');
    }
    if (payload['azp'] !== undefined && payload['azp'] !== this.clientId) {
      throw new Workeasy360Error('invalid_token', 'azp is another client');
    }
    // 6. It must be an identity assertion, not an access token.
    if (payload['typ'] !== 'id_token') {
      throw new Workeasy360Error('invalid_token', 'typ is not id_token');
    }
    // 7. It must answer OUR request: the nonce is bound to this browser's flow.
    const returnedNonce = typeof payload['nonce'] === 'string' ? payload['nonce'] : '';
    if (!options.nonce || !safeEqual(returnedNonce, options.nonce)) {
      throw new Workeasy360Error('invalid_token', 'nonce mismatch');
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new Workeasy360Error('invalid_token', 'no sub');
    }
    const organizationId = payload['organization_id'];
    if (typeof organizationId !== 'string' || organizationId.length === 0) {
      throw new Workeasy360Error('invalid_token', 'no organization_id');
    }
    return payload as VerifiedIdToken;
  }

  private async keyFor(header: JWSHeaderParameters, token: FlattenedJWSInput) {
    let lastError: unknown;
    for (const refresh of [false, true]) {
      if (refresh && this.now() - this.jwksAt < JWKS_REFRESH_COOLDOWN_SECONDS * 1000) {
        // The set was fetched a moment ago: an unknown kid is not a rotation, and refreshing
        // for every garbage token would turn them into request amplification against the
        // provider.
        break;
      }
      const set = await this.keySet(refresh);
      try {
        return await createLocalJWKSet(set)(header, token);
      } catch (error) {
        if (!(error instanceof joseErrors.JWKSNoMatchingKey)) throw error;
        lastError = error;
      }
    }
    throw new Workeasy360Error(
      'invalid_token',
      `no key ${String(header.kid)} in the provider's key set${lastError ? '' : ' (refresh cooling down)'}`,
    );
  }

  // --- the entitlement API ---------------------------------------------------

  /**
   * Asks whether `organizationId` may still use this product (and, with `subject`, whether
   * this person may). There is no product parameter: the product is whoever the client
   * assertion proves this is.
   *
   * Anything that is not an answer throws: `provider_unavailable` / `rate_limited` for an
   * outage (never a denial; the caller keeps its last answer) and `provider_refused` when
   * the platform answered and refused this client (400/401/403).
   */
  async verifyEntitlement(
    organizationId: string,
    options: { subject?: string; write?: boolean } = {},
  ): Promise<EntitlementAnswer> {
    const { workeasy360_entitlement_endpoint: endpoint } = await this.discover();
    if (!endpoint) {
      throw new Workeasy360Error('provider_misconfigured', 'discovery has no workeasy360_entitlement_endpoint');
    }
    const form: Record<string, string> = {
      organization_id: organizationId,
      write: options.write ? 'true' : 'false',
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: await this.clientAssertion(),
    };
    if (options.subject) form['subject'] = options.subject;
    const { status, body } = await this.transport('POST', endpoint, form);
    const decision = body['decision'];
    if (status === 200 && (decision === 'allow' || decision === 'deny')) {
      const advertised = Number(body['revalidate_after']);
      return {
        decision,
        reason: typeof body['reason'] === 'string' ? body['reason'].slice(0, 64) : '',
        writeAllowed: decision === 'allow' && body['write_allowed'] === true,
        revalidateAfter: Number.isFinite(advertised) && advertised > 0 ? advertised : 900,
      };
    }
    const detail = `entitlement endpoint ${status}`;
    if (status === 400 || status === 401 || status === 403) {
      throw new Workeasy360Error('provider_refused', detail);
    }
    if (status === 429) {
      throw new Workeasy360Error('rate_limited', detail);
    }
    throw new Workeasy360Error('provider_unavailable', detail);
  }
}

function decodeHeader(token: string): Record<string, unknown> {
  const first = token.split('.')[0];
  if (!first || token.split('.').length !== 3) {
    throw new Workeasy360Error('invalid_token', 'not a compact JWS');
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(first, 'base64url').toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new Workeasy360Error('invalid_token', 'unreadable header');
}

function isHttpUrl(value: string, httpsOnly = false): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'https:' || (!httpsOnly && protocol === 'http:');
  } catch {
    return false;
  }
}
