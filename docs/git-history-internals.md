# Git History Internals — Hướng dẫn cho Intern

Tài liệu này giải thích **từng bước** cách GitNexus lấy dữ liệu từ git và biến nó thành các nodes và edges trong Knowledge Graph.

---

## 1. Toàn cảnh: dữ liệu đi từ đâu về đâu

```
git (command line)
       │
       │  git log (raw text)
       ▼
parseGitLog()          ← parse text thành struct
       │
       │  CommitRecord[]
       ▼
processGitNodes()      ← tạo Commit / Author / Branch nodes
                          + AUTHORED, ON_BRANCH, PRECEDES edges
       │
       │  GitHistoryState (giữ lại commits để dùng bước sau)
       ▼
processStructure()     ← (pipeline phase 2) tạo File nodes
       │
       ▼
linkGitModifiedEdges() ← tạo MODIFIED edges (cần File nodes đã tồn tại)
       │
       ▼
  KnowledgeGraph       ← sẵn sàng để lưu vào LadybugDB
```

**File liên quan:**
- `gitnexus/src/core/ingestion/git-history-processor.ts` — toàn bộ logic git
- `gitnexus/src/core/ingestion/pipeline.ts` — điều phối thứ tự gọi

---

## 2. Bước 1 — Chạy `git log` để lấy raw data

```typescript
// Trong processGitNodes()
const logOutput = execSync(
  `git log -200 --format="COMMIT|%H|%an|%ae|%at|%s" --name-only`,
  { cwd: repoPath, maxBuffer: 50 * 1024 * 1024 },
).toString();
```

### Giải thích lệnh git

| Phần | Ý nghĩa |
|------|---------|
| `git log` | Liệt kê commit history |
| `-200` | Chỉ lấy 200 commit gần nhất |
| `--format="COMMIT\|%H\|%an\|%ae\|%at\|%s"` | Format dòng header mỗi commit |
| `--name-only` | Liệt kê các file bị thay đổi trong commit đó |

**Các placeholder trong format:**

| Placeholder | Trả về | Ví dụ |
|-------------|--------|-------|
| `%H` | Full SHA | `6c18ae08f7480be5...` |
| `%an` | Author name | `Nguyen Van A` |
| `%ae` | Author email | `nguyenvana@gmail.com` |
| `%at` | Timestamp (Unix epoch) | `1773600580` |
| `%s` | Subject (dòng đầu message) | `feat: add login flow` |

### Output thực tế trông như thế này

```
COMMIT|6c18ae08f748...|Nguyen Van A|nva@gmail.com|1773600580|feat: add login

src/auth/login.ts
src/auth/validate.ts
gitnexus/package.json

COMMIT|5a58508abc12...|Tran Thi B|ttb@gmail.com|1773500000|fix: null pointer

src/utils/parser.ts
```

> **Lưu ý quan trọng:** `git log` trả về commits từ **mới nhất đến cũ nhất**.
> Tức là `commits[0]` = commit mới nhất, `commits[199]` = commit cũ nhất.

---

## 3. Bước 2 — Parse raw text thành struct

```typescript
function parseGitLog(raw: string): CommitRecord[] {
  const records: CommitRecord[] = [];
  let current: CommitRecord | null = null;

  for (const line of raw.split('\n')) {
    if (line.startsWith('COMMIT|')) {
      if (current) records.push(current);   // lưu commit trước
      const parts = line.split('|');
      current = {
        sha:         parts[1] ?? '',
        authorName:  parts[2] ?? '',
        authorEmail: parts[3] ?? '',
        timestamp:   parseInt(parts[4] ?? '0', 10),
        message:     parts.slice(5).join('|').trim(), // join lại vì message có thể chứa '|'
        files:       [],
      };
    } else if (current && line.trim()) {
      current.files.push(line.trim());  // dòng không phải COMMIT → là file path
    }
  }
  if (current) records.push(current);  // lưu commit cuối cùng
  return records;
}
```

**Kết quả:** một mảng `CommitRecord[]` với mỗi commit chứa đầy đủ thông tin + danh sách files.

```typescript
// CommitRecord trông như thế này:
{
  sha: "6c18ae08f7480be5120602908aa19b4ce38e18dc",
  authorName: "Nguyen Van A",
  authorEmail: "nva@gmail.com",
  timestamp: 1773600580,
  message: "feat: add login",
  files: ["src/auth/login.ts", "src/auth/validate.ts", "gitnexus/package.json"]
}
```

---

## 4. Bước 3 — Tạo Branch node

```typescript
// Lấy tên nhánh hiện tại
let currentBranch = 'HEAD';  // fallback nếu lệnh dưới thất bại
currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath })
  .toString().trim();
// → "main" hoặc "feature/login" v.v.

// Tạo node
graph.addNode({
  id: `Branch:main`,
  label: 'Branch',
  properties: { name: 'main', filePath: '', isCurrent: true },
});
```

> Chỉ index **1 branch** = branch hiện tại. Multi-branch có thể mở rộng sau.

---

## 5. Bước 4 — Tạo Author nodes (deduplicated)

```typescript
// Tính trước số commit của từng author (để không phải đếm lại trong loop)
const authorCommitCounts = new Map<string, number>();
for (const c of commits) {
  authorCommitCounts.set(
    c.authorEmail,
    (authorCommitCounts.get(c.authorEmail) ?? 0) + 1
  );
}

for (const commit of commits) {
  const authorId = `Author:${commit.authorEmail}`;

  // Chỉ tạo node nếu chưa tồn tại (dùng email làm unique key)
  if (!graph.getNode(authorId)) {
    graph.addNode({
      id: authorId,
      label: 'Author',
      properties: {
        name: commit.authorName,
        email: commit.authorEmail,
        commitCount: authorCommitCounts.get(commit.authorEmail) ?? 1,
      },
    });
  }
}
```

**Tại sao dùng email làm key?**
Cùng một người có thể commit bằng nhiều tên khác nhau (`Nguyen Van A`, `nva`, `NVA`) nhưng email thường nhất quán hơn.

---

## 6. Bước 5 — Tạo Commit nodes

```typescript
graph.addNode({
  id: `Commit:${sha}`,          // full SHA làm key
  label: 'Commit',
  properties: {
    name: sha.substring(0, 8),  // short SHA để hiển thị
    sha,                         // full SHA để tra cứu
    message: message.substring(0, 200),
    timestamp,
    filesChanged: files.length,
    // Dùng lại các field sẵn có để lưu author info:
    description: authorName,    // ← lưu authorName vào đây
    returnType: authorEmail,    // ← lưu authorEmail vào đây
  },
});
```

> **Tại sao dùng `description` và `returnType` để lưu author info?**
> `NodeProperties` là schema dùng chung cho mọi loại node. Thay vì thêm field
> riêng `authorName`/`authorEmail` vào schema (cần sửa nhiều file), ta tận dụng
> 2 field đã có sẵn. Không lý tưởng nhưng đơn giản hơn khi mới implement.

---

## 7. Bước 6 — Tạo AUTHORED và ON_BRANCH edges

```typescript
// Author -[AUTHORED]-> Commit
graph.addRelationship({
  id: `Author:nva@gmail.com_authored_6c18ae08`,
  type: 'AUTHORED',
  sourceId: `Author:nva@gmail.com`,
  targetId: `Commit:6c18ae08...`,
  confidence: 1.0,
  reason: 'git-log',
});

// Branch -[ON_BRANCH]-> Commit
graph.addRelationship({
  id: `Branch:main_on_branch_6c18ae08`,
  type: 'ON_BRANCH',
  sourceId: `Branch:main`,
  targetId: `Commit:6c18ae08...`,
  confidence: 1.0,
  reason: 'git-log',
});
```

---

## 8. Bước 7 — Tạo PRECEDES edges (timeline chain)

```typescript
// git log trả về newest-first: commits[0] = mới nhất, commits[N-1] = cũ nhất
// commits[i+1] là commit trước (cũ hơn) của commits[i]
// → commits[i+1] PRECEDES commits[i]

for (let i = commits.length - 1; i > 0; i--) {
  const olderSha = commits[i].sha;    // commit cũ hơn
  const newerSha = commits[i - 1].sha; // commit mới hơn

  graph.addRelationship({
    type: 'PRECEDES',
    sourceId: `Commit:${olderSha}`,  // cũ → mới
    targetId: `Commit:${newerSha}`,
    ...
  });
}
```

**Kết quả:** một chuỗi timeline liên tục:

```
Commit(cũ nhất) -[PRECEDES]-> ... -[PRECEDES]-> Commit(mới nhất)
```

---

## 9. Bước 8 — Tạo MODIFIED edges (phase riêng)

Đây là phần **quan trọng nhất** về mặt kỹ thuật. Không thể tạo MODIFIED edges ngay trong bước 6 vì File nodes **chưa tồn tại** lúc đó.

### Tại sao MODIFIED edges phải tạo sau?

```
Pipeline timeline:
  Phase 0 (git nodes)   ← processGitNodes() chạy ở đây
  Phase 1 (scan files)
  Phase 2 (structure)   ← processStructure() tạo File nodes ở đây
  Phase 2.5 (MODIFIED)  ← linkGitModifiedEdges() chạy ở đây ✓
  Phase 3 (parsing)
  ...
```

Nếu thử `graph.getNode('File:src/auth/login.ts')` ở Phase 0 → trả về `undefined`
vì File nodes chưa được tạo. Kết quả là MODIFIED edge bị bỏ qua.

### Code trong pipeline.ts

```typescript
// Phase 0: tạo nodes, giữ lại commits trong gitState
let gitState: GitHistoryState | null = null;
if (options?.gitHistory) {
  gitState = processGitNodes(graph, repoPath);
}

// Phase 2: processStructure tạo File/Folder nodes
processStructure(graph, allPaths);

// Phase 2.5: giờ File nodes đã tồn tại → tạo MODIFIED edges
if (gitState) {
  linkGitModifiedEdges(graph, gitState);
}
```

### Code trong linkGitModifiedEdges()

```typescript
for (const { sha, files } of commits) {
  const commitId = `Commit:${sha}`;
  for (const relPath of files) {
    // File IDs dùng relative path, forward slash, không có absolute prefix
    // VD: "File:gitnexus/src/core/ingestion/call-processor.ts"
    const fileNodeId = `File:${relPath.replace(/\\/g, '/')}`;

    if (graph.getNode(fileNodeId)) {  // chỉ tạo nếu file vẫn còn tồn tại
      graph.addRelationship({
        type: 'MODIFIED',
        sourceId: commitId,
        targetId: fileNodeId,
        ...
      });
    }
    // Nếu file đã bị xóa → getNode trả undefined → bỏ qua, không lỗi
  }
}
```

### Tại sao file path phải là relative?

`filesystem-walker` (component scan file) lưu File node IDs theo **relative path** so với git root:
```
File:gitnexus/src/core/ingestion/call-processor.ts  ✓ (relative)
File:C:/Users/dev/project/gitnexus/src/...          ✗ (absolute - không match)
```

`git log --name-only` cũng trả về relative path so với git root → hai bên khớp nhau.

---

## 10. Sơ đồ kết quả cuối cùng

```
Branch:main
    │ ON_BRANCH (×200)
    ▼
Commit:6c18ae ──PRECEDES──► Commit:5a5850 ──PRECEDES──► Commit:...
    │    │                       │    │
AUTHORED │MODIFIED           AUTHORED │MODIFIED
    │    │                       │    │
    ▼    ▼                       ▼    ▼
Author  File:src/auth/login.ts  Author  File:src/utils/parser.ts
:nva@                           :ttb@
```

---

## 11. Tóm tắt: các lỗi phổ biến khi mở rộng

| Lỗi | Nguyên nhân | Fix |
|-----|-------------|-----|
| MODIFIED edges = 0 | Tạo trước Phase 2 (File nodes chưa có) | Dùng 2-phase như hiện tại |
| File path không match | Dùng absolute path thay vì relative | Dùng `relPath` trực tiếp từ git log |
| MODIFIED edges = 0 trên Windows | Backslash trong path | `.replace(/\\/g, '/')` |
| Author bị duplicate | Dùng name thay vì email làm key | Dùng `authorEmail` làm ID |

---

## 12. Chạy thử để quan sát

```bash
# Index với git history
npx gitnexus analyze --git-history --force

# Kiểm tra số edges theo loại (dùng MCP tool)
gitnexus_cypher({
  query: "MATCH ()-[r:CodeRelation]->() RETURN r.type, COUNT(*) AS cnt ORDER BY cnt DESC"
})

# Xem commit gần nhất đã modify những file nào
gitnexus_cypher({
  query: "MATCH (c:Commit)-[:CodeRelation {type:'MODIFIED'}]->(f:File) RETURN c.name, c.message, f.name LIMIT 20"
})
```
