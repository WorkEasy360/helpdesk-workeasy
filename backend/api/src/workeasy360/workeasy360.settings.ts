import { Injectable } from '@nestjs/common';
import type { AuthMethods } from '@digisoft/shared';
import { readPrivateKeyPem } from '@digisoft/workeasy360';
import { AppConfig } from '../config/config.module';
import { AppError } from '../common/errors/app-error';

/**
 * What this deployment is configured to do about Workeasy360 sign-in. Pure configuration, no
 * network: it lives in the (global) auth module so password routes can ask whether they are
 * switched off without depending on the sign-in module that builds on them.
 */
@Injectable()
export class Workeasy360Settings {
  constructor(private readonly config: AppConfig) {}

  get issuer(): string {
    return this.config.get('WORKEASY360_ISSUER') ?? '';
  }

  get clientId(): string {
    return this.config.get('WORKEASY360_CLIENT_ID') ?? '';
  }

  get redirectUri(): string {
    return this.config.get('WORKEASY360_REDIRECT_URI') ?? '';
  }

  get keyId(): string {
    return this.config.get('WORKEASY360_KEY_ID') ?? '';
  }

  get productCode(): string {
    return this.config.get('WORKEASY360_PRODUCT_CODE');
  }

  get scopes(): string[] {
    return this.config.get('WORKEASY360_SCOPES').split(/\s+/).filter(Boolean);
  }

  get postLogoutRedirectUri(): string {
    return this.config.get('WORKEASY360_POST_LOGOUT_REDIRECT_URI') ?? '';
  }

  /** The system role a person joining an existing organization gets (never SUPER_ADMIN). */
  get defaultRole(): 'ADMIN' | 'AGENT' | 'LIGHT_AGENT' {
    return this.config.get('WORKEASY360_DEFAULT_ROLE');
  }

  /** Workeasy360 is the only way agents sign in. */
  get ssoOnly(): boolean {
    return this.config.get('WORKEASY360_SSO_ONLY');
  }

  /** Everything a sign-in needs is present (says nothing about whether the provider is reachable). */
  get configured(): boolean {
    return Boolean(
      this.issuer &&
        this.clientId &&
        this.redirectUri &&
        this.keyId &&
        (this.config.get('WORKEASY360_PRIVATE_KEY') || this.config.get('WORKEASY360_PRIVATE_KEY_FILE')),
    );
  }

  get signOutAvailable(): boolean {
    return this.configured && Boolean(this.postLogoutRedirectUri);
  }

  privateKeyPem(): string {
    return readPrivateKeyPem({
      file: this.config.get('WORKEASY360_PRIVATE_KEY_FILE'),
      inline: this.config.get('WORKEASY360_PRIVATE_KEY'),
    });
  }

  methods(): AuthMethods {
    return {
      password: !this.ssoOnly,
      workeasy360: this.configured,
      workeasy360SignOut: this.signOutAvailable,
    };
  }

  /** Password sign-in, registration, reset, change and invitations are all one switch. */
  assertPasswordSignInAllowed(): void {
    if (this.ssoOnly) {
      throw AppError.forbidden(
        'Password sign-in is turned off. Sign in with Workeasy360.',
        'PASSWORD_SIGN_IN_DISABLED',
      );
    }
  }
}
