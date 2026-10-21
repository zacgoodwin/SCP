import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.ts';
import { openDb, setting } from './db.ts';
import { buildApp } from './app.ts';
import { bootstrapAdmin } from './auth/bootstrap.ts';
import { sweepBlobs } from './items/gc.ts';
import type { Ctx } from './types.ts';

const config = loadConfig();
const db = openDb(config.dbPath);
const ctx: Ctx = { db, config, secret: setting(db, 'hmac_secret', () => randomBytes(32).toString('base64url')) };

const admin = await bootstrapAdmin(ctx);
if (admin?.generatedPassword) {
  console.log(`[scp] created admin '${admin.username}' with generated password: ${admin.generatedPassword}`);
  console.log('[scp] set SCP_ADMIN_PASSWORD to choose it yourself; change it after first login.');
}

console.log(`[scp] blob sweep: ${JSON.stringify(sweepBlobs(db))}`);

const { app, artifactApp } = buildApp(ctx);
const s1 = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (i) =>
  console.log(`[scp] app      ${config.publicUrl} (listening :${i.port})`),
);
const s2 = serve({ fetch: artifactApp.fetch, port: config.artifactPort, hostname: '0.0.0.0' }, (i) =>
  console.log(`[scp] artifact ${config.artifactUrl} (listening :${i.port})`),
);

const shutdown = () => {
  s1.close();
  s2.close();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
