# THREAT_MODEL.md

Top attack surfaces ranked by severity × exploitability. tryme_v1, high-risk scope.

| Rank | ID   | Surface                                              | What goes wrong                                                                                                                            | Blast radius                                                           | Exploitability                                                                               |
| ---- | ---- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1    | TM1  | `GET /v1/uploads/thumbnail?key=`                     | Arbitrary R2 object read via presigned GET — no ownership/prefix check                                                                     | Entire bucket: all users' garments, outputs, internal ComfyUI assets   | Auth required; keys partly derivable from IDs exposed by `/v1/models/*` and result endpoints |
| 2    | TM2  | Job input keys (`upperGarmentKey`/`lowerGarmentKey`) | Validated only as `string(1..512)` — user supplies any bucket key as generation input                                                      | Cross-user image use, internal asset use                               | Auth required; trivial once any foreign key known                                            |
| 3    | TM5  | Public R2 path (`R2_PUBLIC_URL`)                     | Results panel serves images via `publicUrl` (not presigned) ⇒ bucket path is public-read; only UUID-in-key obscurity protects user content | All outputs/garments world-readable if key leaks (referer, #TM1, logs) | Unauthenticated if key known                                                                 |
| 4    | TM3  | Access token in query string (`?token=`)             | JWT logged in proxy/access logs, browser history, Referer                                                                                  | Session hijack of any token-in-URL request (SSE)                       | Passive log access                                                                           |
| 5    | TM4  | Presigned PUT size not enforced                      | `contentLength` zod-validated (10MB) but dropped before signing ⇒ unbounded upload                                                         | Storage/egress cost DoS                                                | Auth required                                                                                |
| 6    | TM6  | Refresh-token reuse handling                         | Reused ("stale") token denied but **family not revoked** ⇒ weakened theft detection                                                        | Stolen refresh token usable until natural expiry of its generation     | Requires token theft first                                                                   |
| 7    | TM7  | Weak secret floors                                   | `JWT_SECRET`/`COOKIE_SECRET` min length 16 chars (<256-bit)                                                                                | Offline forgery if low-entropy secret chosen                           | Depends on operator-chosen value                                                             |
| 8    | TM8  | Admin/results login brute force                      | `/results/login` only under global 200/min limit (main user `/v1/auth/login` is 5/min)                                                     | Admin account compromise → full data panel                             | argon2 slows it; no lockout                                                                  |
| 9    | TM9  | Razorpay signature compare                           | `!==` non-constant-time HMAC compare                                                                                                       | Theoretical signature timing oracle                                    | Very low (remote timing, HMAC)                                                               |
| 10   | TM10 | Secret-at-rest in repo                               | `client_secret_*.json`, `.env*` plaintext in working tree                                                                                  | Google OAuth client secret disclosure                                  | Only if working dir/backup shared (NOT in git)                                               |

## HIGH PRIORITY components (auth / secrets / file access / deserialization)

- **File access:** `uploads/routes.ts`, `packages/storage/src/r2.ts`, `job/processor.ts` `r2Download` — object-storage authZ is the #1 theme (TM1, TM2, TM5).
- **Auth:** `plugins/auth.ts`, `auth/routes.ts`, `auth/tokens.ts`, `auth/service.ts` — refresh rotation is otherwise strong (FOR UPDATE, grace window); gaps are TM3, TM6, TM7.
- **Secrets:** env floors (TM7), repo file (TM10).
- **Deserialization:** `JSON.parse` on Redis SSE payloads (`sse.ts`), worker registry (`registry.ts`), job `params` (`processor.ts`) — all wrapped in try/catch, values are own-published/DB-sourced. No untrusted deserialization sink. **No issue.**

## Surfaces checked and cleared

- **SQL injection:** none — Drizzle parameterizes, incl. `sql``` templates in `admin/credits.routes.ts`and`results/routes.ts`.
- **Prompt injection into ComfyUI:** `userHint` is sanitized (`promptGuard`), stored, surfaced only in admin panel — **never patched into the workflow prompt**. Only admin-curated `promptGarmentPhase` reaches `CLIPTextEncode`-style nodes (`patcher.ts:144`). No user-controlled text reaches the model prompt.
- **SSRF:** worker URLs come from `WORKER_IDS` env, not request input. Razorpay/Google URLs are constants.
- **Credit tampering:** atomic `UPDATE … WHERE balance >= amount`, bounded positive amounts, idempotent refunds, payment ownership + idempotency checks.
- **OAuth CSRF:** `state` cookie validated; one-time 60s Redis OTP handoff.
- **Mass assignment / privilege escalation:** admin RBAC enforced per-route (`SUPPORT` read-only); ban/delete refuse to target admin rows.

Step 2 complete. Findings so far: 0 critical, 2 high, 7 medium, 3 low.
