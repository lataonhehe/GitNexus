# GitNexus Server HTTP API

This document describes the REST endpoints hosted by `gitnexus serve` (Express server in `gitnexus/src/server/api.ts`).

## Base URL

- Default bind: `http://127.0.0.1:4747`
- All endpoints are under `/api/*`.
- CORS is restricted to `http://localhost:*`, `http://127.0.0.1:*`, and `https://gitnexus.vercel.app`.

## Selecting which repository to use

Most “read” endpoints accept a repository selector in one of these ways:

- Query param: `?repo=<repoName>`
- Or JSON body: `{ "repo": "<repoName>" }` (when the endpoint is `POST`)

If `repo` is not provided and at least one repo is indexed, the server defaults to the first registered repo.

The server uses the global registry: `~/.gitnexus/registry.json`.

---

## Endpoints

### `GET /api/repos`

List all indexed repositories from the global registry.

**Response**: `[{ name, path, indexedAt, lastCommit, stats }]`

**Example**
```bash
curl -s http://127.0.0.1:4747/api/repos
```

---

### `GET /api/repo`

Get repository info and current stats.

**Query**
- `repo` (optional): repo name from the registry

**Response**:
```json
{
  "name": "repoName",
  "repoPath": "absolute/path/to/repo",
  "indexedAt": "ISO timestamp",
  "stats": { "...": "repo stats" }
}
```

---

### `POST /api/graph/create`

Create (or rebuild) the knowledge graph for a repository by running the ingestion pipeline.

This endpoint is synchronous: it returns only after indexing finishes.

**Content-Type**: `application/json`

**Request body (JSON)**
- One of the following selectors:
  - `url`: a git URL (e.g. `https://github.com/org/repo.git` or `git@...`)
  - `repo`: a registered repo name
  - `path`: an absolute path to a repository on the server machine
- Options:
  - `force` (boolean, optional): force re-index even if unchanged
  - `embeddings` (boolean, optional): generate embeddings (may take longer)
  - `gitHistory` (boolean, optional): include git history ingestion (up to 200 commits)

**Response**
```json
{
  "success": true,
  "stats": { "files": 123, "nodes": 456, "edges": 789, "communities": 12, "processes": 34, "embeddings": 567 },
  "durationSeconds": 42
}
```

**Example**
```bash
curl -X POST http://127.0.0.1:4747/api/graph/create ^
  -H "Content-Type: application/json" ^
  -d "{\"url\":\"https://github.com/org/repo.git\",\"force\":false,\"embeddings\":false,\"gitHistory\":true}"
```

Notes:
- When using `url`, the server clones the repo into its global clone cache and registers it under the cloned folder name.
- When `gitHistory=true`, the server will clone/fetch with deeper history so the pipeline can index commits.

---

### `POST /api/graph/create-from-zip`

Create (or rebuild) the knowledge graph from an uploaded ZIP file.

This endpoint is synchronous: it returns only after indexing finishes.

**Content-Type**: `multipart/form-data`

**Form fields**
- `repoName` (string, required): client-provided name (used as the registered repo name)
- `zip` (file, required): ZIP archive upload
- Options (optional; string/boolean-like values are accepted):
  - `force` (boolean): force re-index
  - `embeddings` (boolean): generate embeddings
  - `gitHistory` (boolean): enable git-history ingestion when the ZIP appears to include `.git/`

**ZIP handling**
- Server unzip destination: `~/.gitnexus/imports/<repoName>/`
- ZIP size is limited in memory to ~`200MB` (`MAX_ZIP_BYTES`).
- The unzip logic includes basic path traversal protections and ignores ignored paths/extensions using the same ignore rules as ingestion.

**Response**
```json
{
  "success": true,
  "repoName": "repoName",
  "gitHistoryUsed": false,
  "stats": { "...": "repo stats" },
  "durationSeconds": 42
}
```

**Example (multipart)**
```bash
curl -X POST http://127.0.0.1:4747/api/graph/create-from-zip ^
  -F "repoName=my-repo" ^
  -F "zip=@./repo.zip" ^
  -F "force=false" ^
  -F "embeddings=false" ^
  -F "gitHistory=false"
```

---

### `GET /api/graph`

Download the full graph for a repository.

**Query**
- `repo` (optional): repo name from registry

**Response**
```json
{
  "nodes": [ /* GraphNode */ ],
  "relationships": [ /* GraphRelationship */ ]
}
```

---

### `POST /api/query`

Execute a raw Cypher query against the repository graph.

**Content-Type**: `application/json`

**Request body**
- `cypher` (string, required)
- `repo` (string, optional)

**Response**
```json
{ "result": [ /* rows */ ] }
```

---

### `POST /api/search`

Hybrid search over the repository graph.

If embeddings are ready, it runs semantic + BM25 hybrid search; otherwise it falls back to FTS-only BM25.

**Content-Type**: `application/json`

**Request body**
- `query` (string, required)
- `limit` (number, optional, server clamps to 1..100; default 10)
- `repo` (string, optional)

**Response**
```json
{ "results": [ /* search results */ ] }
```

---

### `GET /api/file`

Fetch the source content for a file stored in the graph.

**Query**
- `repo` (optional)
- `path` (string, required): path relative to repo root (as stored by the indexer)

Security:
- The server prevents path traversal by resolving and verifying the resolved path stays within the repo root.

**Response**
```json
{ "content": "..." }
```

---

### `GET /api/processes`

List all execution-flow processes (entry-point traces) for a repo.

**Query**
- `repo` (optional)

**Response**: server-specific process list shape (queried from the MCP backend).

---

### `GET /api/process`

Fetch a single process detail by name.

**Query**
- `repo` (optional)
- `name` (string, required)

**Response**: server-specific process detail shape (queried from the MCP backend).

---

### `GET /api/clusters`

List all functional clusters.

**Query**
- `repo` (optional)

**Response**: server-specific cluster list shape (queried from the MCP backend).

---

### `GET /api/cluster`

Cluster detail by name.

**Query**
- `repo` (optional)
- `name` (string, required)

**Response**: server-specific cluster detail shape (queried from the MCP backend).

---

## Error handling (common pattern)

- `400`:
  - invalid request payload (missing fields / bad parameters)
  - analysis failure in create endpoints
- `404`:
  - repo not found
  - process/cluster not found
- `500`:
  - unhandled server error

