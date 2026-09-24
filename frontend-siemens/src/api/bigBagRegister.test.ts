import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBigBagRegisterPage, parseBigBagRegisterPage } from './bigBagRegister';

const baseRow = {
  id: 'bag-1',
  code: 'BB-001',
  material: 'ПВД 10803-020',
  batch: null,
  createdAt: '2026-08-08T06:30:00.000Z',
  status: 'available',
  location: { kind: 'production', postCode: null, postName: null },
  operatorName: null,
  currentWeightKg: 249.5,
  totalKopecks: 623_750,
};

function page(row: unknown) {
  return { items: [row], page: 1, pageSize: 25, total: 1 };
}

afterEach(() => vi.unstubAllGlobals());

describe('BigBag register contract', () => {
  it('sends the current view before server pagination', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(page(baseRow)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchBigBagRegisterPage({ view: 'current', page: 2, pageSize: 10 });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/raw-materials/big-bags?view=current&page=2&pageSize=10',
      expect.objectContaining({ method: 'GET' }),
    );
  });
  it('accepts a free production bag without an operator', () => {
    expect(parseBigBagRegisterPage(page(baseRow)).items[0]).toEqual(baseRow);
  });

  it('accepts one complete occupied post assignment', () => {
    const occupied = {
      ...baseRow,
      status: 'in_use',
      location: { kind: 'post', postCode: 'POST-2', postName: 'Экструдер 2' },
      operatorName: 'Анна Соколова',
    };

    expect(parseBigBagRegisterPage(page(occupied)).items[0]).toEqual(occupied);
  });

  it.each([
    {
      ...baseRow,
      status: 'in_use',
      location: { kind: 'post', postCode: 'POST-2', postName: 'Экструдер 2' },
      operatorName: null,
    },
    { ...baseRow, operatorName: 'Лишнее имя' },
    {
      ...baseRow,
      location: { kind: 'warehouse', postCode: 'POST-2', postName: null },
    },
  ])('rejects contradictory assignment facts', (row) => {
    expect(() => parseBigBagRegisterPage(page(row))).toThrow(
      'Сервер вернул некорректный реестр Big-Bag.',
    );
  });
});
