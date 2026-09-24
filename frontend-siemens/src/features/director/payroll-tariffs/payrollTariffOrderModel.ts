import type {
  ServerPayrollTariffAbcBand,
  ServerPayrollTariffLadderKey,
  ServerPayrollTariffMatrix,
  ServerPayrollTariffOrderReview,
  ServerPayrollTariffOrderView,
  ServerPayrollTariffUrpBand,
} from '../../../api/payrollTariffOrders';

export type PayrollTariffOrderEditorStatus = 'local' | 'draft' | 'published';

export type PayrollTariffOrderEditor = {
  orderId: string | null;
  status: PayrollTariffOrderEditorStatus;
  revision: number | null;
  name: string;
  effectiveFrom: string;
  matrix: ServerPayrollTariffMatrix;
  review: ServerPayrollTariffOrderReview | null;
};

type UrpBandField = keyof ServerPayrollTariffUrpBand;
type AbcBandField = keyof ServerPayrollTariffAbcBand;
export type PayrollTariffBandField = UrpBandField | AbcBandField;

function cloneUrpBand(band: ServerPayrollTariffUrpBand): ServerPayrollTariffUrpBand {
  return { ...band };
}

function cloneAbcBand(band: ServerPayrollTariffAbcBand): ServerPayrollTariffAbcBand {
  return { ...band };
}

export function clonePayrollTariffMatrix(
  matrix: ServerPayrollTariffMatrix,
): ServerPayrollTariffMatrix {
  return {
    schemaVersion: 1,
    ladders: {
      urp12h: matrix.ladders.urp12h.map(cloneUrpBand),
      urp24h: matrix.ladders.urp24h.map(cloneUrpBand),
      abc12h: matrix.ladders.abc12h.map(cloneAbcBand),
      abc24h: matrix.ladders.abc24h.map(cloneAbcBand),
    },
    specialRules: {
      thinRoll: { ...matrix.specialRules.thinRoll },
      alabuga: { ...matrix.specialRules.alabuga },
    },
  };
}

export function createPayrollTariffOrderCopy(
  activeOrder: ServerPayrollTariffOrderView,
  minimumPublishEffectiveFrom: string,
): PayrollTariffOrderEditor {
  return {
    orderId: null,
    status: 'local',
    revision: null,
    name: activeOrder.name,
    effectiveFrom: minimumPublishEffectiveFrom,
    matrix: clonePayrollTariffMatrix(activeOrder.matrix),
    review: null,
  };
}

export function createPayrollTariffOrderEditor(
  order: ServerPayrollTariffOrderView,
): PayrollTariffOrderEditor {
  return {
    orderId: order.id,
    status: order.status,
    revision: order.revision,
    name: order.name,
    effectiveFrom: order.effectiveFrom,
    matrix: clonePayrollTariffMatrix(order.matrix),
    review: null,
  };
}

function edited(
  editor: PayrollTariffOrderEditor,
  patch: Partial<Pick<PayrollTariffOrderEditor, 'name' | 'effectiveFrom' | 'matrix'>>,
): PayrollTariffOrderEditor {
  if (editor.status === 'published') return editor;
  return { ...editor, ...patch, review: null };
}

export function editPayrollTariffOrderIdentity(
  editor: PayrollTariffOrderEditor,
  field: 'name' | 'effectiveFrom',
  value: string,
): PayrollTariffOrderEditor {
  return edited(editor, { [field]: value });
}

function ladderBand(
  matrix: ServerPayrollTariffMatrix,
  ladder: ServerPayrollTariffLadderKey,
  index: number,
): ServerPayrollTariffUrpBand | ServerPayrollTariffAbcBand {
  const band = matrix.ladders[ladder][index];
  if (!band) throw new Error('Тарифный диапазон не найден');
  return band;
}

export function editPayrollTariffBand(
  editor: PayrollTariffOrderEditor,
  ladder: ServerPayrollTariffLadderKey,
  index: number,
  field: PayrollTariffBandField,
  value: number | null,
): PayrollTariffOrderEditor {
  if (editor.status === 'published') return editor;
  const matrix = clonePayrollTariffMatrix(editor.matrix);
  const band = ladderBand(matrix, ladder, index);
  if (!Object.hasOwn(band, field)) throw new Error('Поле тарифного диапазона не найдено');
  Object.assign(band, { [field]: value });
  return edited(editor, { matrix });
}

function insertClosedBand<T extends { maxInclusiveGrams: number | null }>(bands: T[]): void {
  const open = bands.at(-1);
  if (!open || open.maxInclusiveGrams !== null) {
    throw new Error('Последний тарифный диапазон должен быть открытым');
  }
  const previous = bands.at(-2)?.maxInclusiveGrams ?? 0;
  const threshold = previous === null ? 1_000 : previous + 1_000;
  bands.splice(bands.length - 1, 0, { ...open, maxInclusiveGrams: threshold });
}

export function addPayrollTariffClosedBand(
  editor: PayrollTariffOrderEditor,
  ladder: ServerPayrollTariffLadderKey,
): PayrollTariffOrderEditor {
  if (editor.status === 'published') return editor;
  const matrix = clonePayrollTariffMatrix(editor.matrix);
  if (ladder === 'urp12h' || ladder === 'urp24h') {
    insertClosedBand(matrix.ladders[ladder]);
  } else {
    insertClosedBand(matrix.ladders[ladder]);
  }
  return edited(editor, { matrix });
}

export function removePayrollTariffClosedBand(
  editor: PayrollTariffOrderEditor,
  ladder: ServerPayrollTariffLadderKey,
  index: number,
): PayrollTariffOrderEditor {
  if (editor.status === 'published') return editor;
  const matrix = clonePayrollTariffMatrix(editor.matrix);
  const bands = matrix.ladders[ladder];
  if (index < 0 || index >= bands.length - 1) {
    throw new Error('Открытый последний диапазон удалить нельзя');
  }
  bands.splice(index, 1);
  return edited(editor, { matrix });
}

export function setPayrollTariffOrderSpecialRule<
  Rule extends keyof ServerPayrollTariffMatrix['specialRules'],
  Field extends keyof ServerPayrollTariffMatrix['specialRules'][Rule],
>(
  editor: PayrollTariffOrderEditor,
  rule: Rule,
  field: Field,
  value: ServerPayrollTariffMatrix['specialRules'][Rule][Field],
): PayrollTariffOrderEditor {
  if (editor.status === 'published') return editor;
  const matrix = clonePayrollTariffMatrix(editor.matrix);
  const currentRule = matrix.specialRules[rule];
  Object.assign(currentRule, { [field]: value });
  return edited(editor, { matrix });
}

export function acceptSavedPayrollTariffOrder(
  order: ServerPayrollTariffOrderView,
): PayrollTariffOrderEditor {
  return createPayrollTariffOrderEditor(order);
}

export function acceptPayrollTariffOrderReview(
  editor: PayrollTariffOrderEditor,
  review: ServerPayrollTariffOrderReview,
): PayrollTariffOrderEditor {
  if (
    editor.orderId === null ||
    editor.revision === null ||
    review.orderId !== editor.orderId ||
    review.revision !== editor.revision
  ) {
    throw new Error('Проверка относится к другой редакции приказа');
  }
  return { ...editor, review };
}
