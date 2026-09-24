import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateRecipeCatalogDto } from './create-recipe-catalog.dto';

const clientRequestId = 'a6b84db0-a6d2-4c57-92d5-70c4bb721df3';

async function errors(value: object) {
  return validate(plainToInstance(CreateRecipeCatalogDto, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('CreateRecipeCatalogDto', () => {
  it('accepts existing catalog material ingredients', async () => {
    await expect(
      errors({
        clientRequestId,
        name: 'Синяя смесь',
        ingredients: [
          { rawMaterialDefinitionId: 'm-1', shareBasisPoints: 6000 },
          { rawMaterialDefinitionId: 'm-2', shareBasisPoints: 4000 },
        ],
      }),
    ).resolves.toHaveLength(0);
  });

  it('rejects inline product creation because only admin manages the catalog', async () => {
    await expect(
      errors({
        clientRequestId,
        name: 'Синяя смесь',
        ingredients: [{ newMaterial: { name: 'Синяя добавка' }, shareBasisPoints: 10_000 }],
      }),
    ).resolves.not.toHaveLength(0);
  });

  it('requires a non-null existing material id and a share', async () => {
    await expect(
      errors({
        clientRequestId,
        name: 'Синяя смесь',
        ingredients: [{ shareBasisPoints: 10_000 }],
      }),
    ).resolves.not.toHaveLength(0);
    await expect(
      errors({
        clientRequestId,
        name: 'Синяя смесь',
        ingredients: [{ rawMaterialDefinitionId: null, shareBasisPoints: 10_000 }],
      }),
    ).resolves.not.toHaveLength(0);
    await expect(
      errors({
        clientRequestId,
        name: 'Синяя смесь',
        ingredients: [[]],
      }),
    ).resolves.not.toHaveLength(0);
    await expect(
      errors({
        clientRequestId,
        name: 'Синяя смесь',
        ingredients: [{ rawMaterialDefinitionId: 'm-1' }],
      }),
    ).resolves.not.toHaveLength(0);
  });

  it('validates command, collection, name, and share boundaries', async () => {
    await expect(
      errors({
        clientRequestId: 'not-a-uuid',
        name: '',
        ingredients: [],
      }),
    ).resolves.not.toHaveLength(0);
    await expect(
      errors({
        clientRequestId,
        name: 'x'.repeat(121),
        ingredients: Array.from({ length: 51 }, (_, index) => ({
          rawMaterialDefinitionId: `m-${index}`,
          shareBasisPoints: 1,
        })),
      }),
    ).resolves.not.toHaveLength(0);
    await expect(
      errors({
        clientRequestId,
        name: 'Синяя смесь',
        ingredients: [{ rawMaterialDefinitionId: 'm-1', shareBasisPoints: 0 }],
      }),
    ).resolves.not.toHaveLength(0);
    await expect(
      errors({
        clientRequestId,
        name: 'Синяя смесь',
        ingredients: [{ rawMaterialDefinitionId: 'm-1', shareBasisPoints: 10_001 }],
      }),
    ).resolves.not.toHaveLength(0);
  });
});
