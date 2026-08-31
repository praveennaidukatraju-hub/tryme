# Admin error-surfacing audit — 2026-07-16

## Coverage
207 matches = 89 fixed + 28 reported + 90 ok

## Auto-fixed (89)
- src/App.tsx: 1 site
- src/components/EditBackgroundModal.tsx: 2 sites
- src/components/EditFaceModal.tsx: 3 sites
- src/components/EditGarmentTypeModal.tsx: 1 site
- src/components/EditPoseModal.tsx: 1 site
- src/components/PoseUploadModal.tsx: 1 site
- src/pages/assets/AssetsContext.tsx: 3 sites
- src/pages/assets/BackgroundsTab.tsx: 9 sites
- src/pages/assets/CatalogTab.tsx: 11 sites
- src/pages/assets/CatalogueTemplatesTab.tsx: 2 sites
- src/pages/assets/FacesTab.tsx: 3 sites
- src/pages/assets/GarmentTypesTab.tsx: 7 sites
- src/pages/assets/PoseAssetsTab.tsx: 6 sites
- src/pages/CatalogPage.tsx: 6 sites
- src/pages/ChatInboxPage.tsx: 4 sites
- src/pages/ContactRequestsPage.tsx: 2 sites
- src/pages/DashboardPage.tsx: 1 site
- src/pages/JobsPage.tsx: 6 sites
- src/pages/RecycleBinPage.tsx: 3 sites
- src/pages/SettingsPage.tsx: 3 sites
- src/pages/TryonPage.tsx: 1 site
- src/pages/UsersPage.tsx: 6 sites
- src/pages/WorkersPage.tsx: 4 sites
- src/pages/WorkflowsPage.tsx: 3 sites

## Reported for review (28)

### src/App.tsx:94
- Current: `.catch(() => {});`
- Class: Silent non-throw
- Why flagged: Loads the admin's server-side theme preference on login; failure leaves the locally-stored theme unchanged with no toast or log.
- Suggested fix: confirm intentional best-effort (non-critical UX-only preference sync)

### src/components/EditCatalogueTemplateModal.tsx:204
- Current: `.catch(() => setLooks([]))`
- Class: Silent non-throw
- Why flagged: A failed load of a template's existing "looks" silently resets to an empty list, which reads to the admin as "no looks configured" rather than "load failed."
- Suggested fix: toast with `apiErrorMessage(e, 'Failed to load template looks.')` instead of silently emptying the list

### src/components/EditGarmentTypeModal.tsx:371
- Current: `.catch(() => {});`
- Class: Silent non-throw
- Why flagged: Categories dropdown data load; on failure the dropdown is just empty with no indication of why.
- Suggested fix: surface a toast, or confirm intentional best-effort

### src/components/Sidebar.tsx:150
- Current: `.catch(() => {});`
- Class: Silent non-throw
- Why flagged: Polls the unread contact-request badge count every 5s; failure leaves the badge stale with no indication.
- Suggested fix: confirm intentional best-effort (low-priority background poll)

### src/context/AuthContext.tsx:62
- Current: `catch { // not logged in }`
- Class: Fully silent
- Why flagged: Explicitly called out in the skill as an intentional-best-effort example (initial session-refresh probe on app load). Not auto-fixed per the skill's explicit instruction not to decide on these.
- Suggested fix: confirm intentional best-effort

### src/context/AuthContext.tsx:92
- Current: `catch { // best-effort }`
- Class: Fully silent
- Why flagged: Explicitly called out in the skill as an intentional-best-effort example (logout call failure ignored; client-side state is cleared regardless).
- Suggested fix: confirm intentional best-effort

### src/lib/sse.ts:33
- Current: `catch { /* ignore malformed data */ }`
- Class: Fully silent
- Why flagged: Malformed SSE data block during stream parsing; comment indicates deliberate intent, but the skill requires reporting rather than deciding on any fully-silent catch.
- Suggested fix: confirm intentional best-effort (already documented in-line)

### src/lib/sse.ts:42
- Current: `if (!res.ok) return null;`
- Class: Silent non-throw
- Why flagged: Token-refresh failure inside the SSE reconnect path returns null and the caller silently closes the connection with no user-facing error.
- Suggested fix: confirm intentional (part of auto-reconnect/auth-failure flow) or route through `onAuthFailure`

### src/lib/sse.ts:46
- Current: `catch { return null; }`
- Class: Fully silent
- Why flagged: Same `tryRefreshAdminToken` helper; a network failure during the refresh attempt is swallowed and returns null.
- Suggested fix: confirm intentional best-effort

### src/lib/sse.ts:113
- Current: `catch (err) { ...; onError?.(error); }`
- Class: Fully silent (in current usage)
- Why flagged: `createSSEConnection`'s error/reconnect path calls an optional `onError` callback. Its only current caller, `useAdminJobStream` (via `hooks/use-admin-job-stream.ts`), does not supply one, so admin job-stream disconnects are entirely silent to the operator today.
- Suggested fix: wire an `onError` → toast in the job-stream consumer, or confirm silent auto-reconnect is intentional

### src/lib/sse.ts:178
- Current: `catch { // fall through to reconnect }`
- Class: Fully silent
- Why flagged: `createAdminSSEConnection` (used by DashboardPage's live-update connection) silently retries on any connection error.
- Suggested fix: confirm intentional best-effort (auto-reconnect)

### src/lib/thumbnail.ts:36
- Current: `catch { return file; }`
- Class: Fully silent
- Why flagged: Documented intentional fallback per the function's own docstring (returns the original file unchanged if thumbnailing fails, so the upload still succeeds). Reported rather than left untouched-without-comment per the skill's "never decide" rule.
- Suggested fix: confirm intentional best-effort (already documented)

### src/pages/assets/AssetsContext.tsx:134
- Current: `.catch(() => {});`
- Class: Silent non-throw
- Why flagged: Mount-time preload of the faces list (duplicates the explicit `loadFaces` callback, which is already auto-fixed elsewhere in this file). Silent failure just leaves the shared context list empty.
- Suggested fix: confirm intentional best-effort, or dedupe this preload with `loadFaces`

### src/pages/assets/AssetsContext.tsx:137
- Current: `.catch(() => {});`
- Class: Silent non-throw
- Why flagged: Mount-time preload of the backgrounds list, same pattern as above.
- Suggested fix: confirm intentional best-effort, or dedupe with `loadAllBackgrounds`

### src/pages/assets/AssetsContext.tsx:140
- Current: `.catch(() => {});`
- Class: Silent non-throw
- Why flagged: Mount-time preload of catalog items, same pattern.
- Suggested fix: confirm intentional best-effort

### src/pages/assets/AssetsContext.tsx:143
- Current: `.catch(() => {});`
- Class: Silent non-throw
- Why flagged: Mount-time preload of garment types, same pattern (duplicates `loadGarmentTypes`).
- Suggested fix: confirm intentional best-effort, or dedupe with `loadGarmentTypes`

### src/pages/assets/BackgroundsTab.tsx:118
- Current: `catch { // non-fatal — only affects cross-tab badges }`
- Class: Fully silent
- Why flagged: `loadAllBackgrounds` — comment documents intent, reported rather than assumed per the skill's rule.
- Suggested fix: confirm intentional best-effort (already documented)

### src/pages/assets/BackgroundsTab.tsx:133
- Current: `catch { // non-fatal }`
- Class: Fully silent
- Why flagged: `loadUncategorizedCount` — same documented-but-silent pattern.
- Suggested fix: confirm intentional best-effort (already documented)

### src/pages/assets/GarmentTypesTab.tsx:104
- Current: `.catch(() => {});`
- Class: Silent non-throw
- Why flagged: `refetchWorkflows` feeds the workflow-selection dropdowns used throughout this tab; on failure those dropdowns silently stay stale/empty.
- Suggested fix: confirm intentional best-effort, or surface a toast since it feeds required dropdowns

### src/pages/assets/GarmentTypesTab.tsx:133
- Current: `.catch(() => {});`
- Class: Silent non-throw
- Why flagged: Tryon-categories load on mount; failure leaves the category badge/column silently blank.
- Suggested fix: confirm intentional best-effort

### src/pages/assets/PoseAssetsTab.tsx:994
- Current: `catch { /* partial line — ignore */ }`
- Class: Fully silent
- Why flagged: NDJSON streaming-progress parser for the bulk-import XHR; ignores incomplete JSON lines mid-stream. Reported per the "never decide" rule even though this looks like correct streaming-parse behavior rather than a bug.
- Suggested fix: confirm intentional (correct handling of partial stream chunks, not an error to surface)

### src/pages/ContactRequestsPage.tsx:85
- Current: `.catch(() => null)`
- Class: Silent non-throw
- Why flagged: `refreshSummary` (sources-summary badge counts), invoked both on mount and inside the 5s poll loop; failures are silently swallowed.
- Suggested fix: confirm intentional best-effort

### src/pages/ContactRequestsPage.tsx:113
- Current: `.catch(() => {});`
- Class: Silent non-throw
- Why flagged: Seeds the unread-count baseline on mount before the poll loop starts.
- Suggested fix: confirm intentional best-effort

### src/pages/ContactRequestsPage.tsx:118
- Current: `.catch(() => ({ count: 0 }))`
- Class: Silent non-throw
- Why flagged: Polls the unread-count endpoint every 5s inside `setInterval`; errors are swallowed and treated as zero.
- Suggested fix: confirm intentional best-effort (background poll)

### src/pages/LoginPage.tsx:24
- Current: `setError('Login failed. Please try again.');` (the `else` branch of `catch (err)`, after explicit `ApiError` 403/401 branches)
- Class: Silent non-throw (generic-message equivalent)
- Why flagged: The 403 and 401 branches show deliberate, specific, security-conscious messages (not raw backend text — a reasonable choice for a login form). But this `else` branch catches everything else — network failures, 5xx errors, rate limiting — and discards the real backend/error message in favor of a generic string, which is exactly the "Grafana needed to see what really happened" scenario the skill targets. Not auto-fixed because it isn't the canonical toast shape, and login-error copy is security-sensitive enough to want human sign-off.
- Suggested fix: for the fallback branch only, use `apiErrorMessage(err, 'Login failed. Please try again.')`, keeping the deliberate 401/403 copy untouched

### src/pages/SareePage.tsx:116
- Current: `.catch(() => {});`
- Class: Silent non-throw
- Why flagged: Secondary tryon-workflow-options load inside `loadData`, used to populate the saree tryon-workflow dropdown; failure leaves it silently empty.
- Suggested fix: confirm intentional best-effort

### src/pages/SettingsPage.tsx:423
- Current: `.catch(() => {});`
- Class: Silent non-throw
- Why flagged: Loads the model-faces list used for merchant-catalog-default dropdowns; failure leaves the dropdown silently empty.
- Suggested fix: confirm intentional best-effort, or surface a toast since it feeds a config dropdown

### src/pages/SettingsPage.tsx:426
- Current: `.catch(() => {});`
- Class: Silent non-throw
- Why flagged: Same as above for the model-backgrounds list.
- Suggested fix: confirm intentional best-effort, or surface a toast
