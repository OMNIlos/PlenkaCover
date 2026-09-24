import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const schema = readFileSync(resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');

function model(name: string): string {
  const match = schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`));
  if (!match) throw new Error(`Missing Prisma model ${name}.`);
  return match[0];
}

describe('1C production current mirror schema', () => {
  it('declares immutable source identity and unique report line numbers', () => {
    expect(schema).toContain('model OneCProductionReport');
    expect(schema).toContain('model OneCProductionOutputLine');
    expect(schema).toContain('model OneCProductionMaterialLine');
    expect(schema.match(/@@unique\(\[reportExternalId, lineNumber\]\)/g)).toHaveLength(2);
  });

  it('keeps the report as the only line foreign key and preserves source references', () => {
    const output = model('OneCProductionOutputLine');
    const material = model('OneCProductionMaterialLine');

    for (const line of [output, material]) {
      expect(line).toContain(
        '@relation(fields: [reportExternalId], references: [externalId], onDelete: Cascade)',
      );
      expect(line).toContain('nomenclatureExternalId String?');
      expect(line).toContain('unitExternalId         String?');
      expect(line).toContain('unitName               String?');
      expect(line).toContain('quantity               Decimal');
      expect(line).toContain('@db.Decimal(18, 6)');
      expect(line).not.toMatch(/nomenclature\s+OneC/i);
      expect(line).not.toMatch(/unit\s+OneC/i);
    }
    expect(material).toContain('productExternalId      String?');
    expect(material).not.toMatch(/product\s+OneC/i);
  });
});
