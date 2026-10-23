import type { FileIn, Format, Kind } from './api.ts';

/** Kinds edited as a file tree; the rest are one entry file. */
export const MULTI_FILE_KINDS: Kind[] = ['skill', 'package', 'design'];

const ARTIFACT_ENTRY: Record<Format, string> = {
  html: 'index.html',
  markdown: 'index.md',
  svg: 'image.svg',
  mermaid: 'diagram.mmd',
  react: 'App.jsx',
  code: 'source.txt',
};

/** Entry file path per PLAN.md "Item rules". `name` is the (possibly derived) item name. */
export function entryPath(kind: Kind, format: Format, name: string): string {
  switch (kind) {
    case 'skill':
      return 'SKILL.md';
    case 'instructions':
      return 'AGENTS.md';
    case 'design':
      return 'DESIGN.md';
    case 'package':
      return 'README.md';
    case 'artifact':
      return ARTIFACT_ENTRY[format];
    default:
      return `${name || kind}.md`;
  }
}

/** Mirrors the server's derivation: frontmatter `name`, else a slug of the title. */
export function deriveName(content: string, title: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  const fromFm = fm && /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(fm)?.[1];
  return slug(fromFm || title);
}

export const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

const SKILL = `---
name: my-skill
description: What this skill does and when an agent should use it. Be specific about the trigger.
---

# My skill

## When to use

- ...

## Steps

1. ...
`;

const AGENT = `---
name: my-agent
description: Use this agent when ... Give concrete trigger phrases.
tools: Read, Grep, Glob, Bash
model: sonnet
---

You are a specialist in ...

## Process

1. ...

## Output

Return ...
`;

const COMMAND = `---
description: One line shown in the command menu
argument-hint: [target]
---

Do the following for $ARGUMENTS:

1. ...
`;

// Not "# AGENTS.md": a claude-code bundle installs this file as CLAUDE.md, a codex one as AGENTS.md.
const INSTRUCTIONS = `# Project instructions

## Project overview

What this repository is and how it is laid out.

## Commands

- Build: \`...\`
- Test: \`...\`

## Conventions

- ...

## Boundaries

- Never ...
`;

const DESIGN = `---
name: my-design-system
colors:
  primary: "#2f5bea"
  background: "#ffffff"
  text: "#1b1f24"
typography:
  body: "Inter, system-ui, sans-serif"
  mono: "JetBrains Mono, monospace"
---

# Design system

## 1. Visual theme and atmosphere

## 2. Color palette and roles

## 3. Typography rules

## 4. Component styling

## 5. Layout principles

## 6. Depth and elevation

## 7. Do's and don'ts

## 8. Responsive behavior
`;

const PROMPT = `---
description: Summarize a document for a given audience
arguments:
  - name: audience
    description: Who the summary is for
    required: true
  - name: length
    description: Target length, e.g. "5 bullets"
    required: false
---

Summarize the following for {{audience}} in {{length}}.
`;

const PACKAGE = `# My package

What this package contains and how to install it.
`;

const ARTIFACT: Record<Format, string> = {
  html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>My artifact</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.5; }
  </style>
</head>
<body>
  <h1>My artifact</h1>
  <p>Self-contained HTML: inline styles and scripts.</p>
</body>
</html>
`,
  markdown: `# My document\n\nWrite Markdown here.\n`,
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">
  <rect width="200" height="100" rx="12" fill="#2f5bea"/>
  <text x="100" y="58" font-family="system-ui" font-size="20" fill="#fff" text-anchor="middle">Hello</text>
</svg>
`,
  mermaid: `flowchart LR\n  A[Start] --> B{Decide}\n  B -->|yes| C[Do it]\n  B -->|no| D[Skip]\n`,
  react: `export default function App() {\n  return <h1>Hello from React</h1>;\n}\n`,
  code: `// Paste code here\n`,
};

/** Starting files for a new item of this kind. */
export function templateFiles(kind: Kind, format: Format): FileIn[] {
  const content: Record<Kind, string> = {
    skill: SKILL,
    agent: AGENT,
    command: COMMAND,
    instructions: INSTRUCTIONS,
    design: DESIGN,
    prompt: PROMPT,
    package: PACKAGE,
    artifact: ARTIFACT[format],
  };
  return [{ path: entryPath(kind, format, ''), content: content[kind] }];
}
