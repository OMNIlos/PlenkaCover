import type {
  DirectorPayrollMachineFamily,
  DirectorPayrollMaterialClass,
  DirectorPayrollShiftDuration,
  DirectorPayrollTariffRule,
  DirectorPayrollUnresolvedReason,
  PayrollTariffAbcBandV1,
  PayrollTariffMatrixV1,
  PayrollTariffUrpBandV1,
} from '@plenka/contracts';
import { LEGACY_PAYROLL_TARIFF_MATRIX_V1 } from './legacy-payroll-tariff-matrix';

export { LEGACY_PAYROLL_TARIFF_MATRIX_V1 };

export type PayrollShiftRateInput = {
  postName: string;
  startedAt: Date | null;
  endedAt: Date | null;
  processedGrams: number | null;
  materialNames: readonly string[];
};

export type PayrollRollRateInput = {
  /** Root-production timestamp used only by the schedule resolver. */
  producedAt: Date;
  postName: string;
  shiftStartedAt: Date | null;
  shiftEndedAt: Date | null;
  shiftOutputGrams: number;
  rollGrams: number;
  materialNames: readonly string[];
  birka?: string | null;
  filmType: string | null;
  counterpartyLegalName: string | null;
};

export type PayrollResolvedRollRate = {
  kind: 'resolved';
  machineFamily: DirectorPayrollMachineFamily;
  shiftDuration: DirectorPayrollShiftDuration;
  rateKopecksPerKg: number;
  tariffRule: DirectorPayrollTariffRule;
  basisLabel: string;
  materialClass: DirectorPayrollMaterialClass | null;
  filmClass: 'standard' | 'black_white' | null;
  specialCustomer: boolean;
};

export type PayrollUnresolvedRate = {
  kind: 'unresolved';
  reasons: DirectorPayrollUnresolvedReason[];
  machineFamily: DirectorPayrollMachineFamily | null;
  shiftDuration: DirectorPayrollShiftDuration | null;
};

export type PayrollRollRateResolution = PayrollResolvedRollRate | PayrollUnresolvedRate;

export type PayrollShiftRateResolution =
  | {
      kind: 'resolved';
      machineFamily: DirectorPayrollMachineFamily;
      shiftDuration: DirectorPayrollShiftDuration;
      rateKopecksPerKg: number;
      tariffRule: DirectorPayrollTariffRule;
      materialClass: DirectorPayrollMaterialClass;
      amountKopecks: number;
      basisLabel: string;
    }
  | PayrollUnresolvedRate;

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

const MACHINE_ALIASES = new Map<string, DirectorPayrollMachineFamily>([
  ['УРП', 'urp'],
  ['МАТИЛЬ', 'matil'],
  ['КИТАЙКА', 'kitayka'],
  ['КИТАЙКА СТАРАЯ', 'kitayka'],
  ['АВС СТАРАЯ', 'abc_old'],
  ['ABC СТАРАЯ', 'abc_old'],
  ['АВС НОВАЯ', 'abc_new'],
  ['ABC НОВАЯ', 'abc_new'],
  // Owner decision: Begemot uses the ABC ladder but never the abc_new Alabuga rule.
  ['БЕГЕМОТ', 'abc_old'],
]);

const MACHINE_LABELS: Record<DirectorPayrollMachineFamily, string> = {
  urp: 'УРП',
  matil: 'Матиль',
  kitayka: 'Китайка',
  abc_old: 'АВС старая',
  abc_new: 'АВС новая',
};

const RULE_LABELS: Record<DirectorPayrollTariffRule, string> = {
  primary: 'первичка',
  secondary: 'вторичка',
  thin_roll: 'тонкий рулон',
  abc_standard: 'стандартная плёнка',
  abc_black_white: 'фальц',
  alabuga_override: 'ОЭЗ ППТ АЛАБУГА АО',
};

const ABC_FALZ_FILM_TYPES = new Set(['ФАЛЬЦ', 'ЧЕРНО БЕЛАЯ']);

export function normalizePayrollBasisLabel(value: string): string {
  return value.replace(/ч[её]рно-белая пл[её]нка/giu, 'фальц');
}

export function normalizePayrollClassifierValue(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleUpperCase('ru-RU')
    .replaceAll('Ё', 'Е')
    .replace(/\p{P}+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function classifyPayrollMachine(postName: string): DirectorPayrollMachineFamily | null {
  return MACHINE_ALIASES.get(normalizePayrollClassifierValue(postName)) ?? null;
}

export function classifyPayrollShiftDuration(
  startedAt: Date | null,
  endedAt: Date | null,
): DirectorPayrollShiftDuration | null {
  if (startedAt === null || endedAt === null) return null;
  const elapsedMs = endedAt.getTime() - startedAt.getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  return elapsedMs > TWELVE_HOURS_MS ? '24h' : '12h';
}

export function classifyPayrollMaterial(
  materialNames: readonly string[],
  birka?: string | null,
): DirectorPayrollMaterialClass {
  const tag = normalizePayrollClassifierValue((birka ?? '').split('/')[0]!);
  if (tag.startsWith('ГОСТ')) return 'primary';
  if (tag === 'I' || tag === 'АЙКА' || tag === 'ТЕХ') return 'secondary';
  return materialNames.some((name) => normalizePayrollClassifierValue(name).includes('ВТОРИЧ'))
    ? 'secondary'
    : 'primary';
}

export function payrollBirkaFromSnapshot(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const fields = snapshot as Record<string, unknown>;
  for (const value of [fields.birka, fields.manualBirka]) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function unresolved(
  reasons: DirectorPayrollUnresolvedReason[],
  machineFamily: DirectorPayrollMachineFamily | null,
  shiftDuration: DirectorPayrollShiftDuration | null,
): PayrollUnresolvedRate {
  return { kind: 'unresolved', reasons, machineFamily, shiftDuration };
}

function classifications(
  postName: string,
  startedAt: Date | null,
  endedAt: Date | null,
):
  | {
      kind: 'resolved';
      machineFamily: DirectorPayrollMachineFamily;
      shiftDuration: DirectorPayrollShiftDuration;
    }
  | PayrollUnresolvedRate {
  const machineFamily = classifyPayrollMachine(postName);
  const shiftDuration = classifyPayrollShiftDuration(startedAt, endedAt);
  const reasons: DirectorPayrollUnresolvedReason[] = [];
  if (machineFamily === null) reasons.push('machine_family_unresolved');
  if (shiftDuration === null) reasons.push('shift_duration_unresolved');
  return reasons.length > 0
    ? unresolved(reasons, machineFamily, shiftDuration)
    : {
        kind: 'resolved',
        machineFamily: machineFamily!,
        shiftDuration: shiftDuration!,
      };
}

function isUrpFamily(
  machineFamily: DirectorPayrollMachineFamily,
): machineFamily is 'urp' | 'matil' | 'kitayka' {
  return machineFamily === 'urp' || machineFamily === 'matil' || machineFamily === 'kitayka';
}

function ladderKey(
  machineFamily: DirectorPayrollMachineFamily,
  shiftDuration: DirectorPayrollShiftDuration,
): 'urp12h' | 'urp24h' | 'abc12h' | 'abc24h' {
  if (isUrpFamily(machineFamily)) return shiftDuration === '12h' ? 'urp12h' : 'urp24h';
  return shiftDuration === '12h' ? 'abc12h' : 'abc24h';
}

function bandFor<T extends PayrollTariffUrpBandV1 | PayrollTariffAbcBandV1>(
  bands: readonly T[],
  grams: number,
): T {
  return bands.find((band) => band.maxInclusiveGrams === null || grams <= band.maxInclusiveGrams)!;
}

export function calculatePayrollAmountKopecks(grams: number, rateKopecksPerKg: number): number {
  return Math.round((grams * rateKopecksPerKg) / 1_000);
}

export function payrollShiftBasisLabel(
  postName: string,
  shiftDuration: DirectorPayrollShiftDuration,
  tariffRule: DirectorPayrollTariffRule,
  materialClass: DirectorPayrollMaterialClass | null,
  processedGrams: number,
): string {
  const durationLabel = shiftDuration === '12h' ? '12 ч' : '24 ч';
  const ruleLabel =
    tariffRule === 'abc_standard' ? 'ставка ABC' : (materialClass ?? RULE_LABELS[tariffRule]);
  return `${postName} · ${durationLabel} · ${ruleLabel} · переработано ${(processedGrams / 1_000).toFixed(3)} кг`;
}

function hasValidGrams(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function resolvePayrollShiftRate(
  matrix: PayrollTariffMatrixV1,
  input: PayrollShiftRateInput,
): PayrollShiftRateResolution {
  const classification = classifications(input.postName, input.startedAt, input.endedAt);
  if (classification.kind === 'unresolved') return classification;

  if (input.processedGrams === null || !hasValidGrams(input.processedGrams)) {
    return unresolved(
      ['shift_not_closed'],
      classification.machineFamily,
      classification.shiftDuration,
    );
  }

  const { machineFamily, shiftDuration } = classification;
  const materialClass = classifyPayrollMaterial(input.materialNames);
  const key = ladderKey(machineFamily, shiftDuration);
  const grams = input.processedGrams;
  const abc = !isUrpFamily(machineFamily);
  const band = abc
    ? bandFor(matrix.ladders[key] as PayrollTariffAbcBandV1[], grams)
    : bandFor(matrix.ladders[key] as PayrollTariffUrpBandV1[], grams);
  const rateKopecksPerKg = abc
    ? (band as PayrollTariffAbcBandV1).standardRateKopecksPerKg
    : materialClass === 'primary'
      ? (band as PayrollTariffUrpBandV1).primaryRateKopecksPerKg
      : (band as PayrollTariffUrpBandV1).secondaryRateKopecksPerKg;

  return {
    kind: 'resolved',
    machineFamily,
    shiftDuration,
    rateKopecksPerKg,
    tariffRule: abc ? 'abc_standard' : materialClass,
    materialClass,
    amountKopecks: calculatePayrollAmountKopecks(grams, rateKopecksPerKg),
    basisLabel: payrollShiftBasisLabel(
      input.postName,
      shiftDuration,
      abc ? 'abc_standard' : materialClass,
      materialClass,
      grams,
    ),
  };
}

function resolvedRoll(
  input: PayrollRollRateInput,
  machineFamily: DirectorPayrollMachineFamily,
  shiftDuration: DirectorPayrollShiftDuration,
  rateKopecksPerKg: number,
  tariffRule: DirectorPayrollTariffRule,
  materialClass: DirectorPayrollMaterialClass | null,
  filmClass: 'standard' | 'black_white' | null,
  specialCustomer: boolean,
): PayrollResolvedRollRate {
  const durationLabel = shiftDuration === '12h' ? '12 ч' : '24 ч';
  return {
    kind: 'resolved',
    machineFamily,
    shiftDuration,
    rateKopecksPerKg,
    tariffRule,
    basisLabel: `${MACHINE_LABELS[machineFamily]} · ${durationLabel} · ${RULE_LABELS[tariffRule]} · выработка ${(input.shiftOutputGrams / 1_000).toFixed(3)} кг`,
    materialClass,
    filmClass,
    specialCustomer,
  };
}

export function resolvePayrollRollRate(
  matrix: PayrollTariffMatrixV1,
  input: PayrollRollRateInput,
): PayrollRollRateResolution {
  const classification = classifications(input.postName, input.shiftStartedAt, input.shiftEndedAt);
  if (classification.kind === 'unresolved') return classification;

  const { machineFamily, shiftDuration } = classification;
  if (!hasValidGrams(input.shiftOutputGrams) || !hasValidGrams(input.rollGrams)) {
    return unresolved(['shift_not_closed'], machineFamily, shiftDuration);
  }

  const alabuga = matrix.specialRules.alabuga;
  if (machineFamily === alabuga.machineFamily && alabuga.enabled) {
    if (
      input.counterpartyLegalName === null ||
      normalizePayrollClassifierValue(input.counterpartyLegalName).length === 0
    ) {
      return unresolved(['counterparty_unresolved'], machineFamily, shiftDuration);
    }
    if (
      normalizePayrollClassifierValue(input.counterpartyLegalName) ===
      normalizePayrollClassifierValue(alabuga.normalizedLegalName)
    ) {
      return resolvedRoll(
        input,
        machineFamily,
        shiftDuration,
        alabuga.rateKopecksPerKg,
        'alabuga_override',
        null,
        null,
        true,
      );
    }
  }

  const thinRoll = matrix.specialRules.thinRoll;
  if (
    isUrpFamily(machineFamily) &&
    thinRoll.enabled &&
    input.rollGrams < thinRoll.maxExclusiveGrams
  ) {
    return resolvedRoll(
      input,
      machineFamily,
      shiftDuration,
      thinRoll.rateKopecksPerKg,
      'thin_roll',
      null,
      null,
      false,
    );
  }

  const key = ladderKey(machineFamily, shiftDuration);
  if (isUrpFamily(machineFamily)) {
    const materialClass = classifyPayrollMaterial(input.materialNames, input.birka);
    const band = bandFor(matrix.ladders[key] as PayrollTariffUrpBandV1[], input.shiftOutputGrams);
    const rateKopecksPerKg =
      materialClass === 'primary' ? band.primaryRateKopecksPerKg : band.secondaryRateKopecksPerKg;
    return resolvedRoll(
      input,
      machineFamily,
      shiftDuration,
      rateKopecksPerKg,
      materialClass,
      materialClass,
      null,
      false,
    );
  }

  if (input.filmType === null || normalizePayrollClassifierValue(input.filmType).length === 0) {
    return unresolved(['film_type_unresolved'], machineFamily, shiftDuration);
  }
  const filmClass = ABC_FALZ_FILM_TYPES.has(normalizePayrollClassifierValue(input.filmType))
    ? 'black_white'
    : 'standard';
  const tariffRule = filmClass === 'black_white' ? 'abc_black_white' : 'abc_standard';
  const band = bandFor(matrix.ladders[key] as PayrollTariffAbcBandV1[], input.shiftOutputGrams);
  const rateKopecksPerKg =
    filmClass === 'black_white' ? band.blackWhiteRateKopecksPerKg : band.standardRateKopecksPerKg;
  return resolvedRoll(
    input,
    machineFamily,
    shiftDuration,
    rateKopecksPerKg,
    tariffRule,
    null,
    filmClass,
    false,
  );
}
