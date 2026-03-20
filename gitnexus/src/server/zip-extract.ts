import fs from 'fs/promises';
import path from 'path';
import JSZip from 'jszip';
import { shouldIgnorePath } from '../config/ignore-service.js';

function findRootPrefix(paths: string[]): string {
  if (paths.length === 0) return '';

  const firstSegments = paths
    .filter(p => p.includes('/'))
    .map(p => p.split('/')[0]);

  if (firstSegments.length === 0) return '';

  const firstSegment = firstSegments[0];
  const allSameRoot = firstSegments.every(s => s === firstSegment);
  return allSameRoot ? `${firstSegment}/` : '';
}

function isProbablyGitZip(allPaths: string[]): boolean {
  return allPaths.some((p) => {
    const normalized = p.replace(/\\/g, '/');
    // GitHub source zips don't include `.git`, but archives created elsewhere might.
    // Handle both:
    //  - `.git/config`
    //  - `<root>/.../.git/config`
    return (
      normalized === '.git'
      || normalized.startsWith('.git/')
      || normalized.includes('/.git/')
      || normalized.endsWith('/.git')
    );
  });
}

// Exported for testing: ZIP entry names must never escape the destination folder.
export function assertSafeRelativePath(rel: string, destDir: string): string {
  // Normalize path separators and remove any weirdness.
  const normalized = rel.replace(/\\/g, '/');
  const posixNormalized = path.posix.normalize(normalized);

  // Reject absolute paths and path traversal.
  if (path.posix.isAbsolute(posixNormalized) || posixNormalized.startsWith('..')) {
    throw new Error(`Unsafe zip path: ${rel}`);
  }

  const finalPath = path.join(destDir, posixNormalized);
  const destRoot = path.resolve(destDir);
  const resolved = path.resolve(finalPath);

  if (resolved !== destRoot && !resolved.startsWith(destRoot + path.sep)) {
    throw new Error(`Unsafe zip path escapes destination: ${rel}`);
  }

  return posixNormalized;
}

export async function extractZipToDir(
  zipBuffer: Buffer,
  destDir: string,
): Promise<{ extractedFiles: number; zipHasGit: boolean }> {
  const zip = await JSZip.loadAsync(zipBuffer);

  const allPaths: string[] = [];
  zip.forEach((relativePath, entry) => {
    if (!entry.dir) allPaths.push(relativePath);
  });

  const zipHasGit = isProbablyGitZip(allPaths);
  const rootPrefix = findRootPrefix(allPaths);

  let extractedFiles = 0;

  // Extract sequentially to avoid large bursts of async writes.
  for (const [relativePath, entry] of Object.entries(zip.files)) {
    // zip.files keys are typically relative paths. `relativePath` might include dirs too.
    // We'll still rely on `entry.dir` to skip folders.
    if (entry.dir) continue;

    const normalizedPath = rootPrefix && relativePath.startsWith(rootPrefix)
      ? relativePath.slice(rootPrefix.length)
      : relativePath;

    if (!normalizedPath) continue;

    // Normalize to forward slashes for ignore checks.
    const normalizedForIgnore = normalizedPath.replace(/\\/g, '/');
    if (shouldIgnorePath(normalizedForIgnore)) continue;

    const safeRel = assertSafeRelativePath(normalizedForIgnore, destDir);

    const destPath = path.join(destDir, safeRel);
    try {
      await fs.mkdir(path.dirname(destPath), { recursive: true });
    } catch {
      continue;
    }

    try {
      // Expect mostly text source files; skip binary/unreadable content.
      const content = await entry.async('string');
      await fs.writeFile(destPath, content, 'utf-8');
      extractedFiles++;
    } catch {
      // Likely binary or encoding mismatch — best-effort skip.
      continue;
    }
  }

  return { extractedFiles, zipHasGit };
}

