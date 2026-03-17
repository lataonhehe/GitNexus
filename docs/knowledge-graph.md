# Knowledge Graph — Schema Reference

GitNexus builds a property graph of your codebase stored in **LadybugDB** (embedded graph database). This document describes every node type, relationship type, and property — the complete schema that powers all MCP tools, Cypher queries, and the Web UI.

---

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Knowledge Graph                          │
│                                                                 │
│   File System          Code Symbols          Intelligence       │
│   ───────────          ────────────          ───────────        │
│   Folder               Function              Community          │
│   File                 Class                 Process            │
│                        Method                                   │
│                        Interface          Git History           │
│                        Enum               ───────────           │
│                        Struct             Commit                │
│                        ...26 types        Author                │
│                                           Branch                │
└─────────────────────────────────────────────────────────────────┘
```

The graph has **3 layers**:

| Layer | Node Types | Purpose |
|-------|-----------|---------|
| **File System** | `Folder`, `File` | Structural skeleton of the repo |
| **Code Symbols** | `Function`, `Class`, `Method`, `Interface`, `Enum`, `Struct` … (26 types) | Parsed AST symbols from source files |
| **Intelligence** | `Community`, `Process` | Computed clusters and execution flows |
| **Git History** | `Commit`, `Author`, `Branch` | VCS timeline and contributors |

All relationships are stored in a single `CodeRelation` table with a `type` property, allowing natural Cypher queries:

```cypher
MATCH (f:Function)-[r:CodeRelation {type: 'CALLS'}]->(g:Function)
RETURN f.name, g.name, r.confidence
```

---

## Node Types

### File System

#### `Folder`
Represents a directory in the repository.

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | `"Folder:<relativePath>"` |
| `name` | string | Directory name |
| `filePath` | string | Path relative to repo root |

#### `File`
Represents a source file.

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | `"File:<relativePath>"` |
| `name` | string | File name with extension |
| `filePath` | string | Path relative to repo root |
| `content` | string | Full source text |

---

### Code Symbols

All code symbol nodes share a common base set of properties. Language-specific types (e.g. `Struct`, `Trait`, `Impl`) use the same base schema.

**Common properties:**

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | `"<Label>:<filePath>:<symbolName>"` |
| `name` | string | Symbol name as declared in source |
| `filePath` | string | Source file (relative to repo root) |
| `startLine` | int | First line of the symbol definition |
| `endLine` | int | Last line of the symbol definition |
| `isExported` | bool | Whether the symbol is publicly exported |
| `content` | string | Raw source text of the symbol |
| `description` | string | Doc comment / JSDoc / docstring |

#### `Function`
A standalone function or arrow function.

#### `Class`
A class definition (OOP). Extended properties:
- inherits from common properties above.

#### `Method`
A method inside a class or impl block. Extended properties:

| Property | Type | Description |
|----------|------|-------------|
| `parameterCount` | int | Number of declared parameters |
| `returnType` | string | Declared return type (if available) |

#### `Interface`
A TypeScript/Java/C# interface, Go interface, or Rust trait signature.

#### `Constructor`
An explicit constructor (`__init__`, `constructor`, etc.).

#### `Enum`
An enumeration type.

#### `Struct`
A struct (C/C++/Rust/Go).

#### `Trait`
A Rust/PHP/Scala trait.

#### `Impl`
A Rust `impl` block or similar implementation block.

#### `TypeAlias`
A type alias (`type X = Y` in TypeScript/Rust/Go).

#### `Macro`
A preprocessor macro (C/C++) or Rust macro.

#### `Typedef`
A C/C++ `typedef`.

#### `Union`
A C/C++/Rust union type.

#### `Namespace`
A C++/C#/PHP namespace or Python package.

#### `Module`
A module declaration (Rust `mod`, Node module, etc.).

#### `Const` / `Static`
Compile-time or module-level constants.

#### `Property`
A class field or struct field.

#### `Record`
A C# record type or Java record.

#### `Delegate`
A C# delegate type.

#### `Annotation`
A Java annotation type declaration.

#### `Template`
A C++ template.

#### `CodeElement`
Generic fallback for any parsed symbol that doesn't fit a more specific label.

---

### Intelligence Nodes

#### `Community`
A functional cluster detected by the Leiden community-detection algorithm. Groups semantically related symbols.

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | `"Community:<label>"` |
| `name` / `label` | string | Internal cluster label |
| `heuristicLabel` | string | Human-readable label (e.g. `"Authentication"`) |
| `keywords` | string[] | Top keywords describing the cluster |
| `description` | string | LLM-generated or heuristic summary |
| `enrichedBy` | string | `"heuristic"` or `"llm"` |
| `cohesion` | float | Inter-community edge density (0–1) |
| `symbolCount` | int | Number of symbols in the cluster |

#### `Process`
An execution flow traced from an entry point through call chains.

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | `"Process:<label>"` |
| `name` / `label` | string | Internal flow label |
| `heuristicLabel` | string | Human-readable name (e.g. `"LoginFlow"`) |
| `processType` | string | `"intra_community"` or `"cross_community"` |
| `stepCount` | int | Number of steps in the trace |
| `communities` | string[] | Community IDs this process spans |
| `entryPointId` | string | Node ID of the entry symbol |
| `terminalId` | string | Node ID of the terminal symbol |

---

### Git History Nodes

Populated when indexing with `--git-history`. Up to **200 recent commits** are included.

#### `Commit`
A single git commit.

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | `"Commit:<fullSHA>"` |
| `name` | string | Short SHA (first 8 chars) |
| `sha` | string | Full 40-char SHA |
| `message` | string | Commit message (max 200 chars) |
| `authorName` | string | Display name of the author |
| `authorEmail` | string | Email of the author |
| `timestamp` | int | Unix epoch seconds |
| `filesChanged` | int | Number of files touched in this commit |

#### `Author`
A unique contributor identified by email address.

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | `"Author:<email>"` |
| `name` | string | Display name (from most recent commit) |
| `email` | string | Email address (unique key) |
| `commitCount` | int | Total commits by this author in the last 200 |

#### `Branch`
The current HEAD branch at time of indexing.

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | `"Branch:<branchName>"` |
| `name` | string | Branch name (e.g. `"main"`) |
| `isCurrent` | bool | Always `true` (only current branch is indexed) |

---

## Relationship Types

All relationships are stored in the `CodeRelation` table with properties:

| Property | Type | Description |
|----------|------|-------------|
| `type` | string | One of the types listed below |
| `confidence` | float | 0.0–1.0 (1.0 = certain) |
| `reason` | string | Resolution method (e.g. `"import-resolved"`, `"same-file"`, `"git-log"`) |
| `step` | int | Step index for `STEP_IN_PROCESS` only |

### File System Relationships

| Type | From → To | Description |
|------|-----------|-------------|
| `CONTAINS` | `Folder → Folder` | Subdirectory nesting |
| `CONTAINS` | `Folder → File` | File inside a directory |
| `DEFINES` | `File → <symbol>` | File declares this symbol |

### Code Relationships

| Type | From → To | Description |
|------|-----------|-------------|
| `IMPORTS` | `File → File` | File imports another file |
| `IMPORTS` | `File → <symbol>` | File imports a specific symbol |
| `CALLS` | `<callable> → <callable>` | Function/method calls another callable |
| `EXTENDS` | `Class → Class` | Class inheritance |
| `IMPLEMENTS` | `Class → Interface` | Class implements an interface |
| `HAS_METHOD` | `Class → Method` | Class owns a method |
| `OVERRIDES` | `Method → Method` | Method overrides a parent method |
| `MEMBER_OF` | `<symbol> → Community` | Symbol belongs to a cluster |

### Intelligence Relationships

| Type | From → To | Description |
|------|-----------|-------------|
| `STEP_IN_PROCESS` | `<callable> → Process` | Symbol is a step in an execution flow |

### Git History Relationships

| Type | From → To | Description |
|------|-----------|-------------|
| `AUTHORED` | `Author → Commit` | Author created this commit |
| `ON_BRANCH` | `Branch → Commit` | Commit is on this branch |
| `MODIFIED` | `Commit → File` | Commit changed this file |
| `PRECEDES` | `Commit → Commit` | Older commit precedes a newer one (timeline chain) |

---

## Node ID Format

Node IDs follow a consistent prefix pattern:

| Label | ID Format | Example |
|-------|-----------|---------|
| `Folder` | `Folder:<relPath>` | `Folder:src/utils` |
| `File` | `File:<relPath>` | `File:src/utils/parse.ts` |
| `Function` | `Function:<filePath>:<name>` | `Function:src/auth.ts:validateUser` |
| `Class` | `Class:<filePath>:<name>` | `Class:src/services/user.ts:UserService` |
| `Method` | `Method:<filePath>:<name>` | `Method:src/services/user.ts:save` |
| `Community` | `Community:<label>` | `Community:auth_cluster_0` |
| `Process` | `Process:<label>` | `Process:proc_login` |
| `Commit` | `Commit:<fullSHA>` | `Commit:6c18ae08f748...` |
| `Author` | `Author:<email>` | `Author:dev@example.com` |
| `Branch` | `Branch:<name>` | `Branch:main` |

Paths are always **relative to the git repository root** and use **forward slashes** on all platforms.

---

## Graph Shape (Visual Summary)

```
Branch ──ON_BRANCH──► Commit ──PRECEDES──► Commit ──PRECEDES──► ...
                        │                    │
                   AUTHORED◄──Author    MODIFIED
                        │                    │
                        └────────────────────▼
Folder ──CONTAINS──► File ◄──DEFINES──── Function ──CALLS──► Function
   │                   │                     │
CONTAINS           IMPORTS               MEMBER_OF
   │                   │                     │
Folder              File               Community
                                             ▲
                              Class ──MEMBER_OF
                                │
                           HAS_METHOD
                                │
                             Method ──STEP_IN_PROCESS──► Process
```

---

## Cypher Query Examples

### Find all functions in a file
```cypher
MATCH (file:File {name: 'auth.ts'})-[:CodeRelation {type: 'DEFINES'}]->(fn:Function)
RETURN fn.name, fn.startLine, fn.description
```

### Find what calls a specific function
```cypher
MATCH (caller)-[r:CodeRelation {type: 'CALLS'}]->(fn:Function {name: 'validateUser'})
WHERE r.confidence > 0.7
RETURN caller.name, caller.filePath, r.confidence
ORDER BY r.confidence DESC
```

### Find all files changed in the last 10 commits
```cypher
MATCH (c:Commit)-[:CodeRelation {type: 'MODIFIED'}]->(f:File)
WITH c, f ORDER BY c.timestamp DESC
RETURN c.name, c.message, collect(f.name) AS files
LIMIT 10
```

### Find the most active contributors
```cypher
MATCH (a:Author)
RETURN a.name, a.email, a.commitCount
ORDER BY a.commitCount DESC
LIMIT 10
```

### Trace a commit chain (timeline)
```cypher
MATCH path = (old:Commit)-[:CodeRelation {type: 'PRECEDES'}*1..5]->(new:Commit)
WHERE old.name = 'abc12345'
RETURN [n IN nodes(path) | n.name + ': ' + n.message] AS chain
```

### Find which community a function belongs to
```cypher
MATCH (fn:Function {name: 'processPayment'})-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
RETURN fn.name, c.heuristicLabel, c.cohesion, c.symbolCount
```

### Find all execution flows passing through a method
```cypher
MATCH (m:Method {name: 'save'})-[:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
RETURN m.name, p.heuristicLabel, p.stepCount, p.processType
```

### Find all files a given author touched
```cypher
MATCH (a:Author {email: 'dev@example.com'})-[:CodeRelation {type: 'AUTHORED'}]->
      (c:Commit)-[:CodeRelation {type: 'MODIFIED'}]->(f:File)
RETURN DISTINCT f.filePath
ORDER BY f.filePath
```

---

## Confidence Scoring

`CALLS` relationships carry a `confidence` score (0.0–1.0) based on how the call was resolved:

| Score | `reason` | Meaning |
|-------|----------|---------|
| `1.0` | `import-resolved` | Call target was found via explicit import |
| `0.9` | `same-file` | Call target is defined in the same file |
| `0.7` | `type-annotation` | Target inferred from type annotation |
| `0.5` | `constructor-inferred` | Target inferred from constructor call pattern |
| `0.3` | `fuzzy-global` | Target matched by name globally (may be wrong) |
| `1.0` | `git-log` | Git history relationship (always certain) |

---

## Index Limits

| Constraint | Value |
|-----------|-------|
| Max commits indexed (`--git-history`) | 200 most recent |
| Max branches indexed | 1 (current HEAD only) |
| Git path base | Relative to git repository root |
| Embedding dimensions | 384 (all-MiniLM-L6-v2) |
