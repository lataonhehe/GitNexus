/**
 * Clone a git repository from URL.
 * Used by POST /api/graph/create when url param is provided.
 */

import path from 'path';
import fs from 'fs/promises';
import { execFileSync } from 'child_process';

export function isGitUrl(input: string): boolean {
  if (!input || typeof input !== 'string') return false;
  const trimmed = input.trim();
  if (trimmed.startsWith('git@') && trimmed.includes(':')) return true;
  if ((trimmed.startsWith('http://') || trimmed.startsWith('https://')) && trimmed.includes('/')) return true;
  return false;
}

/** Derive a safe folder name from git URL */
function getCloneFolderName(url: string): string {
  const normalized = url.replace(/\.git$/, '').replace(/\/$/, '').trim();
  let name = '';
  if (normalized.startsWith('git@')) {
    const part = normalized.split(':')[1] || '';
    name = part.split('/').pop() || part;
  } else {
    const match = normalized.match(/\/([^/]+)$/);
    name = match ? match[1] : '';
  }
  return name ? name.replace(/[^a-zA-Z0-9._-]/g, '_') : `repo_${Date.now()}`;
}

export interface CloneResult {
  repoPath: string;
  folderName: string;
}

export interface CloneOptions {
  /**
   * When true, clone depth should be large enough to support
   * `--git-history` ingestion (LadybugDB pipeline caps at 200 commits).
   */
  gitHistory?: boolean;
  /**
   * Override clone depth. If omitted, derived from `gitHistory`.
   */
  cloneDepth?: number;
}

const DEFAULT_CLONE_DEPTH = 1;
const GIT_HISTORY_CLONE_DEPTH = 200;

function deriveCloneDepth(options: CloneOptions | undefined): number {
  if (options?.cloneDepth && Number.isFinite(options.cloneDepth) && options.cloneDepth > 0) {
    return Math.trunc(options.cloneDepth);
  }
  return options?.gitHistory ? GIT_HISTORY_CLONE_DEPTH : DEFAULT_CLONE_DEPTH;
}

/**
 * Clone a git repo to ~/.gitnexus/clones/<repo-name>
 * Returns the local path. Throws on failure.
 */
export async function cloneRepo(url: string, options: CloneOptions = {}): Promise<CloneResult> {
  const { getGlobalDir } = await import('../storage/repo-manager.js');
  const clonesDir = path.join(getGlobalDir(), 'clones');
  await fs.mkdir(clonesDir, { recursive: true });

  const folderName = getCloneFolderName(url);
  const targetPath = path.join(clonesDir, folderName);
  const cloneDepth = deriveCloneDepth(options);

  const isShallowRepo = (): boolean => {
    try {
      const out = execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
        cwd: targetPath,
        encoding: 'utf-8',
      }).toString().trim();
      return out === 'true';
    } catch {
      return false;
    }
  };

  try {
    await fs.access(targetPath);
    // If we need git history, ensure shallow clone has enough depth.
    if (cloneDepth > DEFAULT_CLONE_DEPTH && isShallowRepo()) {
      execFileSync('git', ['fetch', '--depth', String(cloneDepth), 'origin', 'HEAD'], {
        cwd: targetPath,
        encoding: 'utf-8',
      });
    }
    execFileSync('git', ['pull', '--ff-only'], { cwd: targetPath, encoding: 'utf-8' });
    return { repoPath: targetPath, folderName };
  } catch {
    execFileSync('git', ['clone', '--depth', String(cloneDepth), url.trim(), targetPath], {
      encoding: 'utf-8',
      timeout: 120_000,
    });
    return { repoPath: targetPath, folderName };
  }
}
