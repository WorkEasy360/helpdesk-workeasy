import request from 'supertest';
import type { Server } from 'node:http';
import { apiPath, createHarness, resetDatabase, type Harness } from './app.harness';

const ORG = {
  organizationName: 'Auth Test Co',
  organizationSlug: 'auth-test',
  firstName: 'Ada',
  lastName: 'Admin',
  email: 'ada@auth-test.example',
  password: 'Str0ngPassword1',
};

describe('Authentication (e2e)', () => {
  let harness: Harness;
  let http: Server;

  beforeAll(async () => {
    harness = await createHarness();
    http = harness.app.getHttpServer() as Server;
  });

  beforeEach(async () => {
    await resetDatabase(harness.prisma);
  });

  afterAll(async () => {
    await harness.close();
  });

  const register = () => request(http).post(apiPath('/auth/register')).send(ORG);

  it('provisions an organization, its system roles and a super admin on registration', async () => {
    const response = await register().expect(201);

    expect(response.body.success).toBe(true);
    expect(response.body.data.user.email).toBe(ORG.email);
    expect(response.body.data.user.roles).toEqual(['SUPER_ADMIN']);
    expect(response.body.data.accessToken).toEqual(expect.any(String));

    const roles = await harness.prisma.role.findMany({ select: { systemKey: true } });
    expect(roles.map((r) => r.systemKey).sort()).toEqual([
      'ADMIN',
      'AGENT',
      'CUSTOMER',
      'LIGHT_AGENT',
      'SUPER_ADMIN',
    ]);

    // A default department and business hours make the organization immediately usable.
    expect(await harness.prisma.department.count({ where: { isDefault: true } })).toBe(1);
    expect(await harness.prisma.businessHours.count({ where: { isDefault: true } })).toBe(1);
  });

  it('never stores the password in recoverable form', async () => {
    await register().expect(201);
    const user = await harness.prisma.user.findFirstOrThrow({ select: { passwordHash: true } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toContain(ORG.password);
  });

  it('rejects a duplicate organization address', async () => {
    await register().expect(201);
    const response = await request(http)
      .post(apiPath('/auth/register'))
      .send({ ...ORG, email: 'other@auth-test.example' })
      .expect(409);
    expect(response.body.error.code).toBe('CONFLICT');
  });

  it('rejects a weak password before any record is written', async () => {
    const response = await request(http)
      .post(apiPath('/auth/register'))
      .send({ ...ORG, password: 'short' })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(await harness.prisma.organization.count()).toBe(0);
  });

  describe('once registered', () => {
    beforeEach(async () => {
      await register().expect(201);
    });

    it('signs in with the right password and sets an http-only refresh cookie', async () => {
      const response = await request(http)
        .post(apiPath('/auth/login'))
        .send({ email: ORG.email, password: ORG.password })
        .expect(200);

      expect(response.body.data.user.permissions).toContain('contact.read');

      const cookie = (response.headers['set-cookie'] as unknown as string[])[0];
      expect(cookie).toContain('ds_refresh=');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      // The refresh cookie is scoped to the auth routes, not the whole API.
      expect(cookie).toContain('Path=/api/v1/auth');
    });

    it('gives the same answer for a wrong password and an unknown address', async () => {
      const wrongPassword = await request(http)
        .post(apiPath('/auth/login'))
        .send({ email: ORG.email, password: 'Wr0ngPassword1' })
        .expect(401);
      const unknownUser = await request(http)
        .post(apiPath('/auth/login'))
        .send({ email: 'nobody@auth-test.example', password: 'Wr0ngPassword1' })
        .expect(401);

      expect(wrongPassword.body.error).toEqual(unknownUser.body.error);
      expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('rotates the refresh token and revokes the family when a used token is replayed', async () => {
      const login = await request(http)
        .post(apiPath('/auth/login'))
        .send({ email: ORG.email, password: ORG.password })
        .expect(200);
      const firstCookie = (login.headers['set-cookie'] as unknown as string[])[0] as string;

      const refreshed = await request(http)
        .post(apiPath('/auth/refresh'))
        .set('Cookie', firstCookie)
        .expect(200);
      const secondCookie = (refreshed.headers['set-cookie'] as unknown as string[])[0] as string;
      expect(secondCookie).not.toEqual(firstCookie);

      const replay = await request(http)
        .post(apiPath('/auth/refresh'))
        .set('Cookie', firstCookie)
        .expect(401);
      expect(replay.body.error.code).toBe('TOKEN_EXPIRED');

      // The whole family is dropped, so the rotated token is dead too.
      await request(http).post(apiPath('/auth/refresh')).set('Cookie', secondCookie).expect(401);
    });

    it('answers forgot-password identically for known and unknown addresses', async () => {
      const known = await request(http)
        .post(apiPath('/auth/forgot-password'))
        .send({ email: ORG.email })
        .expect(200);
      const unknown = await request(http)
        .post(apiPath('/auth/forgot-password'))
        .send({ email: 'ghost@auth-test.example' })
        .expect(200);

      expect(known.body).toEqual(unknown.body);
      expect(await harness.prisma.verificationToken.count({ where: { type: 'PASSWORD_RESET' } })).toBe(1);
    });

    it('rejects an unknown, tampered or missing access token', async () => {
      const login = await request(http)
        .post(apiPath('/auth/login'))
        .send({ email: ORG.email, password: ORG.password })
        .expect(200);
      const token = login.body.data.accessToken as string;

      await request(http).get(apiPath('/auth/me')).expect(401);
      await request(http).get(apiPath('/auth/me')).set('Authorization', `Bearer ${token}x`).expect(401);
      await request(http).get(apiPath('/auth/me')).set('Authorization', `Bearer ${token}`).expect(200);
    });

    it('lets a signed-in user edit their own profile, and nothing else, with PATCH /auth/me', async () => {
      const login = await request(http)
        .post(apiPath('/auth/login'))
        .send({ email: ORG.email, password: ORG.password })
        .expect(200);
      const bearer = { Authorization: `Bearer ${login.body.data.accessToken as string}` };

      const updated = await request(http)
        .patch(apiPath('/auth/me'))
        .set(bearer)
        .send({ firstName: 'Augusta', phone: '+44 20 7946 0000', email: 'hijack@example.com' })
        .expect(200);
      expect(updated.body.data).toMatchObject({ firstName: 'Augusta', lastName: ORG.lastName, email: ORG.email });

      const me = await request(http).get(apiPath('/auth/me')).set(bearer).expect(200);
      expect(me.body.data.firstName).toBe('Augusta');
      const stored = await harness.prisma.user.findFirstOrThrow({ select: { email: true, phone: true } });
      expect(stored).toEqual({ email: ORG.email, phone: '+44 20 7946 0000' });

      await request(http).patch(apiPath('/auth/me')).set(bearer).send({ firstName: '' }).expect(400);
      await request(http).patch(apiPath('/auth/me')).send({ firstName: 'Nobody' }).expect(401);
    });

    it('revokes every session when the password is changed', async () => {
      const login = await request(http)
        .post(apiPath('/auth/login'))
        .send({ email: ORG.email, password: ORG.password })
        .expect(200);
      const cookie = (login.headers['set-cookie'] as unknown as string[])[0] as string;

      await request(http)
        .post(apiPath('/auth/change-password'))
        .set('Authorization', `Bearer ${login.body.data.accessToken}`)
        .send({ currentPassword: ORG.password, newPassword: 'An0therPassword2' })
        .expect(200);

      await request(http).post(apiPath('/auth/refresh')).set('Cookie', cookie).expect(401);
      await request(http)
        .post(apiPath('/auth/login'))
        .send({ email: ORG.email, password: ORG.password })
        .expect(401);
      await request(http)
        .post(apiPath('/auth/login'))
        .send({ email: ORG.email, password: 'An0therPassword2' })
        .expect(200);
    });
  });

  describe('when the same address is registered in more than one organization', () => {
    const OTHER_ORG = {
      organizationName: 'Second Auth Test Co',
      organizationSlug: 'auth-test-second',
      firstName: 'Beth',
      lastName: 'Admin',
      email: ORG.email,
      // The same password in both: only then is the address genuinely ambiguous.
      password: ORG.password,
    };

    beforeEach(async () => {
      await register().expect(201);
      await request(http).post(apiPath('/auth/register')).send(OTHER_ORG).expect(201);
    });

    it('asks which organization to sign into instead of starting a session', async () => {
      const response = await request(http)
        .post(apiPath('/auth/login'))
        .send({ email: ORG.email, password: ORG.password })
        .expect(200);

      expect(response.body.data).toEqual({
        status: 'choose_organization',
        organizations: [
          { slug: ORG.organizationSlug, name: ORG.organizationName },
          { slug: OTHER_ORG.organizationSlug, name: OTHER_ORG.organizationName },
        ],
      });
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('completes sign-in once the chosen organization is resubmitted', async () => {
      const response = await request(http)
        .post(apiPath('/auth/login'))
        .send({ email: ORG.email, password: ORG.password, organizationSlug: ORG.organizationSlug })
        .expect(200);

      expect(response.body.data.status).toBe('authenticated');
      expect(response.body.data.user.email).toBe(ORG.email);
      const cookie = (response.headers['set-cookie'] as unknown as string[])[0];
      expect(cookie).toContain('ds_refresh=');
    });

    it('signs straight in when the password matches only one of the accounts', async () => {
      const second = await request(http)
        .post(apiPath('/auth/login'))
        .send({ email: ORG.email, password: ORG.password, organizationSlug: OTHER_ORG.organizationSlug })
        .expect(200);
      await request(http)
        .post(apiPath('/auth/change-password'))
        .set('Authorization', `Bearer ${second.body.data.accessToken as string}`)
        .send({ currentPassword: ORG.password, newPassword: 'An0therPassword2' })
        .expect(200);

      const response = await request(http)
        .post(apiPath('/auth/login'))
        .send({ email: ORG.email, password: ORG.password })
        .expect(200);
      expect(response.body.data.status).toBe('authenticated');
      expect(response.body.data.user.firstName).toBe(ORG.firstName);
    });

    it('gives the same generic answer for a wrong password whether the address is shared or not', async () => {
      const shared = await request(http)
        .post(apiPath('/auth/login'))
        .send({ email: ORG.email, password: 'Wr0ngPassword1' })
        .expect(401);
      const single = await request(http)
        .post(apiPath('/auth/login'))
        .send({ email: 'nobody@auth-test.example', password: 'Wr0ngPassword1' })
        .expect(401);

      expect(shared.body.error).toEqual(single.body.error);
      expect(shared.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(shared.headers['set-cookie']).toBeUndefined();
    });
  });
});
