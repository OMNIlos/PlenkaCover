import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CommercialRawMaterialRiskQueryDto } from './commercial-raw-material-risk.dto';

describe('CommercialRawMaterialRiskQueryDto', () => {
  it('normalizes surrounding whitespace without changing the search text', async () => {
    const dto = plainToInstance(CommercialRawMaterialRiskQueryDto, {
      q: '  ПВД 10803  ',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.q).toBe('ПВД 10803');
  });

  it('rejects oversized search input', async () => {
    const dto = plainToInstance(CommercialRawMaterialRiskQueryDto, {
      q: 'x'.repeat(121),
    });

    await expect(validate(dto)).resolves.not.toHaveLength(0);
  });
});
