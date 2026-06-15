/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './route';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const mockedMethods = {
    exec: (cmd: string, options: any, callback: any) => {
      const cb = typeof options === 'function' ? options : callback;
      if (cmd.includes('git clone')) {
        cb(null, { stdout: 'Cloned' });
      } else if (cmd.includes('git rev-list')) {
        cb(null, { stdout: '12\n' });
      } else if (cmd.includes('git log -1')) {
        cb(null, { stdout: '2026-06-15\n' });
      } else if (cmd.includes('git log --format="%an"')) {
        cb(null, { stdout: 'Contributor 1\nContributor 2\n' });
      } else {
        cb(null, { stdout: '' });
      }
    }
  };
  return { 
    ...actual, 
    ...mockedMethods,
    default: {
      ...((actual as any).default || actual),
      ...mockedMethods
    }
  };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const mockedMethods = {
    exec: (cmd: string, options: any, callback: any) => {
      const cb = typeof options === 'function' ? options : callback;
      if (cmd.includes('git clone')) {
        cb(null, { stdout: 'Cloned' });
      } else if (cmd.includes('git rev-list')) {
        cb(null, { stdout: '12\n' });
      } else if (cmd.includes('git log -1')) {
        cb(null, { stdout: '2026-06-15\n' });
      } else if (cmd.includes('git log --format="%an"')) {
        cb(null, { stdout: 'Contributor 1\nContributor 2\n' });
      } else {
        cb(null, { stdout: '' });
      }
    }
  };
  return { 
    ...actual, 
    ...mockedMethods,
    default: {
      ...((actual as any).default || actual),
      ...mockedMethods
    }
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const methods = {
    mkdtempSync: () => '/mock/temp/dir',
    rmSync: vi.fn(),
    existsSync: (p: string) => {
      const norm = p.replace(/\\/g, '/');
      if (norm.includes('/mock/temp/dir')) return true;
      return actual.existsSync(p);
    },
    readdirSync: (p: string) => {
      const norm = p.replace(/\\/g, '/');
      if (norm === '/mock/temp/dir') {
        return [
          { name: 'src', isDirectory: () => true, isFile: () => false },
          { name: 'package.json', isDirectory: () => false, isFile: () => true }
        ] as any;
      }
      if (norm === '/mock/temp/dir/src') {
        return [
          { name: 'App.tsx', isDirectory: () => false, isFile: () => true }
        ] as any;
      }
      return actual.readdirSync(p);
    },
    readFileSync: (p: string, encoding: any) => {
      const norm = p.replace(/\\/g, '/');
      if (norm.includes('package.json')) {
        return JSON.stringify({ dependencies: { react: '19.2.4' } });
      }
      if (norm.includes('App.tsx')) {
        return `
          import React from 'react';
          import { Navbar } from './components/Navbar';
          export default function App() {}
        `;
      }
      return actual.readFileSync(p, encoding);
    },
    statSync: (p: string) => {
      const norm = p.replace(/\\/g, '/');
      if (norm.includes('/mock/temp/dir')) {
        return { size: 1000 } as any;
      }
      return actual.statSync(p);
    }
  };
  return {
    ...actual,
    ...methods,
    default: {
      ...((actual as any).default || actual),
      ...methods
    }
  };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const methods = {
    mkdtempSync: () => '/mock/temp/dir',
    rmSync: vi.fn(),
    existsSync: (p: string) => {
      const norm = p.replace(/\\/g, '/');
      if (norm.includes('/mock/temp/dir')) return true;
      return actual.existsSync(p);
    },
    readdirSync: (p: string) => {
      const norm = p.replace(/\\/g, '/');
      if (norm === '/mock/temp/dir') {
        return [
          { name: 'src', isDirectory: () => true, isFile: () => false },
          { name: 'package.json', isDirectory: () => false, isFile: () => true }
        ] as any;
      }
      if (norm === '/mock/temp/dir/src') {
        return [
          { name: 'App.tsx', isDirectory: () => false, isFile: () => true }
        ] as any;
      }
      return actual.readdirSync(p);
    },
    readFileSync: (p: string, encoding: any) => {
      const norm = p.replace(/\\/g, '/');
      if (norm.includes('package.json')) {
        return JSON.stringify({ dependencies: { react: '19.2.4' } });
      }
      if (norm.includes('App.tsx')) {
        return `
          import React from 'react';
          import { Navbar } from './components/Navbar';
          export default function App() {}
        `;
      }
      return actual.readFileSync(p, encoding);
    },
    statSync: (p: string) => {
      const norm = p.replace(/\\/g, '/');
      if (norm.includes('/mock/temp/dir')) {
        return { size: 1000 } as any;
      }
      return actual.statSync(p);
    }
  };
  return {
    ...actual,
    ...methods,
    default: {
      ...((actual as any).default || actual),
      ...methods
    }
  };
});

function makeRequest(body: any): any {
  return new Request('http://localhost/api/architecture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

describe('POST /api/architecture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when repoUrl is missing', async () => {
    const response = await POST(makeRequest({}));
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Repository URL is required');
  });

  it('returns 400 for invalid GitHub URL', async () => {
    const response = await POST(makeRequest({ repoUrl: 'https://notgithub.com/owner/repo' }));
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid GitHub repository URL');
  });

  it('returns 200 with graph data for valid GitHub URL', async () => {
    const response = await POST(makeRequest({ repoUrl: 'https://github.com/JhaSourav07/commitpulse' }));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.folders).toContain('src');
    expect(data.files.length).toBeGreaterThan(0);
    expect(data.files[0].name).toBe('App.tsx');
    expect(data.files[0].imports).toContain('react');
    expect(data.nodes.length).toBeGreaterThan(0);
    expect(data.summary).toBeDefined();
  });
});
