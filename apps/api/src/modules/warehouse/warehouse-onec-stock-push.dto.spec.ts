import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OneCStockPushDto } from './dto/onec-stock-push.dto';
import { OneCStockPushPreviewResponseDto } from './dto/onec-stock-push.dto';

const operationKey = '9a88f1d4-c13a-4e85-88b1-a2f6cad67976';
const snapshotHash = 'a'.repeat(64);

async function errors(value: object) {
  return validate(plainToInstance(OneCStockPushDto, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('OneCStockPushDto', () => {
  it('requires a UUID-v4 operation key and a lowercase SHA-256 snapshot hash', async () => {
    await expect(errors({ operationKey, snapshotHash })).resolves.toEqual([]);
    expect(await errors({ operationKey: 'not-a-uuid', snapshotHash })).not.toHaveLength(0);
    expect(await errors({ operationKey, snapshotHash: 'A'.repeat(64) })).not.toHaveLength(0);
    expect(await errors({ operationKey, snapshotHash: 'a'.repeat(63) })).not.toHaveLength(0);
  });

  it('rejects unknown request fields', async () => {
    const result = await errors({ operationKey, snapshotHash, force: true });
    expect(result.some((error) => error.constraints?.whitelistValidation)).toBe(true);
  });

  it('canonicalizes an uppercase UUID before it reaches PostgreSQL UUID storage', async () => {
    const dto = plainToInstance(OneCStockPushDto, {
      operationKey: operationKey.toUpperCase(),
      snapshotHash,
    });
    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto.operationKey).toBe(operationKey);
  });
});

describe('OneCStockPushPreviewResponseDto', () => {
  it('publishes explicit write-readiness fields in the API schema class', () => {
    const preview = new OneCStockPushPreviewResponseDto();
    preview.writeReady = false;
    preview.readinessCode = 'write_disabled';
    preview.readinessMessage = 'Запись выключена.';

    expect(preview).toMatchObject({
      writeReady: false,
      readinessCode: 'write_disabled',
      readinessMessage: 'Запись выключена.',
    });
  });
});
