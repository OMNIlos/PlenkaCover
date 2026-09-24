export type OperatorWeightProjection = {
  grossKg: number;
  netKg: number;
  toleranceOk: boolean | null;
};

export type OperatorRollReweighResult = {
  rollCode: string;
  step: 'qr_print' | 'handover';
  previousWeight: OperatorWeightProjection;
  currentWeight: OperatorWeightProjection;
};

export type OperatorRollStepBackResult = {
  rollCode: string;
  previousStep: 'qr_print' | 'roll_weight';
  step: 'roll_weight' | 'spool_weight';
};
