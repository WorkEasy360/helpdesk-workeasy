import request from 'supertest';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { apiPath, createHarness, registerOrg, resetDatabase, type Harness } from './app.harness';

describe('Attachments (e2e)', () => {
  let harness: Harness;
  let http: Server;
  let auth: { Authorization: string };
  let ticketId: string;
  let storageRoot: string;

  beforeAll(async () => {
    // A throwaway storage root, so the suite never writes into the working tree.
    storageRoot = await mkdtemp(path.join(tmpdir(), 'digisoft-attachments-'));
    process.env.STORAGE_PROVIDER = 'local';
    process.env.STORAGE_LOCAL_PATH = storageRoot;

    harness = await createHarness();
    http = harness.app.getHttpServer() as Server;
  });

  beforeEach(async () => {
    await resetDatabase(harness.prisma);
    const org = await registerOrg(http, 'files');
    auth = { Authorization: `Bearer ${org.token}` };

    const ticket = await request(http)
      .post(apiPath('/tickets'))
      .set(auth)
      .send({ subject: 'Crash report', description: 'Attaching the log.' })
      .expect(201);
    ticketId = ticket.body.data.id;
  });

  afterAll(async () => {
    await harness.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  const upload = (fileName: string, contentType: string, body: Buffer | string) =>
    request(http)
      .post(apiPath(`/tickets/${ticketId}/attachments`))
      .set(auth)
      .attach('file', Buffer.isBuffer(body) ? body : Buffer.from(body), {
        filename: fileName,
        contentType,
      });

  it('stores metadata in the database and the bytes in storage', async () => {
    const response = await upload('diagnostic.txt', 'text/plain', 'line one\nline two\n').expect(201);
    expect(response.body.data.fileName).toBe('diagnostic.txt');
    expect(response.body.data.fileSize).toBe(18);

    const row = await harness.prisma.attachment.findUniqueOrThrow({
      where: { id: response.body.data.id },
      select: { storageKey: true, organizationId: true, ticketId: true },
    });
    // The key is server-generated and namespaced by organization and ticket.
    expect(row.storageKey.startsWith(`${row.organizationId}/tickets/${row.ticketId}/`)).toBe(true);
  });

  it('serves the file back with headers that stop it executing in our origin', async () => {
    const uploaded = await upload('notes.txt', 'text/plain', 'hello world').expect(201);

    const download = await request(http)
      .get(apiPath(`/attachments/${uploaded.body.data.id}/download`))
      .set(auth)
      .expect(200);

    expect(download.text).toBe('hello world');
    expect(download.headers['content-disposition']).toContain('attachment;');
    expect(download.headers['content-security-policy']).toContain("default-src 'none'");
    expect(download.headers['x-content-type-options']).toBe('nosniff');
  });

  it('answers with a link instead of the bytes when asked for JSON', async () => {
    const uploaded = await upload('notes.txt', 'text/plain', 'hello world').expect(201);
    const path = apiPath(`/attachments/${uploaded.body.data.id}/download`);

    const byQuery = await request(http).get(path).query({ mode: 'url' }).set(auth).expect(200);
    // Local storage has nothing to sign: the link is the authenticated streaming route.
    expect(byQuery.body.data).toEqual({
      url: path,
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      fileSize: 11,
      expiresAt: null,
      direct: false,
    });
    expect(byQuery.headers['cache-control']).toBe('no-store');

    const byAccept = await request(http).get(path).set(auth).set('Accept', 'application/json').expect(200);
    expect(byAccept.body.data.url).toBe(path);

    // The link is still authorised like the download itself.
    const intruder = await registerOrg(http, 'link-nosy');
    await request(http)
      .get(path)
      .query({ mode: 'url' })
      .set({ Authorization: `Bearer ${intruder.token}` })
      .expect(404);
  });

  it('refuses a file type that is not on the allowlist', async () => {
    const response = await upload('payload.exe', 'application/x-msdownload', 'MZ').expect(415);
    expect(response.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(await harness.prisma.attachment.count()).toBe(0);
  });

  it('refuses an empty file', async () => {
    await upload('empty.txt', 'text/plain', '').expect(400);
  });

  it('neutralises a traversal attempt in the filename', async () => {
    const response = await upload('../../../../etc/passwd', 'text/plain', 'root:x:0:0').expect(201);
    expect(response.body.data.fileName).toBe('passwd');

    const row = await harness.prisma.attachment.findUniqueOrThrow({
      where: { id: response.body.data.id },
      select: { storageKey: true },
    });
    expect(row.storageKey).not.toContain('..');
  });

  it('attaches an upload to a reply', async () => {
    const uploaded = await upload('trace.txt', 'text/plain', 'stack trace').expect(201);

    const message = await request(http)
      .post(apiPath(`/tickets/${ticketId}/messages`))
      .set(auth)
      .send({ bodyText: 'Log attached.', attachmentIds: [uploaded.body.data.id] })
      .expect(201);
    expect(message.body.data.attachments).toHaveLength(1);

    // The same upload cannot be re-used on a second message.
    await request(http)
      .post(apiPath(`/tickets/${ticketId}/messages`))
      .set(auth)
      .send({ bodyText: 'Again', attachmentIds: [uploaded.body.data.id] })
      .expect(400);
  });

  it('deletes the row and the stored object together', async () => {
    const uploaded = await upload('temp.txt', 'text/plain', 'delete me').expect(201);
    await request(http)
      .delete(apiPath(`/attachments/${uploaded.body.data.id}`))
      .set(auth)
      .expect(200);

    expect(await harness.prisma.attachment.count()).toBe(0);
    await request(http)
      .get(apiPath(`/attachments/${uploaded.body.data.id}/download`))
      .set(auth)
      .expect(404);
  });

  it('never serves an attachment to another organization', async () => {
    const uploaded = await upload('private.txt', 'text/plain', 'confidential').expect(201);

    const intruder = await registerOrg(http, 'nosy');
    const intruderAuth = { Authorization: `Bearer ${intruder.token}` };

    await request(http)
      .get(apiPath(`/attachments/${uploaded.body.data.id}/download`))
      .set(intruderAuth)
      .expect(404);
    await request(http)
      .get(apiPath(`/tickets/${ticketId}/attachments`))
      .set(intruderAuth)
      .expect(404);
    await request(http)
      .delete(apiPath(`/attachments/${uploaded.body.data.id}`))
      .set(intruderAuth)
      .expect(404);
  });
});
