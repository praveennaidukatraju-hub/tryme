-- Applied to the staging database immediately after restoring a production dump.
--
-- The dump carries production's `workers` rows, which point at the live ComfyUI
-- GPUs behind Cloudflare tunnels. Left in place, the staging dispatcher would
-- select one and occupy a GPU a paying customer is waiting on. Emptying the table
-- is the whole point of this file.
--
-- No rows are added back. Staging has no GPU of its own yet, so jobs enqueue, the
-- dispatcher finds no healthy worker, and they stay QUEUED — which still exercises
-- auth, credit deduction, catalog resolution, the job row, the stream write and the
-- SSE connection. When a dedicated staging ComfyUI box exists, register it through
-- the admin panel and add a row for it here so it survives the next sync.
--
-- The dispatcher loads this table into the Redis worker registry at boot, so the
-- sync script restarts it after applying this.

-- The dump also carries `shopify_stores.access_token` (and its refresh half),
-- AES-256-GCM ciphertext under *production's* SHOPIFY_TOKEN_ENC_KEY. Staging
-- holds a different key, so every decrypt fails its authentication tag and no
-- staging request that needs a store's Admin API token can work — billing sync
-- above all, which is the only consumer of that token, so the visible symptom
-- is merchants never receiving the credits they paid for.
--
-- Marking the stores uninstalled is the whole fix. apps/api/src/plugins/
-- shopify-auth.ts re-provisions any store whose row is missing or has
-- `uninstalled_at` set, and upsertShopifyStore then rewrites both token columns
-- under staging's key and clears the flag again. So the first time anyone opens
-- the app against a synced store it heals itself, with no key sharing between
-- environments and no manual step in the runbook.
--
-- Deliberately an UPDATE, not a DELETE: `shopify_stores` cascades to
-- shopify_store_credits, shopify_credit_ledger, shopify_shoppers,
-- shopify_widget_events, collections and product garments, so deleting rows
-- would throw away exactly the credit and shopper history staging exists to
-- test against. (jobs.shopify_store_id is ON DELETE SET NULL and would survive,
-- but orphaned.) Flipping one nullable column costs nothing and keeps all of it.
--
-- Reinstalling from the Shopify admin does NOT substitute for this: uninstall
-- notifies whichever environment registered the webhook — production — so
-- staging's `uninstalled_at` stays NULL and the reinstall silently reuses the
-- undecryptable token.

BEGIN;

DELETE FROM workers;

UPDATE shopify_stores
   SET uninstalled_at = now()
 WHERE uninstalled_at IS NULL;

COMMIT;
