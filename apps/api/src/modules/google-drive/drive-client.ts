const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const APP_FOLDER_NAME = 'AI Vastra';

/**
 * Finds the user's "AI Vastra" app folder, creating it on first use. drive.file
 * only sees files/folders this app created, so a stale folder from a previous
 * connection (post-disconnect/reconnect) is still visible and reused — avoids
 * littering the user's Drive with duplicate "AI Vastra" folders on reconnect.
 */
export async function findOrCreateAppFolder(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  return findOrCreateFolder(accessToken, APP_FOLDER_NAME, null, fetchImpl);
}

/**
 * Finds or creates a named folder under `parentId`. Used to group a batch/
 * catalogue's exports together instead of dumping every export flat into the
 * root "AI Vastra" folder — same drive.file visibility caveat as above: only
 * folders this app created are ever seen, so reconnect-safe by construction.
 */
export async function findOrCreateSubfolder(
  accessToken: string,
  parentId: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  return findOrCreateFolder(accessToken, name, parentId, fetchImpl);
}

async function findOrCreateFolder(
  accessToken: string,
  name: string,
  parentId: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const escapedName = name.replace(/'/g, "\\'");
  const parentClause = parentId ? ` and '${parentId}' in parents` : '';
  const q = encodeURIComponent(
    `name='${escapedName}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentClause}`,
  );
  const listRes = await fetchImpl(`${DRIVE_FILES_URL}?q=${q}&spaces=drive&fields=files(id)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!listRes.ok) throw new Error(`drive folder lookup failed: ${listRes.status}`);
  const { files } = (await listRes.json()) as { files: Array<{ id: string }> };
  if (files[0]) return files[0].id;

  const createRes = await fetchImpl(DRIVE_FILES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : undefined,
    }),
  });
  if (!createRes.ok) throw new Error(`drive folder create failed: ${createRes.status}`);
  const created = (await createRes.json()) as { id: string };
  return created.id;
}

/** Multipart upload: JSON metadata part + binary content part. */
export async function uploadFile(
  accessToken: string,
  folderId: string,
  filename: string,
  contentType: string,
  content: Buffer,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; webViewLink: string }> {
  const boundary = `tryme-${Date.now()}`;
  const metadata = JSON.stringify({ name: filename, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const res = await fetchImpl(`${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,webViewLink`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: body as unknown as BodyInit,
  });
  if (!res.ok) throw new Error(`drive upload failed: ${res.status}`);
  return (await res.json()) as { id: string; webViewLink: string };
}
