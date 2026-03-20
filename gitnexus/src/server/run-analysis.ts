/**
 * Run analysis pipeline for API (no CLI UI, no process.exit).
 * Used by POST /api/graph/create.
 */

import path from 'path';
import fs from 'fs/promises';
import { runPipelineFromRepo, PipelineOptions } from '../core/ingestion/pipeline.js';
import {
  initLbug,
  loadGraphToLbug,
  getLbugStats,
  executeQuery,
  executeWithReusedStatement,
  closeLbug,
  createFTSIndex,
  loadCachedEmbeddings,
} from '../core/lbug/lbug-adapter.js';
import {
  getStoragePaths,
  saveMeta,
  loadMeta,
  addToGitignore,
  registerRepo,
  cleanupOldKuzuFiles,
} from '../storage/repo-manager.js';
import { getCurrentCommit, isGitRepo } from '../storage/git.js';

export interface RunAnalysisOptions {
  force?: boolean;
  embeddings?: boolean;
  gitHistory?: boolean;
}

const EMBEDDING_NODE_LIMIT = 50_000;

export interface RunAnalysisResult {
  success: boolean;
  error?: string;
  stats?: {
    files: number;
    nodes: number;
    edges: number;
    communities?: number;
    processes?: number;
    embeddings?: number;
  };
  durationSeconds?: number;
}

export async function runAnalysisForApi(
  repoPath: string,
  options: RunAnalysisOptions = {}
): Promise<RunAnalysisResult> {
  const t0 = Date.now();
  const resolvedPath = path.resolve(repoPath);
  const repoIsGit = isGitRepo(resolvedPath);

  // Git history needs a valid git working tree.
  if (options?.gitHistory && !repoIsGit) {
    return { success: false, error: 'Not a git repository (gitHistory requested)' };
  }
  const { storagePath, lbugPath } = getStoragePaths(resolvedPath);

  try {
    await cleanupOldKuzuFiles(storagePath);
    const existingMeta = await loadMeta(storagePath);

    // For non-git repos (or when gitHistory=false), disable lastCommit caching.
    const currentCommit = repoIsGit ? getCurrentCommit(resolvedPath) : '';
    const canCache =
      repoIsGit
      && existingMeta
      && !options.force
      && existingMeta.lastCommit === currentCommit;

    if (canCache) {
      return {
        success: true,
        stats: existingMeta.stats as RunAnalysisResult['stats'],
        durationSeconds: 0,
      };
    }

    const pipelineOpts: PipelineOptions = { gitHistory: Boolean(options?.gitHistory && repoIsGit) };
    const pipelineResult = await runPipelineFromRepo(resolvedPath, () => {}, pipelineOpts);

    await closeLbug();
    for (const f of [lbugPath, `${lbugPath}.wal`, `${lbugPath}.lock`]) {
      try {
        await fs.rm(f, { recursive: true, force: true });
      } catch {}
    }

    await initLbug(lbugPath);
    await loadGraphToLbug(pipelineResult.graph, pipelineResult.repoPath, storagePath);

    try {
      await createFTSIndex('File', 'file_fts', ['name', 'content']);
      await createFTSIndex('Function', 'function_fts', ['name', 'content']);
      await createFTSIndex('Class', 'class_fts', ['name', 'content']);
      await createFTSIndex('Method', 'method_fts', ['name', 'content']);
      await createFTSIndex('Interface', 'interface_fts', ['name', 'content']);
    } catch {
      /* FTS is best-effort */
    }

    let embeddingCount = 0;
    if (options?.embeddings) {
      const stats = await getLbugStats();
      if (stats.nodes <= EMBEDDING_NODE_LIMIT) {
        const { runEmbeddingPipeline } = await import('../core/embeddings/embedding-pipeline.js');
        await runEmbeddingPipeline(executeQuery, executeWithReusedStatement, () => {}, {});
        const embResult = await executeQuery(`MATCH (e:CodeEmbedding) RETURN count(e) AS cnt`);
        embeddingCount = embResult?.[0]?.cnt ?? 0;
      }
    } else {
      try {
        const embResult = await executeQuery(`MATCH (e:CodeEmbedding) RETURN count(e) AS cnt`);
        embeddingCount = embResult?.[0]?.cnt ?? 0;
      } catch {}
    }

    const stats = await getLbugStats();
    const meta = {
      repoPath: resolvedPath,
      lastCommit: currentCommit,
      indexedAt: new Date().toISOString(),
      stats: {
        files: pipelineResult.totalFileCount,
        nodes: stats.nodes,
        edges: stats.edges,
        communities: pipelineResult.communityResult?.stats.totalCommunities,
        processes: pipelineResult.processResult?.stats.totalProcesses,
        embeddings: embeddingCount,
      },
    };
    await saveMeta(storagePath, meta);
    await registerRepo(resolvedPath, meta);
    await addToGitignore(resolvedPath);

    await closeLbug();

    const durationSeconds = Math.round((Date.now() - t0) / 1000);
    return {
      success: true,
      stats: meta.stats,
      durationSeconds,
    };
  } catch (err: any) {
    try {
      await closeLbug();
    } catch {}
    return {
      success: false,
      error: err?.message || 'Analysis failed',
    };
  }
}
