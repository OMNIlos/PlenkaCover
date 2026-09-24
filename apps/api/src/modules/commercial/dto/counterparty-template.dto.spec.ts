import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCounterpartyTemplateDto } from './counterparty-template.dto';

const validPosition = {
  rollCount: 2,
  filmType: 'Рукав',
  actualThickness: '80 мкм',
  accountingThickness: '78 мкм',
  widthMm: 1700,
  plannedLengthM: 275,
  plannedWeightKg: 41.2,
  baseRawMaterialDefinitionId: 'material-primary',
  spoolType: 'Тонкая',
  birka: 'ГОСТ',
};

async function templateErrors(value: object) {
  return validate(plainToInstance(CreateCounterpartyTemplateDto, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('CreateCounterpartyTemplateDto', () => {
  it.each([
    ['film type', { filmType: 'Пятый тип' }],
    ['spool type', { spoolType: 'Самодельная' }],
    ['standard label', { birka: 'Произвольная' }],
  ])('rejects a value outside the bounded %s catalog', async (_label, patch) => {
    await expect(
      templateErrors({
        name: 'Проверяемый шаблон',
        positions: [{ ...validPosition, ...patch }],
      }),
    ).resolves.not.toHaveLength(0);
  });

  it('rejects a blank template name before persistence', async () => {
    await expect(
      templateErrors({ name: '   ', positions: [validPosition] }),
    ).resolves.not.toHaveLength(0);
  });
});
