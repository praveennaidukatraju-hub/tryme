# Dynamic Instruction Image Per Garment Type

## Goal

Replace the static `instructions.png` on the studio page upload area with a dynamic instruction image that admins can upload per garment type.

## Database

**Migration** — Add column to `garment_subcategories`:

```sql
ALTER TABLE garment_subcategories
  ADD COLUMN instruction_image_key text;
```

Nullable. When null, no instruction image is shown for that garment type.

## Storage Key

Add to `packages/storage/src/keys.ts`:

```typescript
subcategoryInstruction: (id: string) => `models/subcategories/${id}.instruction.jpg`,
```

## API Changes

### New endpoint: `POST /admin/assets/garment-types/instruction/presign`

Request body (Zod):
```typescript
PresignGarmentTypeInstructionBody = z.object({
  contentType: AssetContentType,  // image/jpeg | image/png | image/webp
})
```

Response:
```typescript
{ uploadUrl: string, r2Key: string }
```

Behavior:
- Generate `keys.subcategoryInstruction(randomUUID())`
- Return presigned PUT URL and the key
- The client uploads directly to S3, then sends the key in the PATCH

### Updated: `PATCH /admin/assets/garment-types/:id`

Add optional field to `PatchGarmentTypeBody`:
```typescript
instructionImageKey: z.string().nullable().optional(),
```

In the handler, when provided, update the `instruction_image_key` column. When `null`, clear it.
When replacing or clearing an existing key, delete the old object from S3 via `app.storage.deleteObject()`.

### Updated: `GET /admin/assets/garment-types`

Add `instructionImageUrl` to the response, resolved from `instruction_image_key` via `app.storage.publicUrl()` (or null if no key).

### Updated: `GET /v1/models/garment-types`

Add `instructionImageUrl` to the response (same resolution). The studio page uses this endpoint.

## Admin-Web UI

In `GarmentTypesTab.tsx` edit modal, add a new field below thumbnail:

- Label: "Instruction Image"
- Click-to-upload area (same pattern as thumbnail upload):
  - Shows current image preview if one exists
  - "Upload" button — calls presign, uploads to R2, stores the key
  - "Remove" button — sets key to null
- On modal save, `instructionImageKey` is included in the PATCH body

## Admin-Mobile UI

In `apps/admin-mobile/src/app/(tabs)/assets/garment-types/[id].tsx`, add an "Instruction Image" section (same pattern as thumbnail) with upload and clear.

## Studio Page

In `apps/catalogues-web/src/app/(app)/studio/page.tsx`:

- Update the `GarmentType` interface to include `instructionImageUrl?: string | null`
- In the right-side instruction image div, replace:
  ```diff
  - src={`${BASE}/assets/instructions.png`}
  + src={selectedGarmentType?.instructionImageUrl ?? undefined}
  ```
- Hide the instruction image div entirely when `instructionImageUrl` is null/absent

## Files Changed

| File | Change |
|------|--------|
| `packages/db/src/schema/models.ts` | Add `instructionImageKey` column to garmentSubcategories schema |
| `packages/db/src/migrations/` | New migration SQL file |
| `packages/storage/src/keys.ts` | Add `subcategoryInstruction()` key builder |
| `packages/types/src/admin.ts` | Add `PresignGarmentTypeInstructionBody`, update `PatchGarmentTypeBody` |
| `packages/types/src/index.ts` | Re-export new types |
| `apps/api/src/modules/admin/subcategories.routes.ts` | Add presign endpoint, update PATCH handler |
| `apps/api/src/modules/models/routes.ts` | Add `instructionImageUrl` to GET response |
| `apps/api/src/modules/admin/__tests__/` | Tests for new endpoint |
| `apps/admin-web/src/pages/assets/GarmentTypesTab.tsx` | Add instruction image upload to edit modal |
| `apps/admin-web/src/types.ts` | Add `instructionImageUrl` to GarmentType interface |
| `apps/admin-mobile/src/types.ts` | Add `instructionImageUrl` to GarmentType interface |
| `apps/admin-mobile/src/app/(tabs)/assets/garment-types/[id].tsx` | Add instruction image section |
| `apps/catalogues-web/src/app/(app)/studio/page.tsx` | Use dynamic URL, hide when null |

## Order of Implementation

1. Migration + DB schema
2. Storage key builder
3. Type schemas (Zod)
4. API routes (presign + PATCH update + GET response)
5. Admin-web UI
6. Studio page
7. Admin-mobile UI (can be done later — web admin is higher priority)
