import { resolveSpoolPolicy } from './operator-spool-policy';

describe('resolveSpoolPolicy', () => {
  it.each(['Тонкая', 'тонкая шпуля', 'THIN'])(
    'uses the audited 0.7 kg standard for %s',
    (spoolType) => {
      expect(resolveSpoolPolicy({ spoolType })).toEqual({
        mode: 'standard_700g',
        kg: 0.7,
      });
    },
  );

  it.each(['Толстая', 'Шпуля 76 мм', '152 мм', null, undefined, ''])(
    'requires physical measurement for ambiguous or thick value %p',
    (spoolType) => {
      expect(resolveSpoolPolicy({ spoolType })).toEqual({
        mode: 'physical_measurement',
        kg: null,
      });
    },
  );
});
