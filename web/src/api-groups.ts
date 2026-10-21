// Nested groups and the plugin marketplace (docs/PLAN-v2.md D5). api.ts is shared and frozen, so the
// D5 additions to GroupDetail live here as extensions of its types.
import { API, json, type GroupDetail, type GroupMember } from './api.ts';

export interface GroupInclude {
  slug: string;
  /** '' when the editor can no longer read the child (it went private): slug only, so the row stays removable. */
  name: string;
  owner: { username: string };
  /** Members the included group publishes itself. */
  memberCount: number;
  /** Whether the include currently flows (the child is the owner's, or public with its owner enabled). Readers see flowing rows only. */
  flowing: boolean;
}

export interface GroupRef {
  slug: string;
  name: string;
}

/** GroupDetail as the v2 server returns it. */
export type GroupDetailV2 = GroupDetail & { includes?: GroupInclude[]; includedBy?: GroupRef[] };

/** The included group a member flows in through, or null for the group's own members. */
export const viaOf = (m: GroupMember): string | null => (m as GroupMember & { via?: string | null }).via ?? null;

const g = (slug: string) => `/groups/${encodeURIComponent(slug)}`;

export const putIncludes = (slug: string, includes: string[]) => json<{ group: GroupDetail }>('PUT', `${g(slug)}/includes`, { includes });
export const addInclude = (slug: string, include: string) => json<{ group: GroupDetail }>('POST', `${g(slug)}/includes`, { slug: include });
export const removeInclude = (slug: string, include: string) => json<{ group: GroupDetail }>('DELETE', `${g(slug)}/includes/${encodeURIComponent(include)}`);
/** Same-origin plugin.zip (the session cookie authenticates a plain GET download). */
export const pluginZipUrl = (slug: string) => `${API}${g(slug)}/plugin.zip`;
