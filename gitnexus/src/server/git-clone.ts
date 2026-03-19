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

/**
 * Clone a git repo to ~/.gitnexus/clones/<repo-name>
 * Returns the local path. Throws on failure.
 */
export async function cloneRepo(url: string): Promise<CloneResult> {
  const { getGlobalDir } = await import('../storage/repo-manager.js');
  const clonesDir = path.join(getGlobalDir(), 'clones');
  await fs.mkdir(clonesDir, { recursive: true });

  const folderName = getCloneFolderName(url);
  const targetPath = path.join(clonesDir, folderName);

  try {
    await fs.access(targetPath);
    execFileSync('git', ['pull', '--ff-only'], { cwd: targetPath, encoding: 'utf-8' });
    return { repoPath: targetPath, folderName };
  } catch {
    execFileSync('git', ['clone', '--depth', '1', url.trim(), targetPath], {
      encoding: 'utf-8',
      timeout: 120_000,
    });
    return { repoPath: targetPath, folderName };
  }
}
