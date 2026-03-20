import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { assertSafeRelativePath, extractZipToDir } from '../../src/server/zip-extract.js';

async function mkTmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('zip extraction security', () => {
  it('strips common root prefix and detects/skips `.git`', async () => {
    const zip = new JSZip();
    zip.file('repo-main/src/main.ts', 'export const x = 1;');
    zip.file('repo-main/.git/config', '[core]\nrepositoryformatversion = 0');

    // Some archives can include empty root folders; no harm.
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    const destDir = await mkTmpDir('gitnexus-zip-');
    try {
      const { extractedFiles, zipHasGit } = await extractZipToDir(zipBuffer, destDir);
      expect(zipHasGit).toBe(true);
      expect(extractedFiles).toBeGreaterThan(0);

      const extracted = await fs.readFile(path.join(destDir, 'src', 'main.ts'), 'utf-8');
      expect(extracted).toBe('export const x = 1;');

      // `.git` should be ignored by shouldIgnorePath.
      await expect(fs.stat(path.join(destDir, '.git'))).rejects.toBeTruthy();
    } finally {
      await fs.rm(destDir, { recursive: true, force: true });
    }
  });

  it('rejects unsafe relative paths (e.g. ../)', async () => {
    const destDir = await mkTmpDir('gitnexus-zip-');
    try {
      expect(() => assertSafeRelativePath('../evil.txt', destDir)).toThrow(/Unsafe zip path/);
      expect(() => assertSafeRelativePath('sub/../../evil.txt', destDir)).toThrow(/Unsafe zip path/);
    } finally {
      await fs.rm(destDir, { recursive: true, force: true });
    }
  });
});

