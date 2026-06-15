/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import ArchitectureVisualizer from './ArchitectureVisualizer';

// Mock @xyflow/react
vi.mock('@xyflow/react', () => {
  return {
    ReactFlow: ({ children, nodes, onNodeClick }: any) => (
      <div data-testid="react-flow-mock">
        {nodes?.map((node: any) => (
          <button 
            key={node.id} 
            data-testid={`node-${node.id}`} 
            onClick={(e) => onNodeClick?.(e, node)}
          >
            {node.data?.label}
          </button>
        ))}
        {children}
      </div>
    ),
    Background: () => <div data-testid="react-flow-background" />,
    Controls: () => <div data-testid="react-flow-controls" />,
    MiniMap: () => <div data-testid="react-flow-minimap" />,
    Handle: ({ type, position }: any) => <div data-testid={`handle-${type}-${position}`} />,
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    useNodesState: (initial: any) => {
      const [val, setVal] = React.useState(initial);
      const onChange = React.useCallback(() => {}, []);
      return [val, setVal, onChange];
    },
    useEdgesState: (initial: any) => {
      const [val, setVal] = React.useState(initial);
      const onChange = React.useCallback(() => {}, []);
      return [val, setVal, onChange];
    }
  };
});

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}));

const mockSuccessData = {
  folders: ['src', 'src/components'],
  files: [
    {
      path: 'src/App.tsx',
      name: 'App.tsx',
      type: 'tsx',
      size: 1500,
      linesOfCode: 50,
      commits: 5,
      lastModified: '2026-06-15',
      contributors: ['Author 1'],
      imports: ['./components/Navbar'],
      exports: ['default']
    },
    {
      path: 'src/components/Navbar.tsx',
      name: 'Navbar.tsx',
      type: 'tsx',
      size: 800,
      linesOfCode: 25,
      commits: 2,
      lastModified: '2026-06-14',
      contributors: ['Author 2'],
      imports: [],
      exports: ['Navbar']
    }
  ],
  nodes: [
    {
      id: 'src',
      type: 'folderNode',
      data: { label: 'src', path: 'src', isFolder: true },
      position: { x: 0, y: 0 }
    },
    {
      id: 'src/App.tsx',
      type: 'fileNode',
      data: {
        label: 'App.tsx',
        path: 'src/App.tsx',
        type: 'tsx',
        size: 1500,
        linesOfCode: 50,
        commits: 5,
        lastModified: '2026-06-15',
        contributors: ['Author 1'],
        imports: ['./components/Navbar'],
        exports: ['default'],
        isFolder: false
      },
      position: { x: 0, y: 150 }
    }
  ],
  edges: [
    {
      id: 'contain-src-src/App.tsx',
      source: 'src',
      target: 'src/App.tsx',
      type: 'default'
    }
  ],
  summary: '• This repository follows a clean modular layout.\n• Separation of concerns is excellent.'
};

describe('ArchitectureVisualizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn() as any;
  });

  it('renders initial empty state with input and button', () => {
    render(<ArchitectureVisualizer />);
    expect(screen.getByText('Visualize Repository Architecture')).toBeDefined();
    expect(screen.getByPlaceholderText('https://github.com/owner/repository')).toBeDefined();
    expect(screen.getByText('✨ Generate Architecture')).toBeDefined();
  });

  it('renders loading progress states when generating', async () => {
    let resolveFetch: any;
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = () => resolve({
        ok: true,
        json: async () => mockSuccessData
      });
    });
    (global.fetch as any).mockReturnValueOnce(fetchPromise);

    render(<ArchitectureVisualizer />);
    const input = screen.getByPlaceholderText('https://github.com/owner/repository');
    const btn = screen.getByText('✨ Generate Architecture');

    fireEvent.change(input, { target: { value: 'https://github.com/owner/repo' } });
    fireEvent.click(btn);

    // Verify it is in loading state
    await waitFor(() => {
      expect(screen.getByText('Fetching repository...')).toBeDefined();
    });

    // Clean up and resolve fetch
    await act(async () => {
      resolveFetch();
    });
  });

  it('renders output tabs when API returns successfully', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockSuccessData
    });

    render(<ArchitectureVisualizer />);
    const input = screen.getByPlaceholderText('https://github.com/owner/repository');
    const btn = screen.getByText('✨ Generate Architecture');

    fireEvent.change(input, { target: { value: 'https://github.com/owner/repo' } });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByText('Architecture')).toBeDefined();
      expect(screen.getByText('Folder Tree')).toBeDefined();
      expect(screen.getByText('Dependencies')).toBeDefined();
      expect(screen.getByText('Summary')).toBeDefined();
    });
  });

  it('allows tab navigation and clicking node shows details', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockSuccessData
    });

    render(<ArchitectureVisualizer />);
    const input = screen.getByPlaceholderText('https://github.com/owner/repository');
    const btn = screen.getByText('✨ Generate Architecture');

    fireEvent.change(input, { target: { value: 'https://github.com/owner/repo' } });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByText('Architecture')).toBeDefined();
    });

    // Click on App.tsx node
    const appNodeBtn = screen.getByTestId('node-src/App.tsx');
    fireEvent.click(appNodeBtn);

    // Verify side panel content
    expect(screen.getByText('File Spec')).toBeDefined();
    expect(screen.getAllByText('App.tsx').length).toBeGreaterThan(0);
    expect(screen.getByText('50')).toBeDefined(); // Lines of Code
    expect(screen.getByText('Author 1')).toBeDefined(); // Contributors
  });

  it('handles API errors gracefully and allows retry', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Repository not found' })
    });

    render(<ArchitectureVisualizer />);
    const input = screen.getByPlaceholderText('https://github.com/owner/repository');
    const btn = screen.getByText('✨ Generate Architecture');

    fireEvent.change(input, { target: { value: 'https://github.com/owner/invalid-repo' } });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByText('Analysis Failed')).toBeDefined();
      expect(screen.getByText('Repository not found')).toBeDefined();
      expect(screen.getByText('Retry Analysis')).toBeDefined();
    });
  });
});
