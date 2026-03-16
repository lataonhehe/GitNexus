import { execSync } from 'child_process';
import { KnowledgeGraph } from '../graph/types.js';
import { isGitRepo } from '../../storage/git.js';

/** Maximum number of recent commits to index */
const MAX_COMMITS = 200;

interface CommitRecord {
  sha: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
  message: string;
  files: string[];
}

/**
 * Intermediate state returned by processGitNodes so the pipeline can call
 * linkGitModifiedEdges after File nodes have been created by processStructure.
 */
export interface GitHistoryState {
  commits: CommitRecord[];
}

/**
 * Parses `git log` output into CommitRecord[].
 * Format used: lines starting with "COMMIT|sha|name|email|ts|subject",
 * followed by changed file paths until the next COMMIT line or EOF.
 */
function parseGitLog(raw: string): CommitRecord[] {
  const records: CommitRecord[] = [];
  let current: CommitRecord | null = null;

  for (const line of raw.split('\n')) {
    if (line.startsWith('COMMIT|')) {
      if (current) records.push(current);
      const parts = line.split('|');
      current = {
        sha: parts[1] ?? '',
        authorName: parts[2] ?? '',
        authorEmail: parts[3] ?? '',
        timestamp: parseInt(parts[4] ?? '0', 10),
        message: parts.slice(5).join('|').trim(),
        files: [],
      };
    } else if (current && line.trim()) {
      current.files.push(line.trim());
    }
  }
  if (current) records.push(current);
  return records;
}

/**
 * Phase 0 — creates Commit, Author, Branch nodes and AUTHORED/ON_BRANCH edges.
 *
 * MODIFIED edges are NOT created here because File nodes do not exist yet.
 * Call linkGitModifiedEdges() after processStructure() to add those edges.
 *
 * Returns GitHistoryState (commit list + normalised repo path) needed by the
 * second pass, or null if the repo is not a git repo / git fails.
 */
export const processGitNodes = (
  graph: KnowledgeGraph,
  repoPath: string,
): GitHistoryState | null => {
  if (!isGitRepo(repoPath)) return null;

  try {
    const logOutput = execSync(
      `git log -${MAX_COMMITS} --format="COMMIT|%H|%an|%ae|%at|%s" --name-only`,
      { cwd: repoPath, maxBuffer: 50 * 1024 * 1024 },
    ).toString();

    const commits = parseGitLog(logOutput);
    if (commits.length === 0) return null;

    // Resolve current branch name
    let currentBranch = 'HEAD';
    try {
      currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath })
        .toString()
        .trim();
    } catch {}

    // Branch node
    const branchId = `Branch:${currentBranch}`;
    graph.addNode({
      id: branchId,
      label: 'Branch',
      properties: { name: currentBranch, filePath: '', isCurrent: true },
    });

    // Pre-compute commit counts per author
    const authorCommitCounts = new Map<string, number>();
    for (const c of commits) {
      authorCommitCounts.set(c.authorEmail, (authorCommitCounts.get(c.authorEmail) ?? 0) + 1);
    }

    for (const commit of commits) {
      const { sha, authorName, authorEmail, timestamp, message, files } = commit;
      const commitId = `Commit:${sha}`;
      const authorId = `Author:${authorEmail}`;

      // Author node (idempotent — only add once per unique email)
      if (!graph.getNode(authorId)) {
        graph.addNode({
          id: authorId,
          label: 'Author',
          properties: {
            name: authorName,
            filePath: '',
            email: authorEmail,
            commitCount: authorCommitCounts.get(authorEmail) ?? 1,
          },
        });
      }

      // Commit node — store authorName in description, authorEmail in returnType
      // (reusing existing NodeProperties fields to avoid schema changes)
      graph.addNode({
        id: commitId,
        label: 'Commit',
        properties: {
          name: sha.substring(0, 8),
          filePath: '',
          sha,
          message: message.substring(0, 200),
          timestamp,
          filesChanged: files.length,
          description: authorName,
          returnType: authorEmail,
        },
      });

      // Author -[AUTHORED]-> Commit
      graph.addRelationship({
        id: `${authorId}_authored_${sha.substring(0, 8)}`,
        type: 'AUTHORED',
        sourceId: authorId,
        targetId: commitId,
        confidence: 1.0,
        reason: 'git-log',
      });

      // Branch -[ON_BRANCH]-> Commit
      graph.addRelationship({
        id: `${branchId}_on_branch_${sha.substring(0, 8)}`,
        type: 'ON_BRANCH',
        sourceId: branchId,
        targetId: commitId,
        confidence: 1.0,
        reason: 'git-log',
      });
    }

    // OlderCommit -[PRECEDES]-> NewerCommit
    // git log returns commits newest-first, so commits[i+1] is the parent of commits[i]
    for (let i = commits.length - 1; i > 0; i--) {
      const olderSha = commits[i].sha;
      const newerSha = commits[i - 1].sha;
      graph.addRelationship({
        id: `${olderSha.substring(0, 8)}_precedes_${newerSha.substring(0, 8)}`,
        type: 'PRECEDES',
        sourceId: `Commit:${olderSha}`,
        targetId: `Commit:${newerSha}`,
        confidence: 1.0,
        reason: 'git-log',
      });
    }

    return { commits };
  } catch {
    // Git history is optional — never fail the pipeline
    return null;
  }
};

/**
 * Phase 2.5 — adds Commit -[MODIFIED]-> File edges.
 *
 * Must be called AFTER processStructure() so File nodes already exist in the
 * graph. Silently skips any file paths that are not present in the graph
 * (deleted files, files outside the scanned scope, etc.).
 */
export const linkGitModifiedEdges = (
  graph: KnowledgeGraph,
  state: GitHistoryState,
): void => {
  const { commits } = state;

  for (const { sha, files } of commits) {
    const commitId = `Commit:${sha}`;
    for (const relPath of files) {
      // File node IDs use the same relative-path format as filesystem-walker
      // (forward slashes, relative to repo root) — no absolute prefix needed.
      const fileNodeId = `File:${relPath.replace(/\\/g, '/')}`;
      if (graph.getNode(fileNodeId)) {
        graph.addRelationship({
          id: `${sha.substring(0, 8)}_modified_${relPath}`,
          type: 'MODIFIED',
          sourceId: commitId,
          targetId: fileNodeId,
          confidence: 1.0,
          reason: 'git-log',
        });
      }
    }
  }
};

/**
 * Convenience wrapper — runs both phases in sequence.
 * Use this only when File nodes are guaranteed to exist before calling
 * (e.g. in tests or scripts, not in the main pipeline).
 */
export const processGitHistory = (graph: KnowledgeGraph, repoPath: string): void => {
  const state = processGitNodes(graph, repoPath);
  if (state) linkGitModifiedEdges(graph, state);
};
