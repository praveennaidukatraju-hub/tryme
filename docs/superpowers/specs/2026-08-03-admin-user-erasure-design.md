# Admin Panel — Full User Erasure (Single + Bulk)

**Status:** Approved design, not yet implemented.
**Date:** 2026-08-03

## 1. Problem Statement

Super admins need a real "delete user" action driven by GDPR/user-requested erasure — not just the current suspend-and-anonymize-email behavior. Requirements, established during design discussion:

1. Strip personally-identifying data everywhere it lives for that user, not just the email column.
2. Preserve financial/job records (`payments`, `credit_ledger`, `jobs`) intact — Indian tax law (GST/Income Tax Act) generally requires retaining transaction records for a statutory period regardless of an erasure request. A cascading hard-delete of the `users` row would wipe those records via existing `onDelete: 'cascade'` FKs and was explicitly rejected in favor of this anonymize-in-place approach.
3. Support both a single-user action and a bulk (multi-select) action from the admin UI.
4. Audit-log every erasure (who did it, to whom, when) — this repo has a documented incident (see `CLAUDE.md`'s "Invariants" section, 2026-07-27) where an unlogged admin mutation caused unattributable data loss; this feature must not repeat that gap.

## 2. Current State (verified against code)

- `DELETE /admin/users/:id` already exists (`apps/api/src/modules/admin/users.routes.ts:327-356`), gated `requireAdmin(['SUPER_ADMIN'])`. It currently: blocks if the target row is also an `admin_users` row (403, `:339`), then anonymizes only `users.email` to `'deleted+' || id || '@example.invalid'`, sets `isBanned: true` / `banReason: 'admin soft-delete'`, and revokes all `refresh_tokens` for that user (`:350-353`). It does **not** touch `displayName`, `phone`, `companyName`, `username`, or `oauth_accounts`, and does not check merchant ownership.
- This route has **zero test coverage** — `apps/api/test/integration/admin-users.test.ts` only covers listing and a 403-for-non-admin case (`:20,30`). No test exercises the delete route at all.
- This route has **no audit logging** — no `app.log` call anywhere in it. Contrast with `PATCH /admin/assets/garment-types/:id` (`apps/api/src/modules/admin/subcategories.routes.ts`), which logs `adminUserId`/`garmentTypeId`/changed-field-keys specifically because of the 2026-07-27 incident referenced above.
- No bulk-action endpoint or UI pattern exists for users today. `apps/admin-web/src/pages/RecycleBinPage.tsx` has the reference pattern this feature should reuse: per-row checkboxes, a "Select page" / "Deselect page" toggle button (`RecycleBinPage.tsx:207-237`), `selectedIds` state per tab, and a permanent-delete confirmation flow (`permDel` state, `:68`).
- `apps/admin-web/src/pages/UsersPage.tsx` already has a per-row action menu with Suspend/Unsuspend (`:614`) and Revoke-admin (`:609`), each backed by its own simple Yes/No confirm modal (`:926-930` is the suspend one) — the new Delete action follows this exact established pattern, not a new one.
- FK graph from `users.id` (`packages/db/src/schema/*.ts`, confirmed via grep): `jobs`, `user_credits`, `credit_ledger`, `credit_requests`, `payments`, `refresh_tokens`, `oauth_accounts`, `admin_users`, `merchants.userId`, and chatbot conversation tables are all `onDelete: 'cascade'`. This is the exact reason a real `DELETE FROM users` was rejected — it would cascade-wipe `payments`/`credit_ledger` along with everything else. `merchants.userId` (`packages/db/src/schema/merchant.ts:42-45`) is also cascade — relevant to the new merchant-owner guard below (§3.3).
- `job_inputs.params` can carry a user-typed, sanitized, ≤300-char hint that reaches the ComfyUI workflow prompt (`CLAUDE.md` invariant: "User hint field (300 char max) goes through sanitization before reaching the workflow prompt"). This is freeform text and is explicitly **not** scrubbed by this feature — see §6.

## 3. Design

### 3.1 Backend — enhance the existing route in place

`apps/api/src/modules/admin/users.routes.ts`'s existing `DELETE /admin/users/:id` handler (`:327-356`) is extended, not replaced. New behavior, same route, same guard:

1. Keep the existing admin-row check (`:335-339`, 403 `'cannot delete an admin user'`).
2. **New:** check `merchants` for a row where `userId = id` (`schema.merchants`, field confirmed at `merchant.ts:42`). If found, throw `AppError('FORBIDDEN', 403, 'cannot erase a merchant account owner')`.
3. Update `users` in one statement:
   ```ts
   .set({
     email: sql`'deleted+' || ${id} || '@example.invalid'`,
     displayName: 'Deleted User',
     phone: null,
     companyName: null,
     username: null,
     isBanned: true,
     banReason: 'admin erasure (GDPR)',
     updatedAt: new Date(),
   })
   ```
4. **New:** `await app.db.delete(schema.oauthAccounts).where(eq(schema.oauthAccounts.userId, id))` — full row delete, not anonymization; there's no reason to retain a scrubbed Google identity row.
5. Keep the existing refresh-token revocation (`:350-353`), unchanged.
6. **New:** `app.log.warn({ adminUserId: req.userId, targetUserId: id, action: 'USER_ERASURE' }, 'admin erased user PII')` — placed after the DB writes succeed, mirroring the logging precedent in `subcategories.routes.ts`.
7. `jobs`, `job_inputs`/`job_outputs`/`job_events`, `payments`, `credit_ledger`, `user_credits`, `credit_requests` — untouched. They keep the FK to the now-anonymized `userId`.

### 3.2 Backend — new bulk route

`POST /admin/users/bulk-delete`, same file, same `requireAdmin(['SUPER_ADMIN'])` guard, body `{ ids: string[] }` (zod: non-empty array of UUIDs). Implementation extracts the per-id erasure logic from §3.1 into a shared local function (e.g. `eraseUser(id: string): Promise<{ ok: true } | { ok: false; reason: string }>`) called once per id, **not** wrapped in one all-or-nothing transaction — each id's erasure (or admin/merchant-owner skip) is independent, so one bad id in a batch doesn't block the rest. Response:
```ts
{ succeeded: string[], skipped: { id: string; reason: string }[] }
```
The single-delete route (§3.1) becomes a thin wrapper that calls the same shared function for one id and maps its skip-reason to the existing 403 responses, so behavior for existing single-delete callers is unchanged (still a 403 on admin/merchant-owner, not a 200-with-skipped-list) — only the bulk route returns the succeeded/skipped shape.

### 3.3 Frontend — `apps/admin-web/src/pages/UsersPage.tsx`

**Single delete:** add a "Delete" entry to the existing per-row action menu, next to Suspend/Revoke-admin (`:609-614`). Clicking opens a Yes/No confirm modal (same visual pattern as the existing suspend-confirm modal at `:926-930`), copy: *"Permanently erase personal data for {email}? This cannot be undone. Their job and payment history will be retained but anonymized."* On confirm, calls the existing `DELETE /admin/users/:id`, removes the row from the local list (or marks it, matching whatever the Suspend flow already does to `users`/`detail` state at `:229-230`) and toasts `"User data erased"`.

**Bulk delete:** add per-row checkboxes and a page-level "Select page" / "Deselect page" toggle, copying the exact state/interaction pattern from `RecycleBinPage.tsx:207-237` (`selectedIds` array, `pageSelected` derivation, toggle button). When `selectedIds.length > 0`, a "Delete selected ({n})" button appears in the table toolbar. Clicking opens the same simple Yes/No confirm modal, body listing the affected emails (bounded list — if more than ~10 selected, show first 10 + "and N more"). On confirm, calls `POST /admin/users/bulk-delete`, then toasts a summary: `"Erased {succeeded.length}, skipped {skipped.length}"` — if anything was skipped, an expandable detail line shows which emails and why (admin / merchant owner), so the admin isn't left guessing why a count didn't match their selection.

### 3.4 Types

`packages/types/src/admin.ts` (or wherever the admin route bodies are defined — follow existing convention in that file) gets a new Zod schema for the bulk-delete body: `z.object({ ids: z.array(z.string().uuid()).min(1) })`.

## 4. Guardrails / edge cases

- Admin-row target → 403, unchanged from today, now also enforced inside the bulk loop (surfaces as a `skipped` entry, not a batch failure).
- Merchant-owner target → new 403 / bulk-skip, same shape as the admin check.
- Erasing a user who is currently mid-job (an in-progress `jobs` row) is **allowed** — the job keeps running against the (now cascade-irrelevant, since we don't delete the row) `userId` FK; dispatcher logic doesn't look up `users` PII mid-job, only `userId` for crediting/refunds, which still resolves fine against the anonymized row.
- Idempotency: calling delete twice on an already-erased user is harmless — the email/displayName/etc. sets are idempotent, `oauthAccounts` delete-where is a no-op the second time, refresh-token revoke-where is a no-op. No special-casing needed.
- Bulk request with a mix of valid, admin, merchant-owner, and already-erased ids: all resolve independently per §3.2; already-erased ids land in `succeeded` (idempotent, not an error).

## 5. Testing

New cases in `apps/api/test/integration/admin-users.test.ts`:
- Successful single erasure: PII columns scrubbed, `oauth_accounts` rows for that user gone, associated `payments`/`credit_ledger`/`jobs` rows still present and still pointing at the same `userId`, refresh tokens revoked (existing behavior, re-verified under the new code path).
- Admin-row target → 403 (existing behavior, now actually tested).
- Merchant-owner target → 403 (new).
- Bulk endpoint: batch of 4 ids — one clean user, one admin, one merchant owner, one already-erased — asserts `succeeded` contains the clean + already-erased ids, `skipped` contains the admin + merchant-owner ids with correct reasons.
- Non-super-admin (e.g. `MODERATOR` role) → 403 on both the single and bulk routes.

## 6. Explicitly out of scope

- Scrubbing freeform text fields that may contain user-typed PII — `job_inputs.params`'s sanitized hint field is the known instance. This is a materially larger problem (text scanning/redaction across an arbitrary-content field used as an LLM/workflow prompt input) than this feature's scope. Documented here as a known gap, not silently dropped: a future pass could redact or null this field per-job as part of the same erasure call if this becomes a real compliance requirement.
- Merchant account erasure/offboarding — explicitly blocked (§3.1 step 2), not designed here. A merchant-owner needing erasure requires its own design (business contact PII, webhook configs, widget clients) and is a different-shaped problem.
- Persisted DB audit table — per your explicit choice, this uses the structured-log-line precedent already established in the codebase, not a new `admin_audit_log` table.
- Any change to how `jobs`/`payments`/`credit_ledger` display in the admin panel after a user is erased (e.g. showing "Deleted User" instead of a blank name) — confirmed via `apps/api/src/modules/admin/credit-analysis.routes.ts:79,131,157,187,322` that admin credit/payment listings already select `users.displayName` directly, so the anonymized `'Deleted User'` value covers this for free, no further UI work needed.
