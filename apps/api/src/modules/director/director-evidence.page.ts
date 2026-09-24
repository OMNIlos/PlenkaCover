export type EvidenceCursor = {
  kind: 'shift' | 'bigbag';
  timestamp: string;
  id: string;
};

type ProjectedEvidence<TCandidate, TItem> = {
  candidate: TCandidate;
  item: TItem;
};

function encodeEvidenceCursor(cursor: EvidenceCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export async function collectFilteredEvidencePage<TCandidate, TItem>(input: {
  limit: number;
  initialCursor: EvidenceCursor | null;
  readChunk: (cursor: EvidenceCursor | null, take: number) => Promise<TCandidate[]>;
  projectChunk: (rows: TCandidate[]) => Promise<Array<ProjectedEvidence<TCandidate, TItem>>>;
  matches: (item: TItem) => boolean;
  cursorOf: (candidate: TCandidate) => EvidenceCursor;
}): Promise<{ items: TItem[]; nextCursor: string | null }> {
  const chunkSize = Math.min(Math.max(input.limit * 4, 64), 256);
  const matchingRows: Array<ProjectedEvidence<TCandidate, TItem>> = [];
  let scanCursor = input.initialCursor;

  while (matchingRows.length <= input.limit) {
    const candidates = await input.readChunk(scanCursor, chunkSize);
    if (candidates.length === 0) break;

    const projected = await input.projectChunk(candidates);
    for (const row of projected) {
      if (input.matches(row.item)) matchingRows.push(row);
      if (matchingRows.length > input.limit) break;
    }

    if (matchingRows.length > input.limit || candidates.length < chunkSize) break;
    scanCursor = input.cursorOf(candidates[candidates.length - 1]);
  }

  const pageRows = matchingRows.slice(0, input.limit);
  return {
    items: pageRows.map(({ item }) => item),
    nextCursor:
      matchingRows.length > input.limit
        ? encodeEvidenceCursor(input.cursorOf(pageRows[pageRows.length - 1].candidate))
        : null,
  };
}
