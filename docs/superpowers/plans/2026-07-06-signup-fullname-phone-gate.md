# Signup Full Name + Phone Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require full name on signup while keeping post-verification onboarding gated only by missing phone number.

**Architecture:** The shared registration schema stays the source of truth for required signup fields, so both frontend and API reject anonymous signups consistently. The onboarding gate remains a phone-only guard in the app shell, which means users who verify email but still have no phone are redirected into the same modal, while users with a valid phone skip it entirely.

**Tech Stack:** TypeScript, Zod, React Hook Form, Next.js App Router, Fastify, Vitest

---

### Task 1: Make Signup Name Required

**Files:**
- Modify: `packages/types/src/auth.ts`
- Modify: `apps/catalogues-web/src/app/(auth)/register/page.tsx`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/integration/auth.test.ts
it('rejects signup without full name', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'anon@x.com', password: 'password123' },
  });
  expect(res.statusCode).toBe(400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/api exec vitest run --config vitest.integration.config.ts test/integration/auth.test.ts -t "rejects signup without full name"`
Expected: FAIL because `displayName` is still optional.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/types/src/auth.ts
export const RegisterBody = z.object({
  email: z.string().email().max(254),
  password: z
    .string()
    .min(8)
    .max(128)
    .regex(/[a-zA-Z]/, 'Password must contain at least one letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  displayName: z.string().min(1).max(80),
});
```

```tsx
// apps/catalogues-web/src/app/(auth)/register/page.tsx
<label htmlFor="displayName" style={{ fontWeight: 700, fontSize: 14, color: C.text }}>
  Full Name*
</label>
...
<input
  id="displayName"
  type="text"
  placeholder="Enter your full name"
  autoComplete="name"
  style={inputStyle}
  {...register('displayName')}
/>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/web typecheck && pnpm --dir apps/api exec vitest run --config vitest.integration.config.ts test/integration/auth.test.ts -t "rejects signup without full name"`
Expected: frontend typecheck passes and API test returns 400 for missing name.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/auth.ts apps/catalogues-web/src/app/(auth)/register/page.tsx apps/api/test/integration/auth.test.ts
git commit -m "feat: require full name on signup"
```

### Task 2: Keep Phone Gate Phone-Only

**Files:**
- Modify: `apps/catalogues-web/src/components/profile-gate.tsx`
- Modify: `apps/catalogues-web/src/components/profile-completion-modal.tsx`
- Modify: `apps/catalogues-web/src/app/(auth)/verify-email/confirm/page.tsx`
- Modify: `apps/catalogues-web/src/app/api/auth/google/callback/route.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/integration/auth.test.ts
it('does not require company name after email verification when phone is present', async () => {
  const { accessToken } = await createVerifiedUser('phone-ok@x.com');
  const res = await app.inject({
    method: 'PATCH',
    url: '/v1/me',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { phone: '9876543210', companyName: null },
  });
  expect(res.statusCode).toBe(200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/api exec vitest run --config vitest.integration.config.ts test/integration/auth.test.ts -t "does not require company name after email verification when phone is present"`
Expected: FAIL if phone gate still depends on company name.

- [ ] **Step 3: Write minimal implementation**

```tsx
// apps/catalogues-web/src/components/profile-gate.tsx
const complete = Boolean(data?.phone && /^\d{10}$/.test(data.phone));
...
<ProfileCompletionModal
  open={Boolean(data && !complete)}
  phone={data?.phone ?? null}
  companyName={data?.companyName ?? null}
/>
```

```tsx
// apps/catalogues-web/src/components/profile-completion-modal.tsx
<p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.6, color: C.mid }}>
  Mobile number required. Company name optional. If number already used on another
  account, you must enter a different one.
</p>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api typecheck && pnpm --filter @tryme/web typecheck && pnpm --dir apps/api exec vitest run --config vitest.integration.config.ts test/integration/auth.test.ts test/integration/google-oauth.test.ts test/integration/credits.test.ts`
Expected: typechecks pass and integration trio stays green.

- [ ] **Step 5: Commit**

```bash
git add apps/catalogues-web/src/components/profile-gate.tsx apps/catalogues-web/src/components/profile-completion-modal.tsx apps/catalogues-web/src/app/(auth)/verify-email/confirm/page.tsx apps/catalogues-web/src/app/api/auth/google/callback/route.ts
git commit -m "feat: keep onboarding gate phone-only"
```
