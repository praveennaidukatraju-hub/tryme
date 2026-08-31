import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  schema: './dist/schema/index.js',
  out: './src/migrations',
  dialect: 'postgresql',
  // biome-ignore lint/style/noNonNullAssertion: drizzle-kit requires a string, not string|undefined
  dbCredentials: { url: process.env.DATABASE_URL! },
  strict: true,
  verbose: true,
});
