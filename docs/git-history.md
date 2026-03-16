# Git History in GitNexus

GitNexus can index your repository's git commit history into the knowledge graph, giving AI agents and developers the ability to query **who changed what, when, and on which branch**.

---

## Quick Start

```bash
# Index with git history (force re-index if already indexed)
npx gitnexus analyze --git-history --force
```

---

## What Gets Added to the Graph

Three new node types and three new relationship types are added alongside the existing code graph:

### Node Types

| Node | Properties | Description |
|------|-----------|-------------|
| `Author` | `name`, `email`, `commitCount` | A git contributor |
| `Commit` | `sha` (full), `name` (short 8-char), `message`, `timestamp`, `filesChanged` | A single commit snapshot |
| `Branch` | `name`, `isCurrent` | The current branch at index time |

### Relationship Types

| Relationship | Direction | Meaning |
|-------------|-----------|---------|
| `AUTHORED` | `Author → Commit` | This author created this commit |
| `ON_BRANCH` | `Branch → Commit` | This commit is on this branch |
| `MODIFIED` | `Commit → File` | This commit changed this file |

### Graph Shape

```
Author ──[AUTHORED]──► Commit ──[MODIFIED]──► File
                          ▲
Branch ──[ON_BRANCH]──────┘
```

---

## Cypher Query Examples

After indexing with `--git-history`, you can run these Cypher queries via:
- **Web UI** → Filter panel → Cypher query box
- **MCP tool**: `gitnexus_cypher({query: "..."})`
- **CLI**: `npx gitnexus cypher "..."`

### Most active contributors

```cypher
MATCH (a:Author)-[:AUTHORED]->(c:Commit)
RETURN a.name, count(c) AS commits
ORDER BY commits DESC
LIMIT 10
```

### Recent commits on current branch

```cypher
MATCH (b:Branch)-[:ON_BRANCH]->(c:Commit)
RETURN c.name AS sha, c.message, c.timestamp
ORDER BY c.timestamp DESC
LIMIT 20
```

### Files changed most frequently

```cypher
MATCH (c:Commit)-[:MODIFIED]->(f:File)
RETURN f.name, f.filePath, count(c) AS changeCount
ORDER BY changeCount DESC
LIMIT 15
```

### Who last touched a specific file

```cypher
MATCH (a:Author)-[:AUTHORED]->(c:Commit)-[:MODIFIED]->(f:File)
WHERE f.filePath CONTAINS 'pipeline.ts'
RETURN a.name, a.email, c.message, c.timestamp
ORDER BY c.timestamp DESC
LIMIT 5
```

### All files changed by a specific author

```cypher
MATCH (a:Author)-[:AUTHORED]->(c:Commit)-[:MODIFIED]->(f:File)
WHERE a.email = 'dev@example.com'
RETURN DISTINCT f.filePath
ORDER BY f.filePath
```

### Commits that touched the most files (risky changes)

```cypher
MATCH (c:Commit)-[:MODIFIED]->(f:File)
RETURN c.name AS sha, c.message, count(f) AS filesChanged
ORDER BY filesChanged DESC
LIMIT 10
```

---

## Web UI — Filter Panel

After indexing with `--git-history`, two new sections appear in the **Filters** panel (left sidebar):

### Git History (Node Types)
| Node | Color | Toggle |
|------|-------|--------|
| `Commit` | Amber | Show/hide commit nodes |
| `Branch` | Cyan | Show/hide branch nodes |
| `Author` | Lime | Show/hide author nodes |

### Git Relationships (Edge Types)
| Edge | Color | Toggle |
|------|-------|--------|
| `Modified` | Amber | `Commit → File` edges |
| `Authored` | Lime | `Author → Commit` edges |
| `On Branch` | Cyan | `Branch → Commit` edges |

---

## Limits & Behavior

| Setting | Value | Notes |
|---------|-------|-------|
| Max commits indexed | **200** | Most recent commits |
| Branches indexed | **1** (current HEAD branch) | The branch active at index time |
| File matching | Only files present in graph | Deleted/renamed files are skipped |
| Error handling | Silent skip | If not a git repo, phase is skipped without error |

---

## Re-indexing

Because the pipeline checks if the current commit SHA matches the stored one, `analyze --git-history` alone will return **"Already up to date"** if no new commits exist. Use `--force` to rebuild:

```bash
# First time or after new commits
npx gitnexus analyze --git-history

# Force rebuild (e.g. toggling --git-history on an existing index)
npx gitnexus analyze --git-history --force
```

---

## Implementation Details

For contributors who want to understand or extend this feature:

| File | Role |
|------|------|
| `gitnexus/src/core/ingestion/git-history-processor.ts` | Parses `git log`, creates nodes/edges |
| `gitnexus/src/core/graph/types.ts` | Declares `Commit`, `Branch`, `Author` NodeLabel and `MODIFIED`, `AUTHORED`, `ON_BRANCH` RelationshipType |
| `gitnexus/src/core/lbug/schema.ts` | LadybugDB table schemas for the 3 new node types |
| `gitnexus/src/core/lbug/csv-generator.ts` | CSV row generation for Commit/Author/Branch nodes |
| `gitnexus/src/core/lbug/lbug-adapter.ts` | `getCopyQuery` cases for Commit/Author/Branch |
| `gitnexus/src/core/ingestion/pipeline.ts` | Phase 0 — calls `processGitHistory` when `gitHistory: true` |
| `gitnexus/src/cli/analyze.ts` | `--git-history` flag wired to `PipelineOptions` |
| `gitnexus/src/server/api.ts` | `buildGraph` queries for Commit/Author/Branch with correct properties |
| `gitnexus-web/src/core/graph/types.ts` | Web copy of types — same additions |
| `gitnexus-web/src/lib/constants.ts` | Colors, sizes, filter labels, edge info for new types |
| `gitnexus-web/src/components/FileTreePanel.tsx` | Filter panel UI — Git History sections |
