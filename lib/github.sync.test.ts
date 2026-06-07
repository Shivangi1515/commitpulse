/**
 * GraphQL sync behavior integration tests
 *
 * Tests the real runtime behavior of the GitHub API integration layer:
 * - Delta sync merges old and new calendars correctly
 * - Partial/malformed GraphQL responses are handled gracefully
 * - LoC injection is deterministic and correctly bounded
 * - Empty calendars produce zero-valued LoC fields
 * - Rate-limit error detection in GraphQL response bodies
 * - User-not-found errors for null user data
 * - getWrappedData date range construction
 * - getFullDashboardData graceful degradation
 *
 * Bug prevented: A regression in delta sync could lose contribution
 * data from the cached calendar, causing streaks to reset incorrectly.
 * A regression in LoC injection could produce NaN or negative values
 * that crash SVG rendering.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchGitHubContributions,
  clearGitHubApiCacheForTests,
  contributionsCache,
  cacheKey,
  getFullDashboardData,
  getWrappedData,
} from './github';
import type { ContributionCalendar } from '../types';

vi.mock('server-only', () => ({}));

// ── Test fixtures ──────────────────────────────────────────────────────────────

const mockCalendar: ContributionCalendar = {
  totalContributions: 8,
  weeks: [
    {
      contributionDays: [
        { contributionCount: 3, date: '2024-06-10' },
        { contributionCount: 0, date: '2024-06-11' },
        { contributionCount: 5, date: '2024-06-12' },
      ],
    },
  ],
};

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const originalGitHubPat = process.env.GITHUB_PAT;

beforeEach(() => {
  clearGitHubApiCacheForTests();
  process.env.GITHUB_PAT = 'test-token';
  delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
  clearGitHubApiCacheForTests();
  if (originalGitHubPat === undefined) {
    delete process.env.GITHUB_PAT;
  } else {
    process.env.GITHUB_PAT = originalGitHubPat;
  }
});

// ============================================================================
// Delta sync — mergeCalendars integration
// ============================================================================

describe('fetchGitHubContributions — delta sync merges calendars', () => {
  beforeEach(() => vi.spyOn(global, 'fetch'));
  afterEach(() => vi.restoreAllMocks());

  it('merges old and new calendars when a cached entry exists and becomes stale', async () => {
    const initialCalendar: ContributionCalendar = {
      totalContributions: 3,
      weeks: [
        {
          contributionDays: [
            { contributionCount: 1, date: '2024-01-01' },
            { contributionCount: 2, date: '2024-01-02' },
          ],
        },
      ],
    };

    // First fetch populates the cache
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        data: {
          user: {
            contributionsCollection: {
              contributionCalendar: initialCalendar,
              commitContributionsByRepository: [],
              totalPullRequestContributions: 1,
              totalIssueContributions: 0,
            },
          },
        },
      })
    );

    const first = await fetchGitHubContributions('delta-user');
    expect(first.calendar.totalContributions).toBe(3);

    // Expire the cache by manipulating lastSyncedAt to be stale
    const key = cacheKey('contributions', 'delta-user');
    const cachedData = await contributionsCache.get(key);
    if (cachedData) {
      cachedData.calendar.lastSyncedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      await contributionsCache.set(key, cachedData, 7 * 24 * 60 * 60 * 1000);
    }

    // Second fetch returns new data that should merge with the old
    const newCalendar: ContributionCalendar = {
      totalContributions: 7,
      weeks: [
        {
          contributionDays: [
            { contributionCount: 5, date: '2024-01-03' },
            { contributionCount: 2, date: '2024-01-04' },
          ],
        },
      ],
    };

    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        data: {
          user: {
            contributionsCollection: {
              contributionCalendar: newCalendar,
              commitContributionsByRepository: [],
              totalPullRequestContributions: 1,
              totalIssueContributions: 0,
            },
          },
        },
      })
    );

    const second = await fetchGitHubContributions('delta-user');

    // The merged calendar must contain all 4 days from both calendars
    const allDays = second.calendar.weeks.flatMap((w) => w.contributionDays);
    const dates = allDays.map((d) => d.date).sort();
    expect(dates).toEqual(['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04']);

    // Total should use the authoritative total from the fresh API response
    expect(second.calendar.totalContributions).toBe(7);
  });

  it('sends the "from" variable when performing a delta sync', async () => {
    // First fetch to populate the cache
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        data: {
          user: {
            contributionsCollection: {
              contributionCalendar: mockCalendar,
              commitContributionsByRepository: [],
            },
          },
        },
      })
    );

    await fetchGitHubContributions('delta-from-user');

    // Expire the cache to trigger a delta sync
    const key = cacheKey('contributions', 'delta-from-user');
    const cachedData = await contributionsCache.get(key);
    if (cachedData) {
      cachedData.calendar.lastSyncedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      await contributionsCache.set(key, cachedData, 7 * 24 * 60 * 60 * 1000);
    }

    // Reset the mock so we can inspect the next call
    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        data: {
          user: {
            contributionsCollection: {
              contributionCalendar: mockCalendar,
              commitContributionsByRepository: [],
            },
          },
        },
      })
    );

    await fetchGitHubContributions('delta-from-user');

    // The second fetch must include a "from" variable for the delta window
    const [, options] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(options?.body as string);
    expect(body.variables.from).toBeDefined();
    expect(typeof body.variables.from).toBe('string');
  });
});

// ============================================================================
// LoC injection — determinism and bounds
// ============================================================================

describe('fetchGitHubContributions — LoC injection', () => {
  beforeEach(() => vi.spyOn(global, 'fetch'));
  afterEach(() => vi.restoreAllMocks());

  it('injects non-negative locAdditions and locDeletions for days with contributions', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        data: {
          user: {
            contributionsCollection: {
              contributionCalendar: mockCalendar,
              commitContributionsByRepository: [],
            },
          },
        },
      })
    );

    const { calendar } = await fetchGitHubContributions('loc-user');
    const daysWithContrib = calendar.weeks
      .flatMap((w) => w.contributionDays)
      .filter((d) => d.contributionCount > 0);

    for (const day of daysWithContrib) {
      expect(day.locAdditions).toBeDefined();
      expect(day.locDeletions).toBeDefined();
      expect(day.locAdditions!).toBeGreaterThanOrEqual(0);
      expect(day.locDeletions!).toBeGreaterThanOrEqual(0);
      // Additions should generally be >= deletions for the same count
      expect(day.locAdditions!).toBeGreaterThanOrEqual(day.locDeletions!);
    }
  });

  it('sets locAdditions and locDeletions to 0 for zero-contribution days', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        data: {
          user: {
            contributionsCollection: {
              contributionCalendar: mockCalendar,
              commitContributionsByRepository: [],
            },
          },
        },
      })
    );

    const { calendar } = await fetchGitHubContributions('loc-zero-user');
    const zeroDays = calendar.weeks
      .flatMap((w) => w.contributionDays)
      .filter((d) => d.contributionCount === 0);

    for (const day of zeroDays) {
      expect(day.locAdditions).toBe(0);
      expect(day.locDeletions).toBe(0);
    }
  });

  it('produces deterministic LoC values for the same date and count', async () => {
    // Each call to fetchGitHubContributions with bypassCache triggers a fresh
    // fetch. fetchGraphQLWithRetry clones the response, so we need a fresh
    // Response object per invocation to avoid "Body already consumed" errors.
    vi.mocked(fetch).mockImplementation(async () =>
      mockResponse({
        data: {
          user: {
            contributionsCollection: {
              contributionCalendar: mockCalendar,
              commitContributionsByRepository: [],
            },
          },
        },
      })
    );

    const first = await fetchGitHubContributions('det-loc-user', { bypassCache: true });
    const second = await fetchGitHubContributions('det-loc-user', { bypassCache: true });

    const firstDays = first.calendar.weeks.flatMap((w) => w.contributionDays);
    const secondDays = second.calendar.weeks.flatMap((w) => w.contributionDays);

    for (let i = 0; i < firstDays.length; i++) {
      expect(firstDays[i].locAdditions).toBe(secondDays[i].locAdditions);
      expect(firstDays[i].locDeletions).toBe(secondDays[i].locDeletions);
    }
  });
});

// ============================================================================
// Partial and malformed GraphQL responses
// ============================================================================

describe('fetchGitHubContributions — partial and malformed responses', () => {
  beforeEach(() => vi.spyOn(global, 'fetch'));
  afterEach(() => vi.restoreAllMocks());

  it('handles a response with missing contributionCalendar gracefully', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        data: {
          user: {
            contributionsCollection: {
              commitContributionsByRepository: [],
            },
          },
        },
      })
    );

    const { calendar } = await fetchGitHubContributions('partial-user');
    expect(calendar.totalContributions).toBe(0);
    expect(calendar.weeks).toEqual([]);
  });

  it('handles a response with null contributionsCollection gracefully', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        data: {
          user: {
            contributionsCollection: null,
          },
        },
      })
    );

    const { calendar } = await fetchGitHubContributions('null-collection-user');
    expect(calendar.totalContributions).toBe(0);
    expect(calendar.weeks).toEqual([]);
  });

  it('handles a response where contributionCalendar has no weeks array', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        data: {
          user: {
            contributionsCollection: {
              contributionCalendar: { totalContributions: 5 },
            },
          },
        },
      })
    );

    const { calendar } = await fetchGitHubContributions('no-weeks-user');
    expect(calendar.totalContributions).toBe(0);
    expect(calendar.weeks).toEqual([]);
  });

  it('throws "user not found" when data.user is null', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        data: { user: null },
      })
    );

    await expect(fetchGitHubContributions('nonexistent-user')).rejects.toThrow(
      'GitHub user "nonexistent-user" not found'
    );
  });

  it('throws "user not found" when data.data is missing entirely', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        data: {},
      })
    );

    await expect(fetchGitHubContributions('missing-data-user')).rejects.toThrow(
      'GitHub user "missing-data-user" not found'
    );
  });

  it('detects rate limit errors via message string in GraphQL body', async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      mockResponse({
        data: { user: null },
        errors: [{ message: 'API rate limit exceeded for user' }],
      })
    );

    await expect(fetchGitHubContributions('ratelimit-msg-user')).rejects.toThrow(
      'API Rate Limit Exceeded'
    );
  });

  it('detects rate limit errors via RATE_LIMITED type in GraphQL body', async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      mockResponse({
        data: { user: null },
        errors: [{ type: 'RATE_LIMITED', message: 'Too many requests' }],
      })
    );

    await expect(fetchGitHubContributions('ratelimit-type-user')).rejects.toThrow(
      'API Rate Limit Exceeded'
    );
  });
});

// ============================================================================
// getWrappedData — year boundary and date range construction
// ============================================================================

describe('getWrappedData — constructs correct date range from year', () => {
  beforeEach(() => vi.spyOn(global, 'fetch'));
  afterEach(() => vi.restoreAllMocks());

  it('sends from=YYYY-01-01T00:00:00Z and to=YYYY-12-31T23:59:59Z for year 2024', async () => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      const urlStr = typeof url === 'string' ? url : (url?.toString() ?? '');
      if (urlStr.includes('/repos')) return mockResponse([]);
      return mockResponse({
        data: {
          user: {
            contributionsCollection: {
              contributionCalendar: {
                totalContributions: 100,
                weeks: [],
              },
            },
          },
        },
      });
    });

    await getWrappedData('octocat', '2024');

    const graphQLCall = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => url.toString().includes('/graphql'));
    const body = JSON.parse(graphQLCall?.[1]?.body as string);

    expect(body.variables.from).toBe('2024-01-01T00:00:00Z');
    expect(body.variables.to).toBe('2024-12-31T23:59:59Z');
  });

  it('handles an empty calendar without crashing', async () => {
    const emptyCalendar: ContributionCalendar = {
      totalContributions: 0,
      weeks: [],
    };

    vi.mocked(fetch).mockImplementation(async (url) => {
      const urlStr = typeof url === 'string' ? url : (url?.toString() ?? '');
      if (urlStr.includes('/repos')) return mockResponse([]);
      return mockResponse({
        data: {
          user: {
            contributionsCollection: {
              contributionCalendar: emptyCalendar,
            },
          },
        },
      });
    });

    const result = await getWrappedData('empty-wrapped-user', '2024');

    expect(result.totalContributions).toBe(0);
    expect(result.topLanguage).toBe('Unknown');
    expect(result.busiestMonth).toBe('2024-01');
  });
});

// ============================================================================
// getFullDashboardData — graceful degradation on partial failures
// ============================================================================

describe('getFullDashboardData — graceful degradation', () => {
  beforeEach(() => vi.spyOn(global, 'fetch'));
  afterEach(() => vi.restoreAllMocks());

  it('returns zero contributions and empty calendar when GitHub contributions fetch fails', async () => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      const urlStr = typeof url === 'string' ? url : (url?.toString() ?? '');
      if (urlStr.includes('/repos')) return mockResponse([]);
      if (urlStr.includes('/users/fail-contrib') && !urlStr.includes('/repos'))
        return mockResponse({
          login: 'fail-contrib',
          name: 'Test',
          avatar_url: 'avatar.png',
          public_repos: 0,
          followers: 0,
          following: 0,
          created_at: '2020-01-01T00:00:00Z',
        });
      // GraphQL fails — fetchWithRetry retries up to 3 times, so we need
      // to reject every GraphQL attempt to exhaust retries
      if (urlStr.includes('/graphql')) {
        throw new Error('GraphQL network failure');
      }
      return mockResponse({ data: {} });
    });

    const result = await getFullDashboardData('fail-contrib');
    expect(result.profile.username).toBe('fail-contrib');
    // getFullDashboardData uses Promise.allSettled, so GraphQL failures
    // are caught and result in zero contributions gracefully
    expect(result.stats.totalContributions).toBe(0);
  });
});
