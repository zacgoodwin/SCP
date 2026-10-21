import { Hono } from 'hono';
import { audit } from '../audit.ts';
import { requireAdmin, requireScope } from '../auth/middleware.ts';
import { parseJson } from '../lib/http.ts';
import { sweepBlobs } from '../items/gc.ts';
import { applySettings, settingsPatchSchema, settingsView } from './settings.ts';
import type { AppEnv } from '../types.ts';

/** D4 (docs/PLAN-v2.md): /admin/settings, /admin/gc. Mounted under /api/v1; every route requireAdmin. */
export const adminRoutes = new Hono<AppEnv>();

adminRoutes.get('/admin/settings', (c) => {
  requireAdmin(c);
  return c.json(settingsView(c.var.ctx));
});

adminRoutes.put('/admin/settings', async (c) => {
  const p = requireAdmin(c);
  requireScope(p, 'write');
  const body = await parseJson(c, settingsPatchSchema);
  const keys = applySettings(c.var.ctx, body);
  // Keys only: the values include a client secret and a token.
  audit(c, p, { action: 'admin.settings', targetType: 'settings', detail: { keys } });
  return c.json(settingsView(c.var.ctx));
});

adminRoutes.post('/admin/gc', (c) => {
  const p = requireAdmin(c);
  requireScope(p, 'write');
  const r = sweepBlobs(c.var.ctx.db);
  audit(c, p, { action: 'admin.gc', detail: { ...r } });
  return c.json(r);
});
