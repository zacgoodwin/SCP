export const meta = {
  name: 'scp-v2-review-loop',
  description: 'Loop: 6-lens finder sweep over the SCP v2 diff -> skeptic verify/dedupe -> fixer, until a round confirms nothing (max 3)',
  phases: [
    { title: 'Find', detail: '6 read-only finders with distinct lenses' },
    { title: 'Verify', detail: 'one skeptic refutes and dedupes against everything already fixed' },
    { title: 'Fix', detail: 'one fixer at a time in the main working tree, regression tests red-then-green, gate, commit' },
  ],
}

const REPO = 'C:/Users/zacgo/GitHub/SCP'
const BRANCH = 'feat/scp-v2'
const CONTEXT = `Project: SCP at ${REPO} (branch ${BRANCH}, stacked on feat/scp-v1 = PR #1). A self-hosted control plane where users store Skills (SKILL.md trees), MD documents (agent definitions, AGENTS.md, prompts, DESIGN.md, packages) and Artifacts (html/markdown/svg/mermaid/react/code), bundle them into groups, and agents pull groups over MCP (/mcp, /mcp/:group, bearer API keys or OAuth access tokens with read/write scopes and optional group restriction) or HTTP (bundle.zip, plugin.zip, /m/<key>/marketplace.json). Artifacts render only on a separate artifact origin (:8081) under a CSP sandbox. Stack: Node 24 running TypeScript natively, Hono, node:sqlite, @modelcontextprotocol/sdk 1.32.1 stateless, React 19 SPA in web/.
v2 (the code under review) added, per docs/PLAN-v2.md: zip pack + GitHub imports with provenance and update checks (server/src/imports), an OAuth 2.1 authorization server with PKCE, DCR, refresh rotation and a consent page (server/src/oauth, web/src/pages/Consent.tsx), OIDC login (server/src/auth/oidc.ts), admin settings/logs/users and blob GC (server/src/admin, server/src/items/gc.ts, server/src/audit.ts), nested groups via group_includes with a recursive CTE in access.ts (server/src/groups, server/src/access.ts), a Claude Code plugin marketplace (server/src/groups/marketplace.ts, bundle.ts buildPlugin), and the UI for all of it (web/src). The v2 diff is \`git -C ${REPO} diff 6d97c45..HEAD\` (6d97c45 is the v1 head).
Contracts: docs/PLAN.md (v1, access rules especially) and docs/PLAN-v2.md (v2; authoritative for the new surface). Tests: server/test (node:test). Gate: \`npm run gate\` from the repo root (server+web typecheck, server tests, web build). Container smoke: \`docker compose up -d --build\` then \`node scripts/smoke.mjs\` (76 checks).`

const FIX_RULES = `You are fixing CONFIRMED defects directly in the main working tree at ${REPO} (no worktree; you are the only agent editing right now). First: \`git -C ${REPO} status --short\` must be clean and \`git -C ${REPO} branch --show-current\` must be ${BRANCH}; if not, stop and report BLOCKED.
For each defect: fix the root cause in the shared function (not per caller), smallest correct diff, matching surrounding style. Add a node:test regression test in server/test that FAILS on the pre-fix source and passes after; prove red-before-green by running the new test with the source change temporarily stashed (\`git stash push -- server/src\`, run test, \`git stash pop\`). For web-only fixes there is no test runner: typecheck + build and reason carefully. If the contract changes, update docs/PLAN-v2.md (or docs/PLAN.md for v1 rules) and README.md where it documents the behaviour. If on inspection a defect is not real, skip it with a reason.
Then run \`npm run gate\` from ${REPO} until green (all tests pass, both typechecks clean, web build ok). Commit with explicit paths only (never git add -A or .), check git status + git diff --cached --stat first, message via \`git commit -F <uniquely named file in your scratchpad>\`: subject "Fix <short summary>", body listing each fix, blank line, "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>". One commit is fine. Do not push. Never write files with heredocs (use the Write tool).`

const FIX_RESULT = {
  type: 'object',
  properties: {
    commit: { type: 'string' },
    outcomes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, outcome: { type: 'string', enum: ['fixed', 'skipped'] }, note: { type: 'string' } }, required: ['id', 'outcome', 'note'] } },
    testsTotal: { type: 'number' },
    gateGreen: { type: 'boolean' },
  },
  required: ['commit', 'outcomes', 'testsTotal', 'gateGreen'],
}
const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          file: { type: 'string' }, line: { type: 'number' }, title: { type: 'string' },
          failure_scenario: { type: 'string' }, evidence: { type: 'string' }, suggested_fix: { type: 'string' },
        },
        required: ['id', 'severity', 'file', 'title', 'failure_scenario', 'evidence', 'suggested_fix'],
      },
    },
  },
  required: ['findings'],
}
const VERDICT = {
  type: 'object',
  properties: {
    confirmed: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, severity: { type: 'string' }, file: { type: 'string' }, title: { type: 'string' }, failure_scenario: { type: 'string' }, fix_notes: { type: 'string' } }, required: ['id', 'severity', 'file', 'title', 'failure_scenario', 'fix_notes'] } },
    rejected: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, why: { type: 'string' } }, required: ['id', 'why'] } },
  },
  required: ['confirmed', 'rejected'],
}

const LENSES = [
  ['authz', 'AUTHORIZATION and scoping across the v2 surface: OAuth access tokens (accepted on /mcp only, containment identical to keys, consent group restriction, revocation and refresh reuse), the marketplace token in the URL (/m/<key>/...), nested groups (does effective membership in access.ts itemReadSql ever grant more than docs/PLAN-v2.md D5 allows: owner-vouch rule, publishedSql per child, depth cap, restricted keys), admin endpoints (requireAdmin incl. restricted keys), imports (who may create items/groups/versions, source/update on items you cannot edit), and the v1 rules in docs/PLAN.md (404-not-403, write implies read).'],
  ['protocol', 'OAUTH 2.1 / OIDC PROTOCOL CORRECTNESS against the RFCs and docs/PLAN-v2.md D2/D3: PKCE verification, redirect_uri matching, code one-shot + expiry, refresh rotation and reuse detection, client auth (none / client_secret_post / basic), RFC 8414 + 9728 metadata content, resource (RFC 8707) handling, error shapes, state/nonce handling, id_token validation (alg confusion, kid handling, aud/azp, exp/iat skew, iss match), discovery SSRF limits, cookie attributes, open redirects on next= or redirect_uri. Would the MCP SDK Client, Claude.ai, Claude Desktop, VS Code and Cursor complete the flow?'],
  ['dos-ssrf', 'DENIAL OF SERVICE, RESOURCE USE and OUTBOUND REQUESTS on untrusted input: GitHub import (zipball size/time caps, redirect following to other hosts, token leakage, path filter after full unzip), OIDC discovery/JWKS fetches, regexes on user strings (URLs, refs, slugs, settings values), recursive CTE cost and depth, plugin zip cache memory (per token), marketplace building up to 200 zips per request, blob GC query cost, audit filter queries, body limits on every new route, sync work on the event loop.'],
  ['mcp-nested', 'MCP, BUNDLES and NESTED GROUPS behaviour: do the MCP tools, manifest, bundle.zip, catalog.md, plugin.zip and marketplace all agree on the effective member set and install paths; pins and installAs taken from the right edge; first-occurrence dedupe; conflicts detected (409 on include add, lints in manifest); include removal / child visibility change effects; deterministic plugin.zip bytes and sha256; .mcp.json token handling; global /mcp prompts and instructions with includes; any v1 MCP regression (run the MCP tests mentally against the new resolvedMembers).'],
  ['web-contract', 'WEB SPA vs SERVER CONTRACT for v2: web/src/api-*.ts and the new/changed pages (ImportDialog, ItemDetail source panel, Dashboard shared groups, GroupDetail includes/install-as/marketplace tab, Consent, Keys connected apps, AdminSettings, AdminLogs, AdminUsers, Login SSO button, Layout nav) against the real server routes and response shapes field by field; query params dropped or ignored; wrong methods; stale state after mutations; error handling; features that silently do nothing; a11y basics (labels, focus, keyboard).'],
  ['ingest-ops-docs', 'INGEST INTEGRITY, OPS and DOCS: imports/pack.ts detection and SAVEPOINT handling (partial failure leaves consistent state? skipped reasons accurate?), provenance columns and re-import semantics, source/update version notes, blob GC never deleting a referenced blob (concurrent writes, versions in flight), boot sweep, settings precedence env > settings > default actually implemented identically in D1/D3/D4 readers, secrets never echoed (API, audit, logs), docker-compose and README env vars vs config.ts, README/PLAN-v2 claims vs behaviour, smoke coverage gaps.'],
]

// args: { pass?: number, seen?: string[], maxRounds?: number } to continue a previous pass with its fixes known.
const PASS = (args && args.pass) || 1
const seen = [...((args && args.seen) || [])]
const rounds = []

for (let round = 1; round <= ((args && args.maxRounds) || 3); round++) {
  phase('Find')
  const seenText = seen.length ? seen.map((s) => `- ${s}`).join('\n') : '(nothing yet)'
  const found = (await parallel(LENSES.map(([key, lens]) => () =>
    agent(`${CONTEXT}\nREAD-ONLY: do not edit any repo files (throwaway probes in your scratchpad are fine, e.g. node scripts importing server modules or using server/test/helpers.ts makeTestCtx, or curl against the running container at http://localhost:8080 with a user you register).\nLens: ${lens}\nFind REAL defects in the v2 diff that the 300+ existing tests miss. A previous pass already fixed the list below in three rounds (71 fixes); the remaining defects are the ones a first reading misses, so read the actual current code, not the plan, and prefer probes over inference. Read the code; quote evidence; give a concrete failure scenario. Skip style nits. Max 8 findings, prefer fewer solid ones.\nThese were ALREADY FOUND AND FIXED in earlier rounds; do not report them or close variants of them unless the fix is incomplete (then say exactly what remains):\n${seenText}`,
      { label: `find:${key}:p${PASS}r${round}`, phase: 'Find', schema: FINDINGS })))).filter(Boolean).flatMap((r) => r.findings)
  log(`round ${round}: ${found.length} raw findings`)
  if (!found.length) { rounds.push({ round, confirmed: [], note: 'no raw findings' }); break }

  phase('Verify')
  const v = await agent(`${CONTEXT}\nREAD-ONLY (scratchpad probes allowed, never edit repo files). You are a skeptical senior engineer. Below are raw findings from 6 independent finders. For each: try hard to REFUTE it by reading the actual code and, where cheap, a quick probe. Merge duplicates (keep one id). Reject anything already fixed (list below) unless the fix is demonstrably incomplete, anything speculative, style-only, or not reachable. Default to rejected when you cannot confirm. Keep only defects worth fixing before merge, with honest severity and precise fix_notes.\nAlready fixed:\n${seenText}\nRaw findings:\n${JSON.stringify(found, null, 1)}`,
    { label: `verify:p${PASS}r${round}`, phase: 'Verify', schema: VERDICT, effort: 'xhigh' })
  const confirmed = v ? v.confirmed : []
  log(`round ${round}: ${confirmed.length} confirmed, ${v ? v.rejected.length : 0} rejected`)
  if (!confirmed.length) { rounds.push({ round, confirmed: [], rejected: v ? v.rejected.length : 0 }); break }

  phase('Fix')
  const fx = await agent(`${CONTEXT}\n\n${FIX_RULES}\n\nDefects (confirmed by a skeptic):\n${JSON.stringify(confirmed, null, 1)}`, { label: `fix:p${PASS}r${round}`, phase: 'Fix', schema: FIX_RESULT, effort: 'xhigh' })
  seen.push(...confirmed.map((f) => `${f.id}: ${f.title}`))
  rounds.push({ round, confirmed, fixed: fx })
  if (!fx || !fx.gateGreen) { log('fixer did not leave the gate green; stopping'); break }
}
return { rounds }
