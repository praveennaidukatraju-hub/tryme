import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sendReportReceivedEmail } from '../../src/lib/mailer.js';
import { createSessionTokens } from '../../src/modules/auth/tokens.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

// Only sendReportReceivedEmail is mocked (real module otherwise) — these
// routes call it fire-and-forget (logged on failure, never blocking the
// ticket/contact submission itself), same convention as the other mailer
// integration tests in this suite.
vi.mock('../../src/lib/mailer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/mailer.js')>();
  return { ...actual, sendReportReceivedEmail: vi.fn().mockResolvedValue(undefined) };
});

let ctx: Containers;
let app: TestApp;

async function createVerifiedUser(email: string) {
  const [user] = await app.db
    .insert(schema.users)
    .values({ email, emailVerified: true, tier: 'free' })
    .returning({ id: schema.users.id });
  if (!user) throw new Error('user not found');
  const reply = {
    setCookie() {},
    code() {
      return reply;
    },
  } as const;
  const { accessToken } = await createSessionTokens(app, user.id, reply as never, 200);
  return accessToken;
}

beforeAll(async () => {
  ctx = await startContainers();
  app = await buildTestApp(ctx);
});

afterAll(async () => {
  await app.close();
  await ctx.stop();
});

describe('report-received acknowledgment email', () => {
  it("POST /v1/support sends the acknowledgment to the authenticated user's email", async () => {
    vi.mocked(sendReportReceivedEmail).mockClear();
    const accessToken = await createVerifiedUser('support-ticket@example.com');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { message: 'Something is broken' },
    });

    expect(res.statusCode).toBe(200);
    expect(sendReportReceivedEmail).toHaveBeenCalledTimes(1);
    expect(sendReportReceivedEmail).toHaveBeenCalledWith(
      app.env.RESEND_API_KEY,
      app.env.EMAIL_FROM,
      'support-ticket@example.com',
    );
  });

  it('POST /v1/contact sends the acknowledgment to the submitted email', async () => {
    vi.mocked(sendReportReceivedEmail).mockClear();
    const accessToken = await createVerifiedUser('contact-form-user@example.com');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/contact',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        name: 'Jamie Doe',
        email: 'contact-submitted@example.com',
        phone: '9999999999',
        message: 'A complaint about generation quality',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(sendReportReceivedEmail).toHaveBeenCalledTimes(1);
    expect(sendReportReceivedEmail).toHaveBeenCalledWith(
      app.env.RESEND_API_KEY,
      app.env.EMAIL_FROM,
      'contact-submitted@example.com',
    );
  });

  it('a failed send does not fail the support ticket submission', async () => {
    vi.mocked(sendReportReceivedEmail).mockClear();
    vi.mocked(sendReportReceivedEmail).mockRejectedValueOnce(new Error('Resend unreachable'));
    const accessToken = await createVerifiedUser('resend-down@example.com');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { message: 'Still works even if email fails' },
    });

    expect(res.statusCode).toBe(200);
  });
});
