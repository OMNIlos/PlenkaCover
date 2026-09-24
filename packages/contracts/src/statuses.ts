/**
 * Status vocabularies — ТЗ §6 ("Statuses and transitions").
 *
 * ТЗ §5.1: do NOT collapse an order into a single `status`; order-level state is
 * a set of INDEPENDENT indicators (production / warehouse-cover / payment /
 * shipment). Model them separately.
 */

// --- Order indicators -------------------------------------------------------

export const PRODUCTION_INDICATORS = [
  'not_started',
  'needs_production',
  'in_production',
  'ready',
  'needs_approval',
  'defect',
] as const;
export type ProductionIndicator = (typeof PRODUCTION_INDICATORS)[number];

export const WAREHOUSE_COVER_STATUSES = [
  'not_checked',
  'partial_proposed',
  'full_proposed',
  'partial_confirmed',
  'full_confirmed',
  'needs_production',
  'recheck_requested',
  'rejected',
] as const;
export type WarehouseCoverStatus = (typeof WAREHOUSE_COVER_STATUSES)[number];

/** Statuses accepted from finance/director mutation commands. */
export const PAYMENT_UPDATE_STATUSES = [
  'unpaid',
  'partial',
  'paid',
  'overdue',
  'sync_error',
] as const;
export type PaymentUpdateStatus = (typeof PAYMENT_UPDATE_STATUSES)[number];

/** Includes the server-derived stock-order state, which is never user-settable. */
export const PAYMENT_STATUSES = [...PAYMENT_UPDATE_STATUSES, 'not_applicable'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Shipment states available to operational transitions. */
export const SHIPMENT_UPDATE_STATUSES = [
  'not_shipped',
  'partial_shipped',
  'shipped',
  'shipment_problem',
] as const;
export type ShipmentUpdateStatus = (typeof SHIPMENT_UPDATE_STATUSES)[number];

/** Includes the server-derived stock-order state, which is never user-settable. */
export const SHIPMENT_STATUSES = [...SHIPMENT_UPDATE_STATUSES, 'not_applicable'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const REQUEST_TYPES = ['client_order', 'stock_reserve'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const COMMERCIAL_STAGES = ['draft', 'incoming', 'sent_to_finance', 'in_work'] as const;
export type CommercialStage = (typeof COMMERCIAL_STAGES)[number];

export const ORDER_CANCELLATION_STATUSES = ['active', 'cancelled'] as const;
export type OrderCancellationStatus = (typeof ORDER_CANCELLATION_STATUSES)[number];

// --- Production / operator --------------------------------------------------

export const DISPATCH_ITEM_STATUSES = [
  'new',
  'assigned',
  'in_progress',
  'blocked',
  'deferred',
  'defect',
  'ready_for_warehouse',
  'done',
  'cancelled',
] as const;
export type DispatchItemStatus = (typeof DISPATCH_ITEM_STATUSES)[number];

export const OPERATOR_STEPS = [
  'assigned',
  'spool_weight',
  'roll_scale_activation',
  'roll_weight',
  'qr_print',
  'qr_check',
  'handover',
  'deferred',
  'defect',
  'warehouse',
] as const;
export type OperatorStep = (typeof OPERATOR_STEPS)[number];

export const LABEL_LIFECYCLE = [
  'not_printed',
  'print_requested',
  'submitted',
  'printed',
  'delivery_unknown',
  'applied',
  'verified',
  'reprint_requested',
  'voided',
  'damaged_lookup_required',
] as const;
export type LabelLifecycle = (typeof LABEL_LIFECYCLE)[number];

export const ROLL_WAREHOUSE_STATES = [
  'not_ready',
  'ready_for_handover',
  'sent',
  'received',
  'missing',
  'delivered',
  // брак: рулон уходит в переработку → вторсырьё (промпт склада, дизайн 2026-07-13 §8)
  'defect',
] as const;
export type RollWarehouseState = (typeof ROLL_WAREHOUSE_STATES)[number];

export const PRODUCTION_PROBLEM_TYPES = [
  'general',
  'raw_material_shortage',
  // брак рулона: оператор/склад сообщают завпроизводства (дизайн 2026-07-13 §8)
  'defect',
  // расхождение баланса сырья при сдаче смены (анти-фрод, дизайн 2026-07-13 §7)
  'shift_balance_mismatch',
  // поломка станка: оператор/завпроизводства помечают пост сломанным (дизайн 2026-07-14)
  'machine_breakdown',
] as const;
export type ProductionProblemType = (typeof PRODUCTION_PROBLEM_TYPES)[number];

export const OPERATOR_REPORTABLE_PROBLEM_TYPES = [
  'general',
  'raw_material_shortage',
] as const satisfies readonly ProductionProblemType[];
export type OperatorReportableProblemType = (typeof OPERATOR_REPORTABLE_PROBLEM_TYPES)[number];

export const OPERATOR_REPORTABLE_PROBLEM_TYPE_LABELS = {
  general: 'Общая проблема',
  raw_material_shortage: 'Нехватка сырья',
} as const satisfies Record<OperatorReportableProblemType, string>;

export const PRODUCTION_PROBLEM_STATUSES = ['open', 'resolved'] as const;
export type ProductionProblemStatus = (typeof PRODUCTION_PROBLEM_STATUSES)[number];

// --- Warehouse / source / device --------------------------------------------

export const SCAN_STATUSES = [
  'expected',
  'scanned',
  'accepted',
  'missing',
  'excess',
  'duplicate',
  'wrong',
  'damaged',
  // невероятный перевес → свободный резерв + замещающий рулон в производство
  'reserved',
] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

/** Big-bag lifecycle: склад создаёт из сырья, оператор берёт в смену, остаток < 1 кг = consumed. */
export const BIG_BAG_STATUSES = ['available', 'in_use', 'consumed'] as const;
export type BigBagStatus = (typeof BIG_BAG_STATUSES)[number];

export const BIG_BAG_REGISTRATION_STATUSES = ['pending_scan', 'registered'] as const;
export type BigBagRegistrationStatus = (typeof BIG_BAG_REGISTRATION_STATUSES)[number];

export const BIG_BAG_LOCATIONS = ['warehouse', 'production'] as const;
export type BigBagLocation = (typeof BIG_BAG_LOCATIONS)[number];

export const BIG_BAG_PRINT_STATUSES = [
  'queued',
  'submitted',
  'uncertain',
  'failed',
  'intent_recorded',
] as const;
export type BigBagPrintStatus = (typeof BIG_BAG_PRINT_STATUSES)[number];

/** One tared bag of accumulated production defects for an operator post-session. */
export const DEFECT_BAG_TYPES = ['secondary', 'aika', 'primary'] as const;
export type DefectBagType = (typeof DEFECT_BAG_TYPES)[number];

export const DEFECT_BAG_STATUSES = [
  'weighed',
  'ready_for_warehouse',
  'received',
  'shipped',
] as const;
export type DefectBagStatus = (typeof DEFECT_BAG_STATUSES)[number];

export const DEVICE_STATUSES = [
  'ready',
  'offline',
  'unstable',
  'misconfigured',
  'test_failed',
] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export const SOURCE_HEALTH_STATUSES = [
  'ready',
  'waiting',
  'error',
  'manual_review',
  'retry_requested',
] as const;
export type SourceHealth = (typeof SOURCE_HEALTH_STATUSES)[number];

// --- Finance / deferred payment terms --------------------------------------

export const PAYMENT_TERM_TYPES = ['prepay_50_postpay_50_30d', 'postpay_100_30d'] as const;
export type PaymentTermType = (typeof PAYMENT_TERM_TYPES)[number];

// Legacy arbitrary installment vocabulary. Kept only for historical contracts.

export const INSTALLMENT_PERIODICITIES = ['weekly', 'biweekly', 'monthly'] as const;
export type InstallmentPeriodicity = (typeof INSTALLMENT_PERIODICITIES)[number];

// --- Shop topology (V2 S2: machine-posts, Variant B) ------------------------

/** Operational status of a machine-post. */
// active = исправен, broken = сломан (заявлена поломка), maintenance = в ремонте,
// inactive = выведен из эксплуатации (дизайн 2026-07-14)
export const POST_STATUSES = ['active', 'inactive', 'maintenance', 'broken'] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

/** Connectivity of a post's on-site agent — populated by the gateway heartbeat (S4). */
export const POST_AGENT_STATUSES = ['online', 'offline', 'unknown'] as const;
export type PostAgentStatus = (typeof POST_AGENT_STATUSES)[number];

export const SHIFT_STATUSES = ['planned', 'open', 'closed'] as const;
export type ShiftStatus = (typeof SHIFT_STATUSES)[number];

export const OPERATOR_MACHINE_ASSIGNMENT_STATUSES = [
  'planned',
  'locked',
  'breakdown_reassigned',
  'completed',
  'cancelled',
] as const;
export type OperatorMachineAssignmentStatus = (typeof OPERATOR_MACHINE_ASSIGNMENT_STATUSES)[number];
