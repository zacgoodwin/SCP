# Research: "Introducing Skills via an MCP Control Plane" (ByteBridge)

Source: https://bytebridge.medium.com/introducing-skills-via-an-mcp-control-plane-406c979d5975
Fetched via https://r.jina.ai/ (medium.com returned 403). Content below is a
paraphrased extraction, not a transcript. Supplemented with the two specs the
article leans on:

- Agent Skills spec: https://agentskills.io/specification
- Peta Core (the article's named reference implementation): https://github.com/dunialabs/peta-core , docs https://docs.peta.io/

Sections 1 to 6 are the article. Section 7 adds detail from the spec and Peta.
Section 8 is our synthesis for SCP and is labelled as such.

---

## 1. Thesis

- Skills should be governed, versioned capabilities served from a central
  **control plane**. Agents become thin clients that discover a skill and
  load or invoke it on demand.
- MCP is the transport/pattern (host, client, server roles over JSON-RPC 2.0).
  The article treats MCP like LSP: a standard wire format, not a governance
  system. MCP alone gives interoperability, **not** access control or audit.
- The win is **governance and operability**, not smarter agents. You only get
  that win if the control plane runs as production infrastructure.

## 2. Core concepts

### 2.1 Skill package (open format)
- A skill is a directory: `SKILL.md` (YAML front matter + Markdown
  instructions) plus optional `scripts/`, `references/`, `assets/`.
- Front matter should carry a **tight scope and trigger description**, so the
  catalog entry alone tells an agent when the skill applies.
- `allowed-tools` front-matter field is mentioned as optional and experimental.

### 2.2 Two skill classes (drives the whole risk model)
| Class | What it does | Controls needed |
|---|---|---|
| Instruction skill | Guidance only (procedures, checklists, references). No side effects | Versioning, catalog, light auth |
| Action skill | Also produces effects (calls APIs, mutates systems) | Identity, authorization, approval gates, secret injection, audit |

SCP note: SCP's three content types (skills, MDs, artifacts) are all
**instruction-class** content when served. The heavy action-skill machinery
(secret injection, payment approval) mostly does not apply. What does apply:
the one write path, agents writing artifacts back.

### 2.3 Control plane vs data plane
- **Control plane:** registry, policy, identity, secret injection, audit.
- **Data plane:** actually runs the skill logic (or, for SCP, serves content).
- Splitting them lets one policy layer govern many agents. The article cites
  Kong Gateway as the model: the data plane caches config pulled from the
  control plane and keeps serving when the control plane is down.

### 2.4 Progressive disclosure
Three stages. The article labels only the first "Tier 1". The spec numbers all three.
1. **Catalog** (Tier 1): name + description for every available skill, loaded up front.
2. **Instructions:** the full `SKILL.md` body, loaded only when the skill is activated.
3. **Resources:** files from `scripts/`, `references/`, `assets/`, loaded on demand.

Why it matters: token cost, and **less exposure**. An agent never sees the
contents of a skill it does not activate.

### 2.5 Namespaces, deferred loading, tool search
- Tool definitions can be **deferred** and found through tool search or
  loaded per namespace, which keeps the starting token overhead small.
- Cites OpenAI's namespace grouping and tool search as precedents.
- Rollout guidance: once the catalog grows, group skills into namespaces and
  rely on search instead of listing everything.

SCP note: this maps directly onto **groups**. A group is a namespace. An
agent should pull a small group catalog, not the whole registry.

## 3. Skill tool contract

Each skill gets a stable contract, treated like an API. Four parts (the
article lists areas, not a formal schema):

| Area | Contents |
|---|---|
| Inputs / outputs | Required structured params, output schema |
| Side effects | What external state it can change |
| Security requirements | Permission scopes, whether human approval is required, data-retention expectations |
| Non-functional budgets | Latency target, cost limit, expected volume |

Lifecycle rules:
- Version contracts like APIs, with **deprecation windows**.
- Environments (dev / staging / prod) are **first class** in both routing and policy.

## 4. Worked example: "Refund Order" (`refund-order`)

- Behavior: read order, check eligibility, execute refund at the payment
  processor, write a case note.
- Package: `SKILL.md` holds boundaries (refund only when the conditions hold),
  a checklist, and edge cases. A references file holds policy detail.
  Optional scripts hold the proration math.
- Serving: exposed as **one governed tool contract**. The runtime calls the
  internal and payment services.
- Policy: refunds above a threshold are **denied unless a human approves**.
  No threshold value is given.
- Secrets: payment credentials are **injected server-side**. The agent never holds them.
- Audit: request, policy decision, approval, and outcome are logged.

## 5. Migration / adoption steps (article's sequence)

1. **Inventory and risk-classify** existing skills: what data each touches,
   its side effects, how it fails.
2. **Normalize** into the open package format, with clear scope and triggers.
3. **Build eval harnesses first:** compare behavior with and without the
   skill, *before* changing runtime architecture.
4. **Define the tool contract** per skill (section 3).
5. **Expose** each skill through an MCP server, or an adapter over an existing API.
6. **Add the control plane incrementally:** registry, routing, policy
   enforcement, secrets, audit.
7. **Run old and new paths in parallel** and compare. Shift traffic and
   retire embedded skills once SLO and safety targets are met.

Rollout order: packaging and evals, then a read-only pilot tier, then policy
and secrets, then approvals for high-risk writes, then namespaces and deferred
loading, then SLO-gated rollouts.

## 6. Governance, security, operations

### 6.1 Identity / policy
- RBAC and/or ABAC. Least-privilege scopes.
- Approval gates on high-impact writes.
- Short-lived tokens. Agents carry **gateway tokens only** (a Peta pattern),
  never downstream credentials.
- Zero-trust at the gateway (NIST SP 800-207).
- The article does not mention OAuth, OPA, or SSO by name.

### 6.2 Threat model
- LLM-specific risks: **prompt injection** and **insecure output handling**
  (OWASP Top 10 for LLM Applications). Also NIST AI RMF.
- Keep secrets out of prompts and out of logs.
- Supply chain for skill packages: SLSA is cited.
- A control plane **moves** the attack surface, it does not remove it.
  Centralized policy also means centralized blast radius.

### 6.3 Audit fields
Caller identity, tool name, tool **version**, policy decision, approval
status, outcome, plus enough context to investigate later. Never secrets.

### 6.4 Observability
- One trace chain: agent request, then tool call, then policy decision, then
  downstream execution. OpenTelemetry for traces, metrics, and logs.
- Golden signals: latency, traffic, errors, saturation (Google SRE).
- SLOs per **skill class** (read vs write, critical vs non-critical). Error
  budgets gate rollouts. No numeric targets are given.

### 6.5 Degradation
- When the control plane is impaired, **read-only operations keep working**
  (cached), and **risky writes fail safe** (they are refused).

### 6.6 Testing
Test three things separately: skill packages, contracts, policies.

### 6.7 Alternatives the article weighs (its prose, tabulated)
| Approach | Fits when | Cost |
|---|---|---|
| Skills embedded in each agent | One agent, low risk, speed matters | Duplication, inconsistent permissions, weak audit |
| Direct tool calling, no control plane | API governance already strong | Agents hold credentials, brittle tool surfaces |
| MCP without a governance layer | Quick interop, low regulatory pressure | No enterprise access control or audit |
| Namespaces + tool search in one runtime | Middle step before a full control plane | Weaker central governance |

Costs of the control-plane approach: more infrastructure, new failure modes,
blast radius, a shifted attack surface, and ownership changes in the org.

## 7. Supporting specs (verified)

### 7.1 Agent Skills `SKILL.md` front matter (agentskills.io/specification)
| Field | Req | Constraint |
|---|---|---|
| `name` | yes | 1-64 chars, `[a-z0-9-]`, no leading/trailing hyphen, no `--`, **must equal parent dir name** |
| `description` | yes | 1-1024 chars. What it does and when to use it, with trigger keywords |
| `license` | no | Short name or bundled-file reference |
| `compatibility` | no | 1-500 chars. Environment requirements |
| `metadata` | no | Map of string to string (e.g. `author`, `version`) |
| `allowed-tools` | no | Space-separated, experimental, e.g. `Bash(git:*) Read` |

Validation regex for `name`: `^[a-z0-9]+(-[a-z0-9]+)*$` (max 64).
Disclosure budgets: metadata about 100 tokens, `SKILL.md` body under 5000
tokens recommended (under 500 lines), resources on demand. File references
are relative paths, **one level deep** from `SKILL.md`.
Validator: `skills-ref validate ./my-skill`
(https://github.com/agentskills/agentskills/tree/main/skills-ref).
Note: the spec has no `version` field. Versions go in `metadata.version`
or are tracked by the control plane.

### 7.2 Peta Core (reference implementation the article names)
Repo: https://github.com/dunialabs/peta-core (Elastic License 2.0, so it
cannot be offered as a managed service to third parties. Use it for ideas,
not as a dependency.)
- Gateway in front of MCP servers. Upstream it is an MCP server, downstream
  an MCP client. Tools are namespaced `serverId::toolName`.
- **Skills:** per-server ZIP bundles with `SKILL.md` metadata, served as
  namespaced MCP tools.
- Auth: built-in OAuth 2.0 server (auth code + PKCE, refresh, dynamic client
  registration, introspection, revocation). `/mcp` is authenticated.
  `/mcp/public` allows rate-limited anonymous access.
- Discovery modes: `FLAT` (all tools exposed), `HYBRID`, `STRICT` (tools
  reachable only through catalog search). This is progressive disclosure at
  the tool-list level.
- Policy: per-user, per-tool RBAC/ABAC, content-aware DSL conditions,
  sliding-window quotas, optional per-workspace IP allow-lists.
- Approvals: durable queue with lifecycle states and replay-safe retries,
  pushed over Socket.IO to the Peta Desk desktop app.
- Vault: PBKDF2 + AES-GCM at rest. Credentials are injected at execution time.
- Audit: caller, tool, policy decision, approval status, outcome. Pino JSON
  logs with webhook export.
- Deploy: Dockerfile + docker-compose. Postgres 15+ (Prisma). Node 20+ / TS 5.

## 8. Implications for SCP (synthesis, not from the article)

### 8.1 Proposed MCP tool surface (progressive disclosure over groups)
The agent's token binds it to one or more groups, so every call is
group-scoped by default.

| Tool | Tier | Returns |
|---|---|---|
| `list_groups` | 0 | Groups this token can read: `{slug, name, description, counts}` |
| `get_group_manifest(group)` | 1 | Catalog only: per item `{kind: skill\|md\|artifact, slug, name, description, version, tags}`. No bodies |
| `search(query, kind?, group?, tags?)` | 1 | Ranked catalog entries (SQLite FTS5 over name, description, tags) |
| `get_skill(slug, version?)` | 2 | `SKILL.md` text + file index `[{path, size, sha256}]` |
| `get_skill_file(slug, path, version?)` | 3 | One resource file |
| `get_md(slug, version?)` | 2 | Markdown body + front matter (AGENTS.md, agent def, prompt, DESIGN.md) |
| `get_artifact(slug, version?)` | 2 | Artifact metadata + content, or a `ui://` resource for MCP Apps |
| `create_artifact(...)` / `update_artifact(slug, ...)` | write | New immutable version. Needs `artifacts:write` scope |

Also expose the same content as MCP **resources** (for example
`scp://group/{g}/skill/{slug}`), plus a plain HTTP mirror for non-MCP agents:
- `GET /api/v1/groups/{g}/manifest`
- `GET /api/v1/skills/{slug}[@ver]` and `GET /api/v1/skills/{slug}/bundle.zip`
- `GET /api/v1/md/{slug}[@ver]`
- `POST /api/v1/artifacts`
- `GET /a/{share_token}` (public artifact link)

Bundle download (`bundle.zip`) is the "pull a package" path: an agent can
install a whole group's skills locally to `.claude/skills/<name>/`.

### 8.2 Data model hints
- `items(id, kind, slug, owner_id, visibility)`
- `item_versions(item_id, version, content_sha256, created_by, created_at, changelog)`:
  immutable. The latest version is a pointer, not an update in place.
- `item_files(version_id, path, sha256, bytes)` for skill resources.
- `groups(id, slug, owner_id)` and `group_items(group_id, item_id, pinned_version NULL)`:
  a group can pin a version (stable) or float on the latest. Pinning is how
  "versioning with deprecation windows" lands in SCP.
- `api_tokens(id, user_id, hash, scopes, group_ids, expires_at)`: store a
  hash only. Short-lived, scoped. This is the gateway-token pattern.
- `audit_log(ts, actor_type user|agent, actor_id, token_id, action, item, version, group, decision, outcome, ip)`.
  Never store token values or content bodies.
- `artifact_shares(artifact_id, token, created_by, expires_at, revoked_at)`.

### 8.3 Validation / governance to build in
- Enforce the `SKILL.md` name regex, the dir-name match, and the
  description and compatibility length limits on upload. Warn when a body
  goes over 500 lines.
- Scopes, minimum set: `read`, `artifacts:write`, `admin`. Group membership
  roles: `owner`, `editor`, `viewer`.
- Agent writes go to **artifacts only**, and always as new versions, so a
  bad write never destroys earlier content.
- Treat every agent-written artifact as untrusted. Serve its HTML from a
  sandboxed origin or a `sandbox` iframe with a strict CSP, because a public
  link plus agent-written HTML is the prompt-injection and insecure-output
  risk the article names.
- Read paths stay up when anything else degrades. Writes fail closed.
- Record per-call latency and errors (the golden signals) in a log line.
  Defer OTel.

### 8.4 Out of scope for SCP v1 (the article's action-skill machinery)
Secret vault and injection, human approval queues, ABAC DSLs, per-skill cost
budgets. Add them if SCP ever executes skills server-side instead of
serving content.
