# WordPress/WooCommerce Demo Storefront — UI & Catalog — Design

> **Status:** Approved design, not yet implemented.
> **Scope:** The local WooCommerce test store at `wordpress-plugin/local-wp/` —
> theme, product catalog, and checkout configuration. This is the surrounding
> store the Tryme try-on plugin's "Try It On" button sits inside; it is
> separate from the plugin's own admin settings page (already redesigned
> earlier this session).
> **Explicitly out of scope:** deploying this store to a VPS. Once the store
> itself is built and verified locally, deployment (new subdomain on the
> existing VPS, e.g. `wp-demo.tryme.com`, its own Docker Compose project +
> CloudPanel vhost) will be a separate follow-up spec — shipping an unfinished
> store just adds a round trip.

---

## 1. Goal

Turn the local WooCommerce test site — currently the default `twentytwentyfive`
theme with one dummy product ("Orange Hoodie") — into a realistic-looking
demo store: a proper WooCommerce theme skinned with Tryme's brand colors,
a full catalog built from the 432 real garment images already sitting in the
repo, and a checkout flow that works end-to-end for demo purposes (no real
payment processing).

## 2. Theme & visual identity

**WooCommerce Storefront**, as a **child theme** — never edit Storefront's own
files directly, since a theme update would silently wipe direct edits.

- Parent: `storefront` (installed via `wp theme install storefront`, not
  version-controlled — it's the stock upstream theme, same as any fresh WP
  install would fetch).
- Child: `storefront-tryme`, created at
  `wordpress-plugin/local-wp/themes/storefront-tryme/` (version-controlled,
  mounted into the WordPress container the same way the plugin already is) —
  `style.css` (child-theme header + `Template: storefront`) and
  `functions.php` (enqueues the parent's stylesheet, then the child's).
- Visual changes are CSS-only, reusing the widget's existing brand palette
  (`--tryme-primary: #0f172a`, `--tryme-accent: #6366f1`, from
  `assets/widget.css`) so the storefront, the try-on modal, and the plugin's
  admin page all read as one product:
  - Header: site title/logo area recolored, primary nav accent on hover.
  - Product grid (shop/category archive): card shadows, spacing, and the
    "Add to cart" button restyled to the brand palette.
  - Single product page: gallery/summary spacing tightened, price and
    "Add to cart" button restyled.
  - Cart & checkout: table/form styling cleaned up, primary action buttons
    (Update cart, Proceed to checkout, Place order) restyled consistently.
- This is a skin, not a rebuild — Storefront's existing template structure,
  WooCommerce hooks, and page layout stay exactly as WooCommerce renders them.

`docker-compose.yml` (`wordpress-plugin/local-wp/`) gains one new volume line
mounting the child theme directory into
`/var/www/html/wp-content/themes/storefront-tryme`, mirroring how the
plugin and the WooCommerce plugin are already mounted.

## 3. Product catalog & import mechanism

The 432 source images are unusable for titles as-is — filenames are opaque
hashes (e.g. `imgi_103_78bf8ff2c860bf0e061d336f8ca4384f7c79d12d.jpg`), not
descriptive names.

**Category tree** (WooCommerce `product_cat` taxonomy):

- `Men` (already exists) → 9 children, one per subfolder under
  `men garments/`. `Women` (new) → 4 children, one per subfolder under
  `womens garments/`. Source folder names are inconsistently cased
  (`half sleeve Tshirts`) and not usable as-is for a category slug or a
  product title — this table is the exact, unambiguous mapping the import
  script uses for both:

  | Source subfolder | Category slug | Display name (category + product title) |
  |---|---|---|
  | `blazers` | `blazers` | Blazer |
  | `full sleeve shirts` | `full-sleeve-shirts` | Full Sleeve Shirt |
  | `full sleeve tshirts` | `full-sleeve-tshirts` | Full Sleeve T-Shirt |
  | `half sleeve shirts` | `half-sleeve-shirts` | Half Sleeve Shirt |
  | `half sleeve Tshirts` | `half-sleeve-tshirts` | Half Sleeve T-Shirt |
  | `hoodies` (men) | `hoodies` | Hoodie |
  | `jackets` (men) | `jackets` | Jacket |
  | `polo` | `polo` | Polo |
  | `sleeveless tshirts` | `sleeveless-tshirts` | Sleeveless T-Shirt |
  | `womens hoodies` | `womens-hoodies` | Hoodie |
  | `womens jackets` | `womens-jackets` | Jacket |
  | `womens shirts` | `womens-shirts` | Shirt |
  | `womens sweatshirts` | `womens-sweatshirts` | Sweatshirt |

  Product titles use the display name: `"Men's {Display Name} #{n}"` /
  `"Women's {Display Name} #{n}"` (e.g. "Men's Blazer #1", "Women's Hoodie
  #1") — `n` is a counter starting at 1, scoped per category, not global.

This also means the Tryme plugin's category-mapping table (Settings →
Tryme Try-On) will have real work to do — ~15 categories to map to try-on
workflows instead of the "Uncategorized" / "Men" placeholder rows it shows
today.

**Import script**: `wordpress-plugin/local-wp/import-products.php`, run once
via `wp eval-file import-products.php` inside the `wpcli` container. Not part
of the distributable plugin — a one-time local data-seeding tool, alongside
the existing `local-wp/docker-compose.yml`.

`docker-compose.yml`'s `wpcli` service gains two new **read-only** volume
mounts exposing the source folders (which live at the repo root, outside
`wordpress-plugin/`, so nothing reaches them today):
```
../../men garments:/import/men:ro
../../womens garments:/import/women:ro
```

For each image file, the script:

1. Derives its category from the subfolder name (already known, matches the
   tree above).
2. Creates a simple WooCommerce product: title
   `"{Men's|Women's} {Category Name} #{n}"` (n = a per-category running
   counter, e.g. "Men's Blazer #1"), assigned to that category.
3. Sets a random price within a realistic per-category band (INR):

   | Category | Price range |
   |---|---|
   | blazers | ₹3,999–₹6,999 |
   | jackets / womens-jackets | ₹2,499–₹4,999 |
   | hoodies / womens-hoodies | ₹1,299–₹2,499 |
   | womens-sweatshirts | ₹1,199–₹2,199 |
   | full-sleeve-shirts / womens-shirts | ₹899–₹1,799 |
   | half-sleeve-shirts | ₹799–₹1,599 |
   | polo | ₹799–₹1,499 |
   | full-sleeve-tshirts | ₹699–₹1,299 |
   | half-sleeve-tshirts | ₹599–₹1,099 |
   | sleeveless-tshirts | ₹499–₹899 |

4. Sideloads the image as the product's featured image (`media_sideload_image`
   equivalent against the local file path, not a URL fetch).
5. Sets stock status to "In stock", status to "Publish".
6. Records the source filename in postmeta `_tryme_import_source`.

**Idempotency**: before creating a product, the script checks whether a
product already has `_tryme_import_source` matching that filename, and
skips it if so — a re-run after a partial failure (e.g. container restart
mid-import) resumes instead of duplicating 432 products into 800+.

## 4. Checkout & store configuration

- **Payment**: enable WooCommerce's built-in **Cash on Delivery** gateway
  only. Disable Direct Bank Transfer (BACS), Check Payments, and PayPal
  Standard — all four ship enabled by default and would otherwise clutter
  checkout with non-functional options.
- **Currency**: store currency set to INR, matching the pricing above.
- **Shipping**: one flat-rate zone ("Everywhere", ₹99) so checkout has a
  shipping method to select — realistic shipping-cost logic is out of scope.
- **Guest checkout**: enabled, so anyone testing the try-on flow can reach
  "Place Order" without registering an account.
- **Tax**: left disabled (WooCommerce default) — not needed for a demo store.
- Verify (not create — WooCommerce auto-creates these on install) that Cart,
  Checkout, My Account, and Shop pages are correctly set under WooCommerce →
  Settings → Advanced.

All of the above are WooCommerce settings changes (`wp option update` /
`wc_update_option` calls), not code — a second one-time script,
`wordpress-plugin/local-wp/configure-store.php`, kept separate from
`import-products.php` since they're two different concerns (store
configuration vs. catalog content) that shouldn't need to be re-read together
to understand either one. Run the same way: `wp eval-file configure-store.php`
inside the `wpcli` container. Every change it makes (a currency setting, a
shipping zone, a gateway toggle) is naturally idempotent — setting the same
option value twice is a no-op, so it needs no explicit skip-if-exists logic.

## 5. Testing / verification

No automated tests — this is content and configuration, not application
logic (mirrors how `class-settings-page.php`'s `render()` has no unit tests;
it's verified by direct inspection). Verification is manual, on the local
site:

1. `wp theme list` confirms `storefront-tryme` is active.
2. Visual check: home/shop page shows the brand-colored product grid with
   real garment photos, not the default Storefront demo look.
3. `wp post list --post_type=product | wc -l` confirms 432 products (plus the
   original "Orange Hoodie" = 433), with variety across all 13 categories.
4. Settings → Tryme Try-On → category mapping shows all real categories
   (not just "Uncategorized"/"Men").
5. Full checkout walkthrough: add a product to cart → cart page → checkout
   (guest, COD, ₹99 shipping applied) → place order → order confirmation page
   renders.
6. Re-run `import-products.php` a second time and confirm the product count
   doesn't change (idempotency check).

## 6. Out of scope

- Deploying this store anywhere (separate follow-up spec, per the header).
- Real payment gateway integration.
- Product descriptions, variations (size/color), reviews, or any content
  beyond title/category/price/image.
- Homepage content beyond what Storefront + the child theme's CSS produce by
  default (no custom homepage builder work, no additional pages).
