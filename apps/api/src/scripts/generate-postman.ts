/**
 * Regenerates the public dev-API Postman collection from the live OpenAPI spec
 * (the same one served at /v1/dev/openapi.json — see server.ts's swagger
 * `transform`, which hides every route not tagged 'dev'). Run this after
 * creating or changing anything under src/modules/dev/ or the Zod schemas it
 * depends on, then commit the regenerated file alongside the route change.
 *
 * Boots the full app to get an accurate spec but never listens on a port or
 * needs a reachable Postgres/Redis — postgres.js and ioredis connect lazily,
 * and this script never issues a query.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert } from 'openapi-to-postmanv2';
import { loadEnv } from '../env.js';
import { buildServer } from '../server.js';

const OUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../postman/tryme-dev-api.postman_collection.json',
);

async function main() {
  const app = await buildServer(loadEnv());
  await app.ready();

  const spec = app.swagger();

  const collection = await new Promise<object>((res, rej) => {
    convert({ type: 'json', data: spec }, {}, (err, result) => {
      if (err) return rej(err);
      if (!result?.result || !result.output?.[0]) {
        return rej(new Error(result?.reason ?? 'conversion failed'));
      }
      res(result.output[0].data);
    });
  });

  await writeFile(OUT_PATH, `${JSON.stringify(collection, null, 2)}\n`);
  console.log(`Wrote ${OUT_PATH}`);

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
