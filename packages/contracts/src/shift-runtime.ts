export type CreateIndividualShiftInput = {
  operatorId: string;
  postId: string;
  label?: string;
  operationKey: string;
};

export type IndividualShiftCommandResult = {
  shift: {
    id: string;
    label: string;
    plannedStartAt: null;
    plannedEndAt: null;
    status: 'planned';
    operationKey: string;
  };
  assignment: {
    id: string;
    shiftId: string;
    operatorId: string;
    postId: string;
    status: 'planned';
  };
  dispatchItemIds: string[];
};

export type CancelAssignmentInput = {
  operationKey: string;
  reason: string;
};

export type CancelAssignmentResult = {
  assignmentId: string;
  shiftId: string;
  status: 'cancelled';
  releasedDispatchItemIds: string[];
  shiftClosed: boolean;
};

export type MachineChangeStatus =
  | 'requested'
  | 'awaiting_final_weight'
  | 'ready'
  | 'completed'
  | 'cancelled';

export type MachineChangeRequestInput = {
  postId: string;
  reason: string;
  operationKey: string;
};

export type FinalizeMachineChangeInput = {
  bigBagId?: string;
};

export type CancelMachineChangeInput = {
  operationKey: string;
  reason: string;
};

export type MachineChangeCancellationView = {
  changeId: string;
  status: 'cancelled';
  cancelledAt: string;
  cancellationReason: string;
};

export type MachineChangePendingBigBag = {
  id: string;
  code: string;
};

export type MachineChangeView = {
  id: string;
  assignmentId: string;
  shiftId: string;
  operatorId: string;
  fromPostId: string;
  toPostId: string;
  fromPost: {
    id: string;
    code: string;
    name: string;
  };
  toPost: {
    id: string;
    code: string;
    name: string;
  };
  needsFinalWeight: boolean;
  pendingBigBags: MachineChangePendingBigBag[];
  reason: string;
  status: MachineChangeStatus;
  operationKey: string;
  requestedAt: string;
  readyAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason?: string | null;
  cancelledById?: string | null;
  updatedAt: string;
};

export type MachineChangeFinalizationView = {
  changeId: string;
  status: MachineChangeStatus;
  remainingBigBags: MachineChangePendingBigBag[];
  completedAt: string | null;
};
