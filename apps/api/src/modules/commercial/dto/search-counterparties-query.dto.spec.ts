import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { SearchCounterpartiesQueryDto } from './search-counterparties-query.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
});

function validateQuery(value: unknown) {
  return pipe.transform(value, { type: 'query', metatype: SearchCounterpartiesQueryDto });
}

describe('SearchCounterpartiesQueryDto', () => {
  it('trims search text and defaults to a bounded page of 20', async () => {
    await expect(validateQuery({ q: '  УралПак  ' })).resolves.toMatchObject({
      q: 'УралПак',
      limit: 20,
    });
  });

  it('accepts the hard maximum page size of 50', async () => {
    await expect(validateQuery({ limit: '50' })).resolves.toMatchObject({ limit: 50 });
  });

  it('rejects a page size above the hard maximum', async () => {
    await expect(validateQuery({ limit: '51' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
