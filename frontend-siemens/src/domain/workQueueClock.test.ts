import { describe, expect, it } from 'vitest';

import { financeWorkObjects } from './fixtures/finance';
import { getWorkQueueMeta } from './selectors';
import type { WorkObject } from './types';

const datedFixture: WorkObject = {
  ...financeWorkObjects[0],
  kind: 'intake',
  statusLabel: 'В работе',
  filterTags: [],
  facts: [{ label: 'Срок', value: '2026-07-31' }],
  sections: [],
  actions: [],
  problems: [],
  audit: [],
};

describe('work queue business clock', () => {
  it('keeps the dated fixture scheduled when its date is the Moscow business day', () => {
    expect(
      getWorkQueueMeta('commercial', datedFixture, new Date('2026-07-31T20:59:59.000Z'))
        .queueBucket,
    ).toBe('scheduled');
  });

  it('moves the same fixture to active after Moscow crosses into the next day', () => {
    expect(
      getWorkQueueMeta('commercial', datedFixture, new Date('2026-07-31T21:00:00.000Z'))
        .queueBucket,
    ).toBe('active');
  });
});
