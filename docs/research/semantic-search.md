# Semantic search for task-to-group matching (Kata v107): evaluation

Question: should SCP add vector search (sqlite-vec + local embeddings) next to FTS5 so an agent's
task description ("I need to make a slide deck from this CSV") finds the right group or skill
when the words do not overlap with the catalog?

## What exists

- `items_fts` / `groups_fts` (FTS5, `unicode61 remove_diacritics 2`), queried by the `search`
  MCP tool, `GET /search`, `GET /items?q=` and `GET /groups?q=`. Up to 8 words, ANDed, prefix
  match for words of 3+ characters, bm25 ranking. Bodies of the entry file are indexed, so a
  skill's own description paragraph and headings participate, not only its name.
- Progressive disclosure on the MCP side: `get_group` returns the catalog (name + description
  per item, 50 per page), which is how Claude Code and friends pick a skill today. The model
  does the matching; the catalog is a few KB.

## What vector search would need

| Piece | Cost |
|---|---|
| `sqlite-vec` extension | native binary per platform in the image; `node:sqlite` needs `allowExtension: true` + `loadExtension()`, which also lifts the extension-loading safety for every connection |
| Local embedding model | no hosted LLM calls (CLAUDE.md rule), so an ONNX model in the container: `all-MiniLM-L6-v2` is about 90 MB (quantized about 23 MB) plus `onnxruntime-node` (about 50 MB of native libs); first-boot download or a 150 MB bigger image |
| Indexing | embed every item version's entry text and every group's description/instructions on write; re-embed on model change |
| Query path | embed the query (about 20 to 60 ms on CPU), kNN over vectors, merge with bm25 (reciprocal rank fusion) |

Roughly 300 lines of code, two native dependencies, a 2x to 3x image, and a model lifecycle to
maintain.

## Evidence on the keyword path

The smoke test and the MCP tests already exercise discovery by task words (`search` for "deck",
"dashboard", "review"); every lookup resolves because descriptions name what the item does.
Skill authors are told (SKILL.md spec, docs/research/formats.md 2.2) to write descriptions that
say when to use the skill, which is exactly the text FTS indexes. No user report of a missed
match exists yet; the ticket itself says "if keyword discovery proves weak".

Cheaper improvements that keep FTS5, should it prove weak:

1. Index frontmatter `tags` and `category` with higher bm25 weights (one line in the query).
2. A synonyms table per instance (`deck -> slides, presentation, pptx`), expanded at query time.
3. Let `search` fall back to OR-matching when the AND query returns nothing (one extra query).

## Conclusion

Not now. The deterministic cost (two native deps, image size, a model to ship and re-embed
with) is high, and the trigger in the ticket has not fired: keyword discovery has not been shown
weak on real catalogs. Re-open when a real catalog shows missed matches that the three cheap
improvements above cannot fix; the design then is sqlite-vec + a quantized MiniLM in the image,
fused with bm25 by reciprocal rank.
