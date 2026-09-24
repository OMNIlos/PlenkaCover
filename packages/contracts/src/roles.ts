/**
 * Roles and capability model — derived from ТЗ §4 ("Роли и visibility").
 *
 * IMPORTANT (ТЗ §11.1): this is a CANDIDATE, capability-based model for the
 * prototype. It is NOT the final backend RBAC. Real role/permission/audit
 * requirements need a separate security discovery pass and must not be copied
 * blindly from frontend visibility scopes.
 *
 * The backend MUST enforce capabilities server-side (not just hide UI), and
 * MUST NOT leak data across the role boundaries documented below.
 */

export const ROLES = [
  'commercial',
  'production_lead', // завпроизводства
  'operator',
  'warehouse',
  'finance', // бухгалтерия/финансы
  'director',
  'admin',
] as const;

export type Role = (typeof ROLES)[number];

/**
 * Capabilities are granular, business-action-scoped permissions.
 * Names are candidate vocabulary; keep them stable as they back the guard.
 */
export const CAPABILITIES = [
  // commercial
  'order:read',
  'order:create',
  'order:amend',
  'order:cancel',
  'order:update_position',
  'order:update_finance_note',
  'counterparty_template:read',
  'counterparty_template:write',
  'recipe:write',
  'material_catalog:read',
  'material_catalog:create',
  'recipe_catalog:create',
  'stock_production_template:read',
  'stock_production_template:write',
  'warehouse_cover:request',
  'warehouse_cover:confirm',
  'warehouse_cover:technical_approve',
  'warehouse_cover:override',
  'correction:create',
  'invoice:handoff',
  'commercial_notification:read',
  'business_performance:read',
  'production_cost:read',

  // production lead
  'production_order:read',
  'production_order:create',
  'production_order:handoff',
  'production_order:approve',
  'roll_dispatch:assign',
  'roll_dispatch:priority',
  'machine:assign',
  'machine_assignment:cancel',
  'machine_change:cancel',
  'penalty:create',
  'penalty:read',
  'problem:resolve',
  'production_defect:create',

  // operator
  'operator_task:read',
  'roll:accept',
  'roll:weigh',
  'roll:defect',
  'roll:qr',
  'roll:handover',
  'bigbag:weigh',
  'defect_bag:weigh',
  'defect_bag:print',
  'post_session:manage',
  'operator_problem:create',
  'operator_payroll:read_self',

  // warehouse
  'warehouse_task:read',
  'warehouse_inventory:read',
  'warehouse:scan',
  'warehouse:close',
  'warehouse_cover:propose',
  'roll:reserve',
  'reserve_roll:create',
  'pallet_list:create',
  'bigbag:create',
  'bigbag:print',
  'bigbag:move',
  'defect_bag:read',
  'defect_bag:receive',
  'defect_bag:ship',
  'raw_material:read',
  'raw_material:adjust',
  'warehouse_coverage:resolve_recheck',
  'warehouse_coverage:report_physical_exception',
  'spool_price:manage',
  'spool_stock:receive',
  'spool_stock:read',

  // finance
  'finance_order:read',
  'invoice:create',
  'payment:update',
  'payment:correct',
  'payment_operation:create',
  'installment_plan:manage',
  'source:retry',
  'warehouse_coverage:refresh',
  'warehouse_coverage:decide',
  'warehouse_coverage:request_recheck',
  'material_cost:manage',
  'production_cost:correct',

  // director
  'director:read',
  'decision:approve',
  'override:finance',
  'override:production',
  'override:warehouse',
  'payroll_tariff:manage',

  // admin
  'admin:users',
  'admin:role_templates',
  'admin:devices',
  'admin:source_health',
  'admin:onec',
  'admin:diagnostics',
  'admin:posts',
  'admin:platform_health',
  'pallet_label_layout:manage',

  // cross-cutting
  'problem:create',
  'audit:read',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Starter role → capability map (ТЗ §4 "Routine capabilities").
 * Director/admin deliberately do NOT receive routine business-action
 * capabilities of other roles — override is a separate, audited capability,
 * not silent role ownership (ТЗ §4, §5.6 OverrideAction).
 */
export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  commercial: [
    'order:read',
    'order:create',
    'order:amend',
    'order:cancel',
    'order:update_position',
    'order:update_finance_note',
    'counterparty_template:read',
    'recipe:write',
    'warehouse_cover:request',
    'warehouse_cover:confirm',
    'warehouse_cover:override',
    'correction:create',
    'invoice:handoff',
    'commercial_notification:read',
    'business_performance:read',
    'production_cost:read',
    'raw_material:read',
    'production_order:create',
    'production_order:handoff',
    'problem:create',
    'audit:read',
    'material_catalog:read',
    'recipe_catalog:create',
    'stock_production_template:read',
  ],
  production_lead: [
    // On-behalf-of-commercial intake (ТЗ §3 delegation): the backend createOrder
    // supports production_lead + onBehalfOfCommercial, so the lead needs to read
    // counterparties/orders and create the заявка it then hands off.
    'order:read',
    'order:create',
    'counterparty_template:read',
    'counterparty_template:write',
    'production_order:read',
    'warehouse_cover:technical_approve',
    'production_order:create',
    'production_order:approve',
    'roll_dispatch:assign',
    'roll_dispatch:priority',
    'machine:assign',
    'machine_assignment:cancel',
    'machine_change:cancel',
    'penalty:create',
    'penalty:read',
    'problem:resolve',
    'production_defect:create',
    'problem:create',
    'material_catalog:read',
    'recipe_catalog:create',
    'stock_production_template:read',
    'stock_production_template:write',
    'raw_material:read',
    'spool_stock:read',
  ],
  operator: [
    'operator_task:read',
    'roll:accept',
    'roll:weigh',
    'roll:defect',
    'roll:qr',
    'roll:handover',
    'bigbag:weigh',
    'defect_bag:weigh',
    'defect_bag:print',
    'post_session:manage',
    'operator_problem:create',
    'operator_payroll:read_self',
    'problem:create',
  ],
  warehouse: [
    'warehouse_task:read',
    'warehouse_inventory:read',
    'warehouse:scan',
    'warehouse:close',
    'warehouse_cover:propose',
    'roll:reserve',
    'reserve_roll:create',
    'pallet_list:create',
    'bigbag:create',
    'bigbag:print',
    'bigbag:move',
    'defect_bag:read',
    'defect_bag:receive',
    'defect_bag:ship',
    'raw_material:read',
    'raw_material:adjust',
    'warehouse_coverage:resolve_recheck',
    'warehouse_coverage:report_physical_exception',
    'spool_price:manage',
    'spool_stock:receive',
    'spool_stock:read',
    'problem:create',
    'material_catalog:read',
  ],
  finance: [
    'finance_order:read',
    'invoice:create',
    'payment:update',
    'payment:correct',
    'payment_operation:create',
    'installment_plan:manage',
    'source:retry',
    'warehouse_coverage:refresh',
    'warehouse_coverage:decide',
    'warehouse_coverage:request_recheck',
    'material_cost:manage',
    'production_cost:correct',
    'problem:create',
  ],
  director: [
    'director:read',
    'warehouse_inventory:read',
    'business_performance:read',
    'production_cost:read',
    'raw_material:read',
    'decision:approve',
    'override:finance',
    'override:production',
    'override:warehouse',
    'payroll_tariff:manage',
    'penalty:create',
    'penalty:read',
    'audit:read',
  ],
  admin: [
    'material_catalog:read',
    'material_catalog:create',
    'admin:users',
    'admin:role_templates',
    'admin:devices',
    'admin:source_health',
    'admin:onec',
    'admin:diagnostics',
    'admin:posts',
    'admin:platform_health',
    'pallet_label_layout:manage',
  ],
};

export function capabilitiesForRole(role: Role): readonly Capability[] {
  return ROLE_CAPABILITIES[role] ?? [];
}
