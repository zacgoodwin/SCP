// CLI tools registry and group "requires" (docs/PLAN-v3.md "CLI tools", f9j0 / fx78). Install commands
// come only from the admin registry; SCP shows them and never runs them.
import { json, type GroupDetail, type Kind } from './api.ts';

export type InstallPlatform = 'macos' | 'linux' | 'windows' | 'any';
export type CliInstall = Partial<Record<InstallPlatform, string>>;

export interface CliTool {
  name: string;
  homepage: string;
  /** Binary the check one-liner looks for on PATH. */
  check: string;
  install: CliInstall;
  updatedAt: string;
}

export interface RequiredCli {
  name: string;
  items: { id: string; name: string }[];
  tool: Pick<CliTool, 'homepage' | 'check' | 'install'> | null;
  /** With tool null: GitHub repos the requiring items came from. */
  sources?: string[];
}

/** fx78: a registry row on /tools, with what the viewer can read that needs it. */
export interface ToolView extends CliTool {
  usedBy: { items: { id: string; kind: Kind; name: string; title: string }[]; groups: { slug: string; name: string }[] };
}

/** GroupDetail as the v3 server returns it. */
export type GroupWithRequires = GroupDetail & { requires?: RequiredCli[] };

/** Body of a create (with name) or replace; '' or omitted check means the name. */
export interface ToolInput {
  homepage?: string;
  check?: string;
  install?: CliInstall;
}

const admin = (name: string) => `/admin/cli-tools/${encodeURIComponent(name)}`;

export const listTools = () => json<{ tools: ToolView[] }>('GET', '/tools');
/** The anchor of a tool's card on /tools. */
export const toolAnchor = (name: string) => `tool-${name}`;

export const listRegistry = () => json<{ tools: CliTool[] }>('GET', '/admin/cli-tools');
export const createTool = (name: string, input: ToolInput) => json<{ tool: CliTool }>('POST', '/admin/cli-tools', { name, ...input });
export const updateTool = (name: string, input: ToolInput) => json<{ tool: CliTool }>('PUT', admin(name), input);
export const deleteTool = (name: string) => json<void>('DELETE', admin(name));
