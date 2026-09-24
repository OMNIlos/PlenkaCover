/** Safe admin queue; physical confirmation never contains QR or transport payloads. */
export const PRINT_RECOVERY_KINDS = ['roll', 'defect_bag', 'big_bag', 'pallet'] as const;
export type PrintRecoveryKind = (typeof PRINT_RECOVERY_KINDS)[number];
export type BagPrintRecoveryKind = Extract<PrintRecoveryKind, 'defect_bag' | 'big_bag'>;

export interface UnresolvedPrintJob {
  kind: PrintRecoveryKind;
  printJobId: string;
  objectCode: string;
  createdAt: string;
}
