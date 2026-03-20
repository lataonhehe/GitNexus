import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { cloneRepo } from '../../src/server/git-clone.js';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

let tmpGlobalDir = '';

vi.mock('../../src/storage/repo-manager.js', () => ({
  getGlobalDir: () => tmpGlobalDir,
}));

const execFileSyncMock = vi.mocked(execFileSync);

async function mkTmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('git clone depth behavior', () => {
  beforeEach(async () => {
    execFileSyncMock.mockReset();
    tmpGlobalDir = await mkTmpDir('gitnexus-global-');
  });

  it('clones with --depth 200 when gitHistory=true (fresh clone)', async () => {
    const url = 'https://github.com/owner/repo.git';
    const clonesDir = path.join(tmpGlobalDir, 'clones');
    await fs.mkdir(clonesDir, { recursive: true });

    execFileSyncMock.mockReturnValue(Buffer.from(''));

    const result = await cloneRepo(url, { gitHistory: true });
    expect(result.folderName).toBe('repo');

    // Expect git clone --depth 200 ...
    const cloneCall = execFileSyncMock.mock.calls.find((c) => c[0] === 'git' && c[1][0] === 'clone');
    expect(cloneCall).toBeTruthy();
    expect(cloneCall?.[1]).toEqual(expect.arrayContaining(['--depth', '200']));
  });

  it('fetches additional history when existing shallow repo and gitHistory=true', async () => {
    const url = 'https://github.com/owner/repo.git';
    const clonesDir = path.join(tmpGlobalDir, 'clones');
    const targetPath = path.join(clonesDir, 'repo');

    await fs.mkdir(targetPath, { recursive: true });

    // 1) shallow check => true
    // 2) fetch => empty
    // 3) pull => empty
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd !== 'git') return Buffer.from('');
      // Return values are position-based; easiest is just defaults.
      return Buffer.from('');
    });

    // Implement shallow-check specifically by inspecting args.
    execFileSyncMock.mockImplementation((command: string, args: any[]) => {
      if (command !== 'git') return Buffer.from('');
      if (args?.[0] === 'rev-parse' && args?.includes('--is-shallow-repository')) return Buffer.from('true');
      return Buffer.from('');
    });

    const result = await cloneRepo(url, { gitHistory: true });
    expect(result.repoPath).toBe(targetPath);

    const fetchCall = execFileSyncMock.mock.calls.find(
      (c) => c[0] === 'git' && Array.isArray(c[1]) && c[1][0] === 'fetch',
    );
    expect(fetchCall).toBeTruthy();
    expect(fetchCall?.[1]).toEqual(expect.arrayContaining(['--depth', '200']));
    expect(fetchCall?.[1]).toEqual(expect.arrayContaining(['origin', 'HEAD']));
  });
});

