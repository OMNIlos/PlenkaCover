import { collectFilteredEvidencePage, type EvidenceCursor } from './director-evidence.page';

type TestRow = {
  id: string;
  timestamp: string;
  matches: boolean;
};

function makeRows(count: number, matchingPositions: number[]): TestRow[] {
  const matches = new Set(matchingPositions);
  const start = new Date('2026-07-27T12:00:00.000Z').getTime();

  return Array.from({ length: count }, (_, index) => {
    const position = index + 1;
    return {
      id: `row-${position}`,
      timestamp: new Date(start - position * 1_000).toISOString(),
      matches: matches.has(position),
    };
  });
}

function fakeKeysetReader(rows: TestRow[]) {
  return jest.fn(async (cursor: EvidenceCursor | null, take: number) => {
    const start = cursor === null ? 0 : rows.findIndex(({ id }) => id === cursor.id) + 1;
    return rows.slice(start, start + take);
  });
}

function decode(cursor: string): EvidenceCursor {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as EvidenceCursor;
}

function collect(rows: TestRow[], limit: number, initialCursor: EvidenceCursor | null = null) {
  const readChunk = fakeKeysetReader(rows);
  const page = collectFilteredEvidencePage({
    limit,
    initialCursor,
    readChunk,
    projectChunk: async (chunk) => chunk.map((candidate) => ({ candidate, item: candidate })),
    matches: (row) => row.matches,
    cursorOf: (row) => ({
      kind: 'shift',
      timestamp: row.timestamp,
      id: row.id,
    }),
  });

  return { page, readChunk };
}

describe('collectFilteredEvidencePage', () => {
  it('scans beyond the first raw chunk and cursors after the last returned match', async () => {
    const rows = makeRows(140, [70, 130]);
    const { page, readChunk } = collect(rows, 1);

    await expect(page).resolves.toMatchObject({
      items: [expect.objectContaining({ id: 'row-70' })],
      nextCursor: expect.any(String),
    });
    expect(decode((await page).nextCursor ?? '').id).toBe('row-70');
    expect(readChunk).toHaveBeenCalledTimes(3);
  });

  it('returns an empty terminal page after exhausting sparse raw rows', async () => {
    const { page } = collect(makeRows(140, []), 2);

    await expect(page).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('returns a null cursor for exactly limit matches with no later match', async () => {
    const { page } = collect(makeRows(140, [70, 130]), 2);

    await expect(page).resolves.toMatchObject({
      items: [
        expect.objectContaining({ id: 'row-70' }),
        expect.objectContaining({ id: 'row-130' }),
      ],
      nextCursor: null,
    });
  });

  it('returns a cursor after the limitth match when a later match exists', async () => {
    const { page } = collect(makeRows(140, [5, 70, 130]), 2);
    const result = await page;

    expect(result.items.map(({ id }) => id)).toEqual(['row-5', 'row-70']);
    expect(decode(result.nextCursor ?? '').id).toBe('row-70');
  });

  it('does not duplicate the last item of one page on the next page', async () => {
    const rows = makeRows(140, [3, 66, 100, 135]);
    const first = await collect(rows, 2).page;
    const second = await collect(rows, 2, decode(first.nextCursor ?? '')).page;

    expect(first.items.map(({ id }) => id)).toEqual(['row-3', 'row-66']);
    expect(second.items.map(({ id }) => id)).toEqual(['row-100', 'row-135']);
    expect(second.nextCursor).toBeNull();
  });

  it('always asks the chunk reader for a finite bounded take', async () => {
    const { page, readChunk } = collect([], 100);

    await page;

    expect(readChunk).toHaveBeenCalledWith(null, 256);
    for (const [, take] of readChunk.mock.calls) {
      expect(Number.isFinite(take)).toBe(true);
      expect(take).toBeLessThanOrEqual(256);
    }
  });
});
