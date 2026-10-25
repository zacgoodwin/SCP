import { Hono, type Context } from 'hono';
import { audit } from '../audit.ts';
import { requireAdmin, requireScope, requireUser } from '../auth/middleware.ts';
import { notFound, parseJson } from '../lib/http.ts';
import { createTool, deleteTool, getToolRow, listToolRows, listTools, toolCreateSchema, toolUpdateSchema, toolView, updateTool, type CliTool } from './service.ts';
import type { AppEnv, Principal } from '../types.ts';

/** docs/PLAN-v3.md "CLI tools": /tools for every signed-in user, /admin/cli-tools for admins
 * (requireAdmin: 403 to anyone else, like every admin route, PLAN-v4 c5j3). Mounted under /api/v1. */
export const toolRoutes = new Hono<AppEnv>();

toolRoutes.get('/tools', (c) => c.json({ tools: listTools(c.var.ctx.db, requireUser(c)) }));

toolRoutes.get('/tools/:name', (c) => {
  const p = requireUser(c);
  const t = getToolRow(c.var.ctx.db, c.req.param('name'));
  if (!t) throw notFound('tool');
  return c.json({ tool: toolView(c.var.ctx.db, p, t) });
});

/** The commands go in the audit detail: they are code readers will run, so who set what must stay traceable. */
const toolAudit = (c: Context<AppEnv>, p: Principal, action: string, name: string, t?: CliTool) =>
  audit(c, p, { action, targetType: 'cli_tool', targetId: name, detail: t ? { homepage: t.homepage, check: t.check, install: t.install } : {} });

toolRoutes.get('/admin/cli-tools', (c) => {
  requireAdmin(c);
  return c.json({ tools: listToolRows(c.var.ctx.db) });
});

toolRoutes.post('/admin/cli-tools', async (c) => {
  const p = requireAdmin(c);
  requireScope(p, 'write');
  const { name, ...input } = await parseJson(c, toolCreateSchema);
  const t = createTool(c.var.ctx.db, name, input);
  toolAudit(c, p, 'cli_tool.create', name, t);
  return c.json({ tool: t }, 201);
});

toolRoutes.put('/admin/cli-tools/:name', async (c) => {
  const p = requireAdmin(c);
  requireScope(p, 'write');
  const input = await parseJson(c, toolUpdateSchema);
  const t = updateTool(c.var.ctx.db, c.req.param('name'), input);
  toolAudit(c, p, 'cli_tool.update', t.name, t);
  return c.json({ tool: t });
});

toolRoutes.delete('/admin/cli-tools/:name', (c) => {
  const p = requireAdmin(c);
  requireScope(p, 'write');
  deleteTool(c.var.ctx.db, c.req.param('name'));
  toolAudit(c, p, 'cli_tool.delete', c.req.param('name'));
  return c.body(null, 204);
});
