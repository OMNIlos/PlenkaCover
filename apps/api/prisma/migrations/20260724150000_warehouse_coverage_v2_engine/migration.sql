-- Automatic warehouse coverage V2: immutable evidence, calculation, decision,
-- replay journal, recheck membership, and mutable per-order state.

BEGIN;

ALTER TABLE "commercial_orders"
  ADD COLUMN "warehouseCoverageWorkflowVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "warehouse_rolls"
  ADD COLUMN "currentCoverageFactId" TEXT,
  ADD COLUMN "reservedByCoverageDecisionId" UUID;

ALTER TABLE "warehouse_acceptance_tasks"
  ADD COLUMN "coverageDecisionId" UUID;

ALTER TABLE "production_orders"
  ADD COLUMN "sourceCoverageCalculationId" TEXT,
  ADD COLUMN "sourceCoverageDecisionId" UUID,
  ADD COLUMN "sourceCoverageInputFingerprint" CHAR(64),
  ADD COLUMN "sourceCoverageGeneration" INTEGER;

ALTER TABLE "order_resolution_cases"
  ADD COLUMN "coverageScope" TEXT,
  ADD COLUMN "coverageOrigin" TEXT,
  ADD COLUMN "sourceCoverageCalculationId" TEXT,
  ADD COLUMN "sourceCoverageDecisionId" UUID,
  ADD COLUMN "sourceCoverageStateVersion" INTEGER;

CREATE TABLE "warehouse_roll_coverage_facts" (
  "id" TEXT NOT NULL,
  "rollId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "source" TEXT NOT NULL,
  "specVersion" TEXT NOT NULL,
  "specFingerprint" CHAR(64) NOT NULL,
  "spec" JSONB NOT NULL,
  "sourceOrderId" TEXT,
  "sourcePositionId" TEXT,
  "sourceDispatchItemId" TEXT,
  "sourceWeightCaptureId" TEXT,
  "actorKind" TEXT NOT NULL,
  "actorRole" "Role",
  "actorId" TEXT,
  "systemActorKey" TEXT,
  "reason" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_roll_coverage_facts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_coverage_inventory_epochs" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "epoch" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "warehouse_coverage_inventory_epochs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_coverage_states" (
  "orderId" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'calculating',
  "stateVersion" INTEGER NOT NULL DEFAULT 1,
  "generation" INTEGER NOT NULL DEFAULT 0,
  "currentCalculationId" TEXT,
  "currentDecisionId" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "warehouse_coverage_states_pkey" PRIMARY KEY ("orderId")
);

CREATE TABLE "warehouse_coverage_calculations" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "orderVersion" INTEGER NOT NULL,
  "positionVersions" JSONB NOT NULL,
  "orderFingerprint" CHAR(64) NOT NULL,
  "inventoryEpoch" BIGINT NOT NULL,
  "inventoryFingerprint" CHAR(64) NOT NULL,
  "inputFingerprint" CHAR(64) NOT NULL,
  "algorithmVersion" TEXT NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "availability" TEXT NOT NULL,
  "reasonCodes" JSONB NOT NULL,
  "requiredRollCount" INTEGER NOT NULL,
  "matchedRollCount" INTEGER NOT NULL,
  "uncertainRollCount" INTEGER NOT NULL,
  "verifiedCandidateRollIds" JSONB NOT NULL,
  "uncertainCandidateRollIds" JSONB NOT NULL,
  "systemActorKey" TEXT NOT NULL,
  "calculatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_coverage_calculations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_coverage_matches" (
  "id" TEXT NOT NULL,
  "calculationId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "positionId" TEXT NOT NULL,
  "rollId" TEXT NOT NULL,
  "coverageFactId" TEXT NOT NULL,
  "slotIndex" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_coverage_matches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_coverage_decisions" (
  "id" UUID NOT NULL,
  "orderId" TEXT NOT NULL,
  "calculationId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "inputFingerprint" CHAR(64) NOT NULL,
  "sourceInventoryEpoch" BIGINT NOT NULL,
  "committedInventoryEpoch" BIGINT,
  "expectedRollCount" INTEGER NOT NULL DEFAULT 0,
  "actorKind" TEXT NOT NULL,
  "actorRole" "Role",
  "actorId" TEXT,
  "systemActorKey" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_coverage_decisions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_coverage_commands" (
  "id" TEXT NOT NULL,
  "clientRequestId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "scopeCaseId" TEXT,
  "scopeTaskId" TEXT,
  "requestFingerprint" CHAR(64) NOT NULL,
  "actorKind" TEXT NOT NULL,
  "actorRole" "Role",
  "actorId" TEXT,
  "systemActorKey" TEXT,
  "safeResultKind" TEXT NOT NULL,
  "safeResult" JSONB NOT NULL,
  "resultKind" TEXT NOT NULL,
  "resultCalculationId" TEXT,
  "resultDecisionId" UUID,
  "resultCaseId" TEXT,
  "resultGeneration" INTEGER,
  "resultStateVersion" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_coverage_commands_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_coverage_recheck_memberships" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "rollId" TEXT NOT NULL,
  "sourceCalculationId" TEXT NOT NULL,
  "sourceDecisionId" UUID,
  "sourceCoverageFactId" TEXT,
  "sourceKind" TEXT NOT NULL,
  "reasonCodes" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_coverage_recheck_memberships_pkey" PRIMARY KEY ("id")
);

CREATE FUNCTION "warehouse_coverage_is_sorted_unique_text_array"(
  value JSONB,
  require_nonempty BOOLEAN DEFAULT false
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path FROM CURRENT
AS $$
  SELECT
    jsonb_typeof(value) = 'array'
    AND (NOT require_nonempty OR jsonb_array_length(value) > 0)
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(value) AS item
      WHERE jsonb_typeof(item) <> 'string'
        OR length(btrim(item #>> '{}')) = 0
    )
    AND (
      SELECT COALESCE(array_agg(item #>> '{}' ORDER BY ordinality), ARRAY[]::text[])
      FROM jsonb_array_elements(value) WITH ORDINALITY AS rows(item, ordinality)
    ) = (
      SELECT COALESCE(array_agg(DISTINCT item #>> '{}' ORDER BY item #>> '{}'), ARRAY[]::text[])
      FROM jsonb_array_elements(value) AS rows(item)
    );
$$;

CREATE FUNCTION "warehouse_coverage_is_reason_codes"(value JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path FROM CURRENT
AS $$
  SELECT
    "warehouse_coverage_is_sorted_unique_text_array"(value, true)
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(value) AS reason(code)
      WHERE code NOT IN (
        'full_cover_available',
        'no_compatible_rolls',
        'only_partial_cover',
        'order_spec_incomplete',
        'roll_facts_incomplete',
        'roll_ownership_unverified',
        'unsupported_policy_version',
        'inventory_changed',
        'warehouse_recheck_pending'
      )
    );
$$;

CREATE FUNCTION "warehouse_coverage_is_position_versions"(value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path FROM CURRENT
AS $$
DECLARE
  actual_ids TEXT[];
  canonical_ids TEXT[];
BEGIN
  IF jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) = 0 THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(value) AS row(item)
    WHERE jsonb_typeof(item) <> 'object'
      OR (
        SELECT array_agg(key ORDER BY key)
        FROM jsonb_object_keys(item) AS keys(key)
      ) IS DISTINCT FROM ARRAY['positionId', 'version']
      OR jsonb_typeof(item -> 'positionId') <> 'string'
      OR length(btrim(item ->> 'positionId')) = 0
      OR jsonb_typeof(item -> 'version') <> 'number'
      OR (item ->> 'version') !~ '^[1-9][0-9]*$'
  ) THEN
    RETURN false;
  END IF;
  SELECT
    array_agg(item ->> 'positionId' ORDER BY ordinality),
    array_agg(DISTINCT item ->> 'positionId' ORDER BY item ->> 'positionId')
  INTO actual_ids, canonical_ids
  FROM jsonb_array_elements(value) WITH ORDINALITY AS rows(item, ordinality);
  RETURN actual_ids IS NOT NULL
    AND array_position(actual_ids, NULL) IS NULL
    AND actual_ids IS NOT DISTINCT FROM canonical_ids;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE FUNCTION "warehouse_coverage_arrays_are_disjoint"(left_value JSONB, right_value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF jsonb_typeof(left_value) <> 'array'
    OR jsonb_typeof(right_value) <> 'array'
  THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(left_value) AS left_rows(value)
    JOIN jsonb_array_elements_text(right_value) AS right_rows(value)
      USING (value)
  ) THEN
    RAISE EXCEPTION 'coverage candidate arrays must be disjoint';
  END IF;
  RETURN true;
END;
$$;

ALTER TABLE "commercial_orders"
  ADD CONSTRAINT "commercial_orders_warehouse_coverage_workflow_ck"
  CHECK ("warehouseCoverageWorkflowVersion" IN (1, 2));

ALTER TABLE "production_orders"
  ADD CONSTRAINT "production_orders_coverage_provenance_ck"
  CHECK (
    (
      "sourceCoverageCalculationId" IS NULL
      AND "sourceCoverageDecisionId" IS NULL
      AND "sourceCoverageInputFingerprint" IS NULL
      AND "sourceCoverageGeneration" IS NULL
    )
    OR (
      "sourceCoverageCalculationId" IS NOT NULL
      AND "sourceCoverageDecisionId" IS NOT NULL
      AND "sourceCoverageInputFingerprint" IS NOT NULL
      AND "sourceCoverageGeneration" IS NOT NULL
      AND "sourceCoverageGeneration" > 0
      AND "sourceCoverageInputFingerprint" ~ '^[0-9a-f]{64}$'
    )
  );

ALTER TABLE "warehouse_acceptance_tasks"
  ADD CONSTRAINT "warehouse_acceptance_tasks_coverage_provenance_ck"
  CHECK (
    "coverageDecisionId" IS NULL
    OR (
      "mode" = 'reserve'
      AND "proposalId" IS NULL
      AND "positionId" IS NULL
    )
  );

ALTER TABLE "warehouse_rolls"
  ADD CONSTRAINT "warehouse_rolls_coverage_provenance_ck"
  CHECK (
    NOT (
      "reservedByProposalId" IS NOT NULL
      AND "reservedByCoverageDecisionId" IS NOT NULL
    )
  );

ALTER TABLE "warehouse_roll_coverage_facts"
  ADD CONSTRAINT "warehouse_coverage_facts_version_ck" CHECK ("version" > 0),
  ADD CONSTRAINT "warehouse_coverage_facts_source_ck"
    CHECK ("source" IN ('production_handover', 'warehouse_recheck', 'migration_backfill')),
  ADD CONSTRAINT "warehouse_coverage_facts_spec_version_ck"
    CHECK ("specVersion" = 'warehouse-roll-coverage/v1'),
  ADD CONSTRAINT "warehouse_coverage_facts_spec_fingerprint_ck"
    CHECK ("specFingerprint" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "warehouse_coverage_facts_actor_kind_ck"
    CHECK ("actorKind" IN ('user', 'system')),
  ADD CONSTRAINT "warehouse_coverage_facts_actor_xor_ck"
    CHECK (
      (
        "actorKind" = 'user'
        AND "actorRole" IS NOT NULL
        AND "actorId" IS NOT NULL
        AND "systemActorKey" IS NULL
      )
      OR (
        "actorKind" = 'system'
        AND "actorRole" IS NULL
        AND "actorId" IS NULL
        AND "systemActorKey" IS NOT DISTINCT FROM 'warehouse_coverage_engine'
      )
    );

ALTER TABLE "warehouse_coverage_inventory_epochs"
  ADD CONSTRAINT "warehouse_coverage_epoch_singleton_ck" CHECK ("id" = 1),
  ADD CONSTRAINT "warehouse_coverage_epoch_value_ck" CHECK ("epoch" >= 0);

ALTER TABLE "warehouse_coverage_calculations"
  ADD CONSTRAINT "warehouse_coverage_calculations_generation_ck" CHECK ("generation" > 0),
  ADD CONSTRAINT "warehouse_coverage_calculations_order_version_ck" CHECK ("orderVersion" > 0),
  ADD CONSTRAINT "warehouse_coverage_calculations_fingerprints_ck"
    CHECK (
      "orderFingerprint" ~ '^[0-9a-f]{64}$'
      AND "inventoryFingerprint" ~ '^[0-9a-f]{64}$'
      AND "inputFingerprint" ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT "warehouse_coverage_calculations_algorithm_version_ck"
    CHECK ("algorithmVersion" = 'warehouse-coverage-matching/v1'),
  ADD CONSTRAINT "warehouse_coverage_calculations_policy_version_ck"
    CHECK ("policyVersion" = 'warehouse-coverage-policy/v1'),
  ADD CONSTRAINT "warehouse_coverage_calculations_availability_ck"
    CHECK ("availability" IN ('verified_full', 'unavailable', 'unknown')),
  ADD CONSTRAINT "warehouse_coverage_calculations_counts_ck"
    CHECK (
      "requiredRollCount" >= 0
      AND "matchedRollCount" >= 0
      AND "uncertainRollCount" >= 0
      AND "matchedRollCount" <= "requiredRollCount"
      AND (
        "availability" <> 'verified_full'
        OR "matchedRollCount" = "requiredRollCount"
      )
      AND (
        (
          "availability" = 'verified_full'
          AND "reasonCodes" = '["full_cover_available"]'::jsonb
        )
        OR (
          "availability" = 'unavailable'
          AND "reasonCodes" IN (
            '["no_compatible_rolls"]'::jsonb,
            '["only_partial_cover"]'::jsonb
          )
        )
        OR (
          "availability" = 'unknown'
          AND "reasonCodes" <> '[]'::jsonb
          AND "reasonCodes" <@ '[
            "order_spec_incomplete",
            "roll_facts_incomplete",
            "roll_ownership_unverified",
            "unsupported_policy_version"
          ]'::jsonb
        )
      )
      AND "warehouse_coverage_is_position_versions"("positionVersions")
      AND "warehouse_coverage_is_reason_codes"("reasonCodes")
      AND "warehouse_coverage_is_sorted_unique_text_array"(
        "verifiedCandidateRollIds",
        false
      )
      AND "warehouse_coverage_is_sorted_unique_text_array"(
        "uncertainCandidateRollIds",
        false
      )
      AND "warehouse_coverage_arrays_are_disjoint"(
        "verifiedCandidateRollIds",
        "uncertainCandidateRollIds"
      )
    ),
  ADD CONSTRAINT "warehouse_coverage_calculations_system_actor_ck"
    CHECK ("systemActorKey" = 'warehouse_coverage_engine');

ALTER TABLE "warehouse_coverage_decisions"
  ADD CONSTRAINT "warehouse_coverage_decisions_generation_ck" CHECK ("generation" > 0),
  ADD CONSTRAINT "warehouse_coverage_decisions_kind_ck"
    CHECK ("kind" IN ('use_warehouse', 'produce_all', 'auto_produce_all')),
  ADD CONSTRAINT "warehouse_coverage_decisions_input_fingerprint_ck"
    CHECK ("inputFingerprint" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "warehouse_coverage_decisions_epochs_ck"
    CHECK (
      "sourceInventoryEpoch" >= 0
      AND ("committedInventoryEpoch" IS NULL OR "committedInventoryEpoch" >= 0)
    ),
  ADD CONSTRAINT "warehouse_coverage_decisions_expected_roll_count_ck"
    CHECK ("expectedRollCount" >= 0),
  ADD CONSTRAINT "warehouse_coverage_decisions_actor_kind_ck"
    CHECK ("actorKind" IN ('user', 'system')),
  ADD CONSTRAINT "warehouse_coverage_decisions_actor_xor_ck"
    CHECK (
      (
        "actorKind" = 'user'
        AND "actorRole" IS NOT NULL
        AND "actorId" IS NOT NULL
        AND "systemActorKey" IS NULL
      )
      OR (
        "actorKind" = 'system'
        AND "actorRole" IS NULL
        AND "actorId" IS NULL
        AND "systemActorKey" IS NOT DISTINCT FROM 'warehouse_coverage_engine'
      )
    );

ALTER TABLE "warehouse_coverage_states"
  ADD CONSTRAINT "warehouse_coverage_states_state_ck"
    CHECK (
      "state" IN (
        'calculating',
        'awaiting_finance',
        'production_required',
        'unknown',
        'recheck_requested',
        'warehouse_reserved',
        'stale'
      )
    ),
  ADD CONSTRAINT "warehouse_coverage_states_state_version_ck" CHECK ("stateVersion" > 0),
  ADD CONSTRAINT "warehouse_coverage_states_generation_ck" CHECK ("generation" >= 0);

ALTER TABLE "warehouse_coverage_matches"
  ADD CONSTRAINT "warehouse_coverage_matches_generation_ck" CHECK ("generation" > 0),
  ADD CONSTRAINT "warehouse_coverage_matches_slot_index_ck" CHECK ("slotIndex" > 0);

ALTER TABLE "warehouse_coverage_commands"
  ADD CONSTRAINT "warehouse_coverage_commands_kind_ck"
    CHECK (
      "kind" IN (
        'refresh',
        'decide',
        'request_recheck',
        'resolve_recheck',
        'cancel_reservation'
      )
    ),
  ADD CONSTRAINT "warehouse_coverage_commands_actor_kind_ck"
    CHECK ("actorKind" IN ('user', 'system')),
  ADD CONSTRAINT "warehouse_coverage_commands_actor_xor_ck"
    CHECK (
      (
        "actorKind" = 'user'
        AND "actorRole" IS NOT NULL
        AND "actorId" IS NOT NULL
        AND "systemActorKey" IS NULL
      )
      OR (
        "actorKind" = 'system'
        AND "actorRole" IS NULL
        AND "actorId" IS NULL
        AND "systemActorKey" IS NOT DISTINCT FROM 'warehouse_coverage_engine'
      )
    ),
  ADD CONSTRAINT "warehouse_coverage_commands_request_fingerprint_ck"
    CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "warehouse_coverage_commands_safe_result_kind_ck"
    CHECK ("safeResultKind" IN ('projection', 'projection_with_case')),
  ADD CONSTRAINT "warehouse_coverage_commands_result_kind_ck"
    CHECK ("resultKind" IN ('calculation', 'decision', 'recheck_case')),
  ADD CONSTRAINT "warehouse_coverage_commands_result_generation_ck"
    CHECK ("resultGeneration" IS NULL OR "resultGeneration" > 0),
  ADD CONSTRAINT "warehouse_coverage_commands_result_state_version_ck"
    CHECK ("resultStateVersion" > 0),
  ADD CONSTRAINT "warehouse_coverage_commands_result_ck"
    CHECK (
      (
        "kind" = 'refresh'
        AND "scopeCaseId" IS NULL
        AND "scopeTaskId" IS NULL
        AND "safeResultKind" = 'projection'
        AND "resultKind" = 'calculation'
        AND "resultCalculationId" IS NOT NULL
        AND "resultDecisionId" IS NULL
        AND "resultCaseId" IS NULL
      )
      OR (
        "kind" = 'decide'
        AND "scopeCaseId" IS NULL
        AND "scopeTaskId" IS NULL
        AND "safeResultKind" = 'projection'
        AND "resultKind" = 'decision'
        AND "resultCalculationId" IS NULL
        AND "resultDecisionId" IS NOT NULL
        AND "resultCaseId" IS NULL
      )
      OR (
        "kind" = 'request_recheck'
        AND "scopeCaseId" IS NULL
        AND "scopeTaskId" IS NULL
        AND "safeResultKind" = 'projection_with_case'
        AND "resultKind" = 'recheck_case'
        AND "resultCalculationId" IS NULL
        AND "resultDecisionId" IS NULL
        AND "resultCaseId" IS NOT NULL
      )
      OR (
        "kind" = 'resolve_recheck'
        AND "scopeCaseId" IS NOT NULL
        AND "scopeTaskId" IS NULL
        AND "safeResultKind" = 'projection'
        AND "resultKind" = 'calculation'
        AND "resultCalculationId" IS NOT NULL
        AND "resultDecisionId" IS NULL
        AND "resultCaseId" IS NULL
      )
      OR (
        "kind" = 'cancel_reservation'
        AND "scopeCaseId" IS NULL
        AND "scopeTaskId" IS NOT NULL
        AND "safeResultKind" = 'projection_with_case'
        AND "resultKind" = 'recheck_case'
        AND "resultCalculationId" IS NULL
        AND "resultDecisionId" IS NULL
        AND "resultCaseId" IS NOT NULL
      )
    );

ALTER TABLE "warehouse_coverage_recheck_memberships"
  ADD CONSTRAINT "warehouse_coverage_memberships_source_kind_ck"
    CHECK ("sourceKind" IN ('verified_candidate', 'uncertain_candidate', 'decision_match'));

CREATE UNIQUE INDEX "warehouse_coverage_facts_roll_version_idx"
  ON "warehouse_roll_coverage_facts" ("rollId", "version");
CREATE UNIQUE INDEX "warehouse_roll_coverage_facts_sourceDispatchItemId_key"
  ON "warehouse_roll_coverage_facts" ("sourceDispatchItemId");
CREATE UNIQUE INDEX "warehouse_coverage_calculations_order_generation_uq"
  ON "warehouse_coverage_calculations" ("orderId", "generation");
CREATE UNIQUE INDEX "warehouse_coverage_decisions_order_generation_uq"
  ON "warehouse_coverage_decisions" ("orderId", "generation");
CREATE UNIQUE INDEX "warehouse_coverage_states_currentCalculationId_key"
  ON "warehouse_coverage_states" ("currentCalculationId");
CREATE UNIQUE INDEX "warehouse_coverage_states_currentDecisionId_key"
  ON "warehouse_coverage_states" ("currentDecisionId");
CREATE INDEX "warehouse_coverage_states_state_order_idx"
  ON "warehouse_coverage_states" ("state", "orderId");
CREATE UNIQUE INDEX "warehouse_coverage_matches_calculation_roll_uq"
  ON "warehouse_coverage_matches" ("calculationId", "rollId");
CREATE UNIQUE INDEX "warehouse_coverage_matches_calculation_position_slot_uq"
  ON "warehouse_coverage_matches" ("calculationId", "positionId", "slotIndex");
CREATE UNIQUE INDEX "warehouse_coverage_commands_clientRequestId_key"
  ON "warehouse_coverage_commands" ("clientRequestId");
CREATE INDEX "warehouse_coverage_commands_order_created_idx"
  ON "warehouse_coverage_commands" ("orderId", "createdAt", "id");
CREATE UNIQUE INDEX "warehouse_coverage_recheck_memberships_case_roll_uq"
  ON "warehouse_coverage_recheck_memberships" ("caseId", "rollId");
CREATE UNIQUE INDEX "warehouse_rolls_currentCoverageFactId_key"
  ON "warehouse_rolls" ("currentCoverageFactId");
CREATE UNIQUE INDEX "warehouse_acceptance_tasks_coverageDecisionId_key"
  ON "warehouse_acceptance_tasks" ("coverageDecisionId");
CREATE UNIQUE INDEX "production_orders_coverage_order_generation_uq"
  ON "production_orders" ("commercialOrderId", "sourceCoverageGeneration");
CREATE INDEX "warehouse_rolls_coverage_candidates_idx"
  ON "warehouse_rolls" (
    "warehouseStatus",
    "ownerCounterpartyId",
    "reservedForOrderId",
    "currentCoverageFactId",
    "rollCode",
    "id"
  );

ALTER TABLE "warehouse_roll_coverage_facts"
  ADD CONSTRAINT "warehouse_roll_coverage_facts_rollId_fkey"
    FOREIGN KEY ("rollId") REFERENCES "warehouse_rolls" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_roll_coverage_facts_sourceOrderId_fkey"
    FOREIGN KEY ("sourceOrderId") REFERENCES "commercial_orders" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_roll_coverage_facts_sourcePositionId_fkey"
    FOREIGN KEY ("sourcePositionId") REFERENCES "commercial_order_positions" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_roll_coverage_facts_sourceDispatchItemId_fkey"
    FOREIGN KEY ("sourceDispatchItemId") REFERENCES "roll_dispatch_items" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_roll_coverage_facts_sourceWeightCaptureId_fkey"
    FOREIGN KEY ("sourceWeightCaptureId") REFERENCES "weight_captures" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_roll_coverage_facts_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "users" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_coverage_calculations"
  ADD CONSTRAINT "warehouse_coverage_calculations_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "commercial_orders" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_coverage_decisions"
  ADD CONSTRAINT "warehouse_coverage_decisions_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "commercial_orders" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_coverage_decisions_calculationId_fkey"
    FOREIGN KEY ("calculationId") REFERENCES "warehouse_coverage_calculations" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_coverage_decisions_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "users" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_coverage_states"
  ADD CONSTRAINT "warehouse_coverage_states_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "commercial_orders" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_coverage_states_currentCalculationId_fkey"
    FOREIGN KEY ("currentCalculationId") REFERENCES "warehouse_coverage_calculations" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_coverage_states_currentDecisionId_fkey"
    FOREIGN KEY ("currentDecisionId") REFERENCES "warehouse_coverage_decisions" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_coverage_matches"
  ADD CONSTRAINT "warehouse_coverage_matches_calculationId_fkey"
    FOREIGN KEY ("calculationId") REFERENCES "warehouse_coverage_calculations" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_coverage_matches_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "commercial_orders" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_coverage_matches_positionId_fkey"
    FOREIGN KEY ("positionId") REFERENCES "commercial_order_positions" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_coverage_matches_rollId_fkey"
    FOREIGN KEY ("rollId") REFERENCES "warehouse_rolls" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_coverage_matches_coverageFactId_fkey"
    FOREIGN KEY ("coverageFactId") REFERENCES "warehouse_roll_coverage_facts" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_coverage_commands"
  ADD CONSTRAINT "warehouse_coverage_commands_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "commercial_orders" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_coverage_commands_scopeCaseId_fkey"
    FOREIGN KEY ("scopeCaseId") REFERENCES "order_resolution_cases" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_coverage_commands_scopeTaskId_fkey"
    FOREIGN KEY ("scopeTaskId") REFERENCES "warehouse_acceptance_tasks" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_coverage_commands_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "users" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_coverage_commands_resultCalculationId_fkey"
    FOREIGN KEY ("resultCalculationId") REFERENCES "warehouse_coverage_calculations" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_coverage_commands_resultDecisionId_fkey"
    FOREIGN KEY ("resultDecisionId") REFERENCES "warehouse_coverage_decisions" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_coverage_commands_resultCaseId_fkey"
    FOREIGN KEY ("resultCaseId") REFERENCES "order_resolution_cases" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_coverage_recheck_memberships"
  ADD CONSTRAINT "warehouse_coverage_recheck_memberships_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "order_resolution_cases" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_coverage_recheck_memberships_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "commercial_orders" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_coverage_recheck_memberships_rollId_fkey"
    FOREIGN KEY ("rollId") REFERENCES "warehouse_rolls" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_coverage_recheck_memberships_sourceCalculationId_fkey"
    FOREIGN KEY ("sourceCalculationId") REFERENCES "warehouse_coverage_calculations" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_coverage_recheck_memberships_sourceDecisionId_fkey"
    FOREIGN KEY ("sourceDecisionId") REFERENCES "warehouse_coverage_decisions" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_coverage_recheck_memberships_sourceCoverageFactId_fke"
    FOREIGN KEY ("sourceCoverageFactId") REFERENCES "warehouse_roll_coverage_facts" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_rolls"
  ADD CONSTRAINT "warehouse_rolls_currentCoverageFactId_fkey"
    FOREIGN KEY ("currentCoverageFactId") REFERENCES "warehouse_roll_coverage_facts" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_rolls_reserved_by_coverage_decision_id_fkey"
    FOREIGN KEY ("reservedByCoverageDecisionId") REFERENCES "warehouse_coverage_decisions" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "warehouse_acceptance_tasks"
  ADD CONSTRAINT "warehouse_acceptance_tasks_coverage_decision_id_fkey"
    FOREIGN KEY ("coverageDecisionId") REFERENCES "warehouse_coverage_decisions" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "production_orders"
  ADD CONSTRAINT "production_orders_sourceCoverageCalculationId_fkey"
    FOREIGN KEY ("sourceCoverageCalculationId") REFERENCES "warehouse_coverage_calculations" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "production_orders_sourceCoverageDecisionId_fkey"
    FOREIGN KEY ("sourceCoverageDecisionId") REFERENCES "warehouse_coverage_decisions" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "order_resolution_cases"
  ADD CONSTRAINT "order_resolution_cases_sourceCoverageCalculationId_fkey"
    FOREIGN KEY ("sourceCoverageCalculationId") REFERENCES "warehouse_coverage_calculations" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "order_resolution_cases_sourceCoverageDecisionId_fkey"
    FOREIGN KEY ("sourceCoverageDecisionId") REFERENCES "warehouse_coverage_decisions" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "warehouse_coverage_inventory_epochs" ("id", "epoch", "updatedAt")
VALUES (1, 0, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

CREATE FUNCTION "warehouse_coverage_reject_append_only"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'warehouse coverage append-only violation on %', TG_TABLE_NAME;
END;
$$;

CREATE FUNCTION "warehouse_coverage_reject_workflow_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'warehouse coverage workflow version is immutable';
END;
$$;

CREATE FUNCTION "warehouse_coverage_protect_epoch_singleton"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'warehouse coverage epoch singleton cannot be %', TG_OP;
END;
$$;

CREATE FUNCTION "warehouse_coverage_bump_epoch_statement"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  UPDATE "warehouse_coverage_inventory_epochs"
  SET "epoch" = "epoch" + 1, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = 1;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "warehouse_coverage_bump_epoch_row"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  should_bump BOOLEAN := false;
BEGIN
  IF TG_TABLE_NAME = 'production_problems' THEN
    should_bump :=
      (TG_OP <> 'DELETE' AND NEW."rollId" IS NOT NULL AND NEW."status" = 'open')
      OR (TG_OP <> 'INSERT' AND OLD."rollId" IS NOT NULL AND OLD."status" = 'open');
  ELSIF TG_TABLE_NAME = 'defect_records' THEN
    IF
      (TG_OP <> 'DELETE' AND NEW."blocking")
      OR (TG_OP <> 'INSERT' AND OLD."blocking")
    THEN
      SELECT EXISTS (
        SELECT 1
        FROM "operator_roll_lines" line
        JOIN "roll_dispatch_items" dispatch
          ON dispatch."id" = line."rollDispatchItemId"
        JOIN "warehouse_rolls" roll
          ON roll."rollCode" = dispatch."rollCode"
        WHERE line."id" IN (
          CASE WHEN TG_OP = 'INSERT' THEN NEW."operatorRollLineId" ELSE OLD."operatorRollLineId" END,
          CASE WHEN TG_OP = 'DELETE' THEN OLD."operatorRollLineId" ELSE NEW."operatorRollLineId" END
        )
      ) INTO should_bump;
    END IF;
  END IF;

  IF should_bump THEN
    UPDATE "warehouse_coverage_inventory_epochs"
    SET "epoch" = "epoch" + 1, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = 1;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "commercial_orders_coverage_workflow_immutable"
BEFORE UPDATE OF "warehouseCoverageWorkflowVersion" ON "commercial_orders"
FOR EACH ROW EXECUTE FUNCTION "warehouse_coverage_reject_workflow_mutation"();

CREATE TRIGGER "warehouse_coverage_inventory_epochs_protect_delete"
BEFORE DELETE ON "warehouse_coverage_inventory_epochs"
FOR EACH ROW EXECUTE FUNCTION "warehouse_coverage_protect_epoch_singleton"();

CREATE TRIGGER "warehouse_coverage_inventory_epochs_protect_truncate"
BEFORE TRUNCATE ON "warehouse_coverage_inventory_epochs"
FOR EACH STATEMENT EXECUTE FUNCTION "warehouse_coverage_protect_epoch_singleton"();

CREATE TRIGGER "warehouse_rolls_coverage_epoch_insert"
BEFORE INSERT ON "warehouse_rolls"
FOR EACH STATEMENT EXECUTE FUNCTION "warehouse_coverage_bump_epoch_statement"();

CREATE TRIGGER "warehouse_rolls_coverage_epoch_update"
BEFORE UPDATE OF
  "rollCode",
  "warehouseStatus",
  "ownerCounterpartyId",
  "reservedForOrderId",
  "reservedForPositionId",
  "reservedByProposalId",
  "reservedAt",
  "currentCoverageFactId",
  "reservedByCoverageDecisionId"
ON "warehouse_rolls"
FOR EACH STATEMENT EXECUTE FUNCTION "warehouse_coverage_bump_epoch_statement"();

CREATE TRIGGER "warehouse_rolls_coverage_epoch_delete"
BEFORE DELETE ON "warehouse_rolls"
FOR EACH STATEMENT EXECUTE FUNCTION "warehouse_coverage_bump_epoch_statement"();

CREATE TRIGGER "production_problems_coverage_epoch_insert"
BEFORE INSERT ON "production_problems"
FOR EACH ROW
WHEN (NEW."rollId" IS NOT NULL AND NEW."status" = 'open')
EXECUTE FUNCTION "warehouse_coverage_bump_epoch_row"();

CREATE TRIGGER "production_problems_coverage_epoch_update"
BEFORE UPDATE ON "production_problems"
FOR EACH ROW
WHEN (
  OLD."rollId" IS DISTINCT FROM NEW."rollId"
  OR OLD."status" IS DISTINCT FROM NEW."status"
)
EXECUTE FUNCTION "warehouse_coverage_bump_epoch_row"();

CREATE TRIGGER "production_problems_coverage_epoch_delete"
BEFORE DELETE ON "production_problems"
FOR EACH ROW
WHEN (OLD."rollId" IS NOT NULL AND OLD."status" = 'open')
EXECUTE FUNCTION "warehouse_coverage_bump_epoch_row"();

CREATE TRIGGER "defect_records_coverage_epoch_insert"
BEFORE INSERT ON "defect_records"
FOR EACH ROW
WHEN (NEW."blocking")
EXECUTE FUNCTION "warehouse_coverage_bump_epoch_row"();

CREATE TRIGGER "defect_records_coverage_epoch_update"
BEFORE UPDATE ON "defect_records"
FOR EACH ROW
WHEN (
  OLD."blocking" IS DISTINCT FROM NEW."blocking"
  OR OLD."operatorRollLineId" IS DISTINCT FROM NEW."operatorRollLineId"
)
EXECUTE FUNCTION "warehouse_coverage_bump_epoch_row"();

CREATE TRIGGER "defect_records_coverage_epoch_delete"
BEFORE DELETE ON "defect_records"
FOR EACH ROW
WHEN (OLD."blocking")
EXECUTE FUNCTION "warehouse_coverage_bump_epoch_row"();

CREATE TRIGGER "warehouse_roll_coverage_facts_append_only"
BEFORE UPDATE OR DELETE ON "warehouse_roll_coverage_facts"
FOR EACH ROW EXECUTE FUNCTION "warehouse_coverage_reject_append_only"();
CREATE TRIGGER "warehouse_roll_coverage_facts_append_only_truncate"
BEFORE TRUNCATE ON "warehouse_roll_coverage_facts"
FOR EACH STATEMENT EXECUTE FUNCTION "warehouse_coverage_reject_append_only"();

CREATE TRIGGER "warehouse_coverage_calculations_append_only"
BEFORE UPDATE OR DELETE ON "warehouse_coverage_calculations"
FOR EACH ROW EXECUTE FUNCTION "warehouse_coverage_reject_append_only"();
CREATE TRIGGER "warehouse_coverage_calculations_append_only_truncate"
BEFORE TRUNCATE ON "warehouse_coverage_calculations"
FOR EACH STATEMENT EXECUTE FUNCTION "warehouse_coverage_reject_append_only"();

CREATE TRIGGER "warehouse_coverage_matches_append_only"
BEFORE UPDATE OR DELETE ON "warehouse_coverage_matches"
FOR EACH ROW EXECUTE FUNCTION "warehouse_coverage_reject_append_only"();
CREATE TRIGGER "warehouse_coverage_matches_append_only_truncate"
BEFORE TRUNCATE ON "warehouse_coverage_matches"
FOR EACH STATEMENT EXECUTE FUNCTION "warehouse_coverage_reject_append_only"();

CREATE TRIGGER "warehouse_coverage_decisions_append_only"
BEFORE UPDATE OR DELETE ON "warehouse_coverage_decisions"
FOR EACH ROW EXECUTE FUNCTION "warehouse_coverage_reject_append_only"();
CREATE TRIGGER "warehouse_coverage_decisions_append_only_truncate"
BEFORE TRUNCATE ON "warehouse_coverage_decisions"
FOR EACH STATEMENT EXECUTE FUNCTION "warehouse_coverage_reject_append_only"();

CREATE TRIGGER "warehouse_coverage_commands_append_only"
BEFORE UPDATE OR DELETE ON "warehouse_coverage_commands"
FOR EACH ROW EXECUTE FUNCTION "warehouse_coverage_reject_append_only"();
CREATE TRIGGER "warehouse_coverage_commands_append_only_truncate"
BEFORE TRUNCATE ON "warehouse_coverage_commands"
FOR EACH STATEMENT EXECUTE FUNCTION "warehouse_coverage_reject_append_only"();

CREATE TRIGGER "warehouse_coverage_recheck_memberships_append_only"
BEFORE UPDATE OR DELETE ON "warehouse_coverage_recheck_memberships"
FOR EACH ROW EXECUTE FUNCTION "warehouse_coverage_reject_append_only"();
CREATE TRIGGER "warehouse_coverage_recheck_memberships_append_only_truncate"
BEFORE TRUNCATE ON "warehouse_coverage_recheck_memberships"
FOR EACH STATEMENT EXECUTE FUNCTION "warehouse_coverage_reject_append_only"();

CREATE FUNCTION "warehouse_coverage_validate_fact"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  actual_keys TEXT[];
  expected_keys CONSTANT TEXT[] := ARRAY[
    'accountingThicknessMilliMicron',
    'actualThicknessMilliMicron',
    'actualWeightMilliKg',
    'birka',
    'filmType',
    'ingredients',
    'ownerCounterpartyId',
    'plannedWeightMilliKg',
    'policyVersion',
    'recipeDefinitionId',
    'recipeDefinitionVersionId',
    'recipeId',
    'recipeVersion',
    'recipeVersionNumber',
    'rollCode',
    'sourceOrderId',
    'sourcePositionId',
    'spoolType'
  ];
  ingredient_ids TEXT[];
  canonical_ingredient_ids TEXT[];
  ingredient_total BIGINT;
  roll_code TEXT;
  actor_matches BOOLEAN;
BEGIN
  IF jsonb_typeof(NEW."spec") <> 'object' THEN
    RAISE EXCEPTION 'coverage spec must be a canonical object';
  END IF;
  SELECT array_agg(key ORDER BY key)
  INTO actual_keys
  FROM jsonb_object_keys(NEW."spec") AS keys(key);
  IF actual_keys IS DISTINCT FROM expected_keys THEN
    RAISE EXCEPTION 'coverage spec canonical keys mismatch';
  END IF;

  IF
    jsonb_typeof(NEW."spec" -> 'rollCode') <> 'string'
    OR jsonb_typeof(NEW."spec" -> 'filmType') <> 'string'
    OR jsonb_typeof(NEW."spec" -> 'birka') <> 'string'
    OR jsonb_typeof(NEW."spec" -> 'spoolType') <> 'string'
    OR jsonb_typeof(NEW."spec" -> 'policyVersion') <> 'string'
    OR NEW."spec" ->> 'policyVersion'
      IS DISTINCT FROM 'warehouse-coverage-policy/v1'
    OR jsonb_typeof(NEW."spec" -> 'actualThicknessMilliMicron') <> 'number'
    OR jsonb_typeof(NEW."spec" -> 'accountingThicknessMilliMicron') <> 'number'
    OR jsonb_typeof(NEW."spec" -> 'actualWeightMilliKg') <> 'number'
    OR jsonb_typeof(NEW."spec" -> 'plannedWeightMilliKg') <> 'number'
    OR (NEW."spec" ->> 'actualThicknessMilliMicron') !~ '^[0-9]+$'
    OR (NEW."spec" ->> 'accountingThicknessMilliMicron') !~ '^[0-9]+$'
    OR (NEW."spec" ->> 'actualWeightMilliKg') !~ '^[0-9]+$'
    OR (NEW."spec" ->> 'plannedWeightMilliKg') !~ '^[0-9]+$'
    OR (NEW."spec" ->> 'actualThicknessMilliMicron')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR (NEW."spec" ->> 'accountingThicknessMilliMicron')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR (NEW."spec" ->> 'actualWeightMilliKg')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR (NEW."spec" ->> 'plannedWeightMilliKg')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR length(btrim(NEW."spec" ->> 'rollCode')) = 0
    OR length(btrim(NEW."spec" ->> 'filmType')) = 0
    OR length(btrim(NEW."spec" ->> 'birka')) = 0
    OR length(btrim(NEW."spec" ->> 'spoolType')) = 0
  THEN
    RAISE EXCEPTION 'coverage spec canonical scalar types mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('sourceOrderId'),
        ('sourcePositionId'),
        ('ownerCounterpartyId'),
        ('recipeId'),
        ('recipeVersion'),
        ('recipeDefinitionId'),
        ('recipeDefinitionVersionId')
    ) AS nullable_string(key)
    WHERE jsonb_typeof(NEW."spec" -> key) NOT IN ('string', 'null')
      OR (
        jsonb_typeof(NEW."spec" -> key) = 'string'
        AND length(btrim(NEW."spec" ->> key)) = 0
      )
  ) OR jsonb_typeof(NEW."spec" -> 'recipeVersionNumber') NOT IN ('number', 'null')
    OR (
      jsonb_typeof(NEW."spec" -> 'recipeVersionNumber') = 'number'
      AND (
        (NEW."spec" ->> 'recipeVersionNumber') !~ '^[1-9][0-9]*$'
        OR (NEW."spec" ->> 'recipeVersionNumber')::numeric > 9007199254740991
      )
    )
  THEN
    RAISE EXCEPTION 'coverage spec nullable provenance types mismatch';
  END IF;

  IF jsonb_typeof(NEW."spec" -> 'ingredients') <> 'array'
    OR jsonb_array_length(NEW."spec" -> 'ingredients') = 0
  THEN
    RAISE EXCEPTION 'coverage spec ingredients must be nonempty';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW."spec" -> 'ingredients') AS rows(item)
    WHERE jsonb_typeof(item) <> 'object'
      OR (
        SELECT array_agg(key ORDER BY key)
        FROM jsonb_object_keys(item) AS keys(key)
      ) IS DISTINCT FROM ARRAY['rawMaterialDefinitionId', 'shareBasisPoints']
      OR jsonb_typeof(item -> 'rawMaterialDefinitionId') <> 'string'
      OR length(btrim(item ->> 'rawMaterialDefinitionId')) = 0
      OR jsonb_typeof(item -> 'shareBasisPoints') <> 'number'
      OR (item ->> 'shareBasisPoints') !~ '^[1-9][0-9]*$'
  ) THEN
    RAISE EXCEPTION 'coverage spec ingredient shape is invalid';
  END IF;
  SELECT
    array_agg(item ->> 'rawMaterialDefinitionId' ORDER BY ordinality),
    array_agg(
      DISTINCT item ->> 'rawMaterialDefinitionId'
      ORDER BY item ->> 'rawMaterialDefinitionId'
    ),
    sum((item ->> 'shareBasisPoints')::bigint)
  INTO ingredient_ids, canonical_ingredient_ids, ingredient_total
  FROM jsonb_array_elements(NEW."spec" -> 'ingredients')
    WITH ORDINALITY AS rows(item, ordinality);
  IF ingredient_ids IS DISTINCT FROM canonical_ingredient_ids
    OR ingredient_total IS DISTINCT FROM 10000
  THEN
    RAISE EXCEPTION 'coverage spec ingredients must be sorted, unique and total 10000';
  END IF;

  SELECT "rollCode" INTO roll_code
  FROM "warehouse_rolls"
  WHERE "id" = NEW."rollId";
  IF roll_code IS NULL OR NEW."spec" ->> 'rollCode' IS DISTINCT FROM roll_code THEN
    RAISE EXCEPTION 'coverage spec rollCode does not match roll';
  END IF;
  IF NEW."spec" ->> 'sourceOrderId' IS DISTINCT FROM NEW."sourceOrderId"
    OR NEW."spec" ->> 'sourcePositionId' IS DISTINCT FROM NEW."sourcePositionId"
  THEN
    RAISE EXCEPTION 'coverage spec sourceOrder/sourcePosition provenance mismatch';
  END IF;

  IF NEW."actorKind" = 'user' THEN
    SELECT EXISTS (
      SELECT 1 FROM "users"
      WHERE "id" = NEW."actorId" AND "role" = NEW."actorRole"
    ) INTO actor_matches;
    IF NOT actor_matches THEN
      RAISE EXCEPTION 'coverage fact actor role mismatch';
    END IF;
  END IF;

  IF (NEW."sourceOrderId" IS NULL) IS DISTINCT FROM (NEW."sourcePositionId" IS NULL) THEN
    RAISE EXCEPTION 'coverage fact source order and position must be paired';
  END IF;
  IF NEW."sourcePositionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "commercial_order_positions"
    WHERE "id" = NEW."sourcePositionId"
      AND "orderId" = NEW."sourceOrderId"
  ) THEN
    RAISE EXCEPTION 'coverage fact sourcePosition does not belong to sourceOrder';
  END IF;

  IF NEW."source" = 'migration_backfill' THEN
    IF NEW."actorKind" <> 'system' OR NEW."reason" IS NOT NULL THEN
      RAISE EXCEPTION 'migration_backfill source requires system actor';
    END IF;
  ELSIF NEW."source" = 'warehouse_recheck' THEN
    IF NEW."actorKind" <> 'user'
      OR NEW."actorRole" <> 'warehouse'::"Role"
      OR NEW."reason" IS NULL
      OR NEW."reason" <> btrim(NEW."reason")
      OR char_length(NEW."reason") NOT BETWEEN 3 AND 500
    THEN
      RAISE EXCEPTION 'warehouse_recheck source requires warehouse actor and reason';
    END IF;
  ELSIF NEW."source" = 'production_handover' THEN
    IF NEW."actorKind" <> 'user'
      OR NEW."actorRole" <> 'operator'::"Role"
      OR NEW."sourceOrderId" IS NULL
      OR NEW."sourcePositionId" IS NULL
      OR NEW."sourceDispatchItemId" IS NULL
      OR NEW."sourceWeightCaptureId" IS NULL
      OR NEW."reason" IS NOT NULL
    THEN
      RAISE EXCEPTION 'production_handover source evidence is incomplete';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM "roll_dispatch_items" dispatch
      JOIN "production_orders" production
        ON production."id" = dispatch."productionOrderId"
      JOIN "operator_roll_lines" line
        ON line."rollDispatchItemId" = dispatch."id"
      JOIN "weight_captures" capture
        ON capture."operatorRollLineId" = line."id"
      WHERE dispatch."id" = NEW."sourceDispatchItemId"
        AND dispatch."rollCode" = roll_code
        AND dispatch."orderLineId" = NEW."sourcePositionId"
        AND production."commercialOrderId" = NEW."sourceOrderId"
        AND capture."id" = NEW."sourceWeightCaptureId"
        AND capture."kind" = 'roll'
        AND capture."stable"
        AND capture."netKg" IS NOT NULL
        AND round(capture."netKg"::numeric * 1000)::bigint =
          (NEW."spec" ->> 'actualWeightMilliKg')::bigint
    ) THEN
      RAISE EXCEPTION 'production_handover dispatch or stable weight capture mismatch';
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'coverage spec canonical numeric value is invalid';
END;
$$;

CREATE TRIGGER "warehouse_roll_coverage_facts_validate_insert"
BEFORE INSERT ON "warehouse_roll_coverage_facts"
FOR EACH ROW EXECUTE FUNCTION "warehouse_coverage_validate_fact"();

CREATE FUNCTION "warehouse_coverage_validate_match"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "warehouse_coverage_states"
    WHERE "currentCalculationId" = NEW."calculationId"
  ) OR EXISTS (
    SELECT 1
    FROM "warehouse_coverage_decisions"
    WHERE "calculationId" = NEW."calculationId"
  ) OR EXISTS (
    SELECT 1
    FROM "order_resolution_cases"
    WHERE "sourceCoverageCalculationId" = NEW."calculationId"
  ) OR EXISTS (
    SELECT 1
    FROM "production_orders"
    WHERE "sourceCoverageCalculationId" = NEW."calculationId"
  ) OR EXISTS (
    SELECT 1
    FROM "warehouse_coverage_commands" command
    LEFT JOIN "warehouse_coverage_decisions" decision
      ON decision."id" = command."resultDecisionId"
    LEFT JOIN "order_resolution_cases" result_case
      ON result_case."id" = command."resultCaseId"
    LEFT JOIN "order_resolution_cases" scope_case
      ON scope_case."id" = command."scopeCaseId"
    WHERE command."resultCalculationId" = NEW."calculationId"
      OR decision."calculationId" = NEW."calculationId"
      OR result_case."sourceCoverageCalculationId" = NEW."calculationId"
      OR scope_case."sourceCoverageCalculationId" = NEW."calculationId"
  ) THEN
    RAISE EXCEPTION 'coverage match set is frozen after calculation publication';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "warehouse_coverage_calculations" calculation
    JOIN "commercial_order_positions" position
      ON position."id" = NEW."positionId"
     AND position."orderId" = NEW."orderId"
    JOIN "warehouse_roll_coverage_facts" fact
      ON fact."id" = NEW."coverageFactId"
     AND fact."rollId" = NEW."rollId"
    WHERE calculation."id" = NEW."calculationId"
      AND calculation."orderId" = NEW."orderId"
      AND calculation."generation" = NEW."generation"
      AND calculation."availability" = 'verified_full'
      AND calculation."positionVersions" @>
        jsonb_build_array(
          jsonb_build_object(
            'positionId', NEW."positionId",
            'version', position."version"
          )
        )
      AND calculation."verifiedCandidateRollIds" ? NEW."rollId"
  ) THEN
    RAISE EXCEPTION 'coverage match calculation/order/position/fact/roll mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "warehouse_coverage_matches_validate_insert"
BEFORE INSERT ON "warehouse_coverage_matches"
FOR EACH ROW EXECUTE FUNCTION "warehouse_coverage_validate_match"();

CREATE FUNCTION "warehouse_coverage_validate_decision"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  calculation "warehouse_coverage_calculations"%ROWTYPE;
  actor_matches BOOLEAN;
  match_count INTEGER;
BEGIN
  SELECT * INTO calculation
  FROM "warehouse_coverage_calculations"
  WHERE "id" = NEW."calculationId";
  IF NOT FOUND
    OR calculation."orderId" IS DISTINCT FROM NEW."orderId"
    OR calculation."generation" IS DISTINCT FROM NEW."generation"
    OR calculation."inputFingerprint" IS DISTINCT FROM NEW."inputFingerprint"
    OR calculation."inventoryEpoch" IS DISTINCT FROM NEW."sourceInventoryEpoch"
  THEN
    RAISE EXCEPTION 'coverage decision calculation/order/generation/fingerprint/epoch mismatch';
  END IF;

  IF NEW."actorKind" = 'user' THEN
    SELECT EXISTS (
      SELECT 1 FROM "users"
      WHERE "id" = NEW."actorId" AND "role" = NEW."actorRole"
    ) INTO actor_matches;
    IF NOT actor_matches THEN
      RAISE EXCEPTION 'coverage decision actor role mismatch';
    END IF;
  END IF;

  SELECT count(*)::integer INTO match_count
  FROM "warehouse_coverage_matches"
  WHERE "calculationId" = NEW."calculationId";

  IF NEW."kind" = 'use_warehouse' THEN
    IF NEW."actorKind" <> 'user'
      OR NEW."actorRole" <> 'finance'::"Role"
      OR calculation."availability" <> 'verified_full'
      OR NEW."committedInventoryEpoch" IS NULL
      OR NEW."committedInventoryEpoch" <> NEW."sourceInventoryEpoch" + 1
      OR NEW."committedInventoryEpoch" <> (
        SELECT "epoch"
        FROM "warehouse_coverage_inventory_epochs"
        WHERE "id" = 1
      )
      OR NEW."expectedRollCount" <= 0
      OR NEW."expectedRollCount" <> calculation."requiredRollCount"
      OR NEW."expectedRollCount" <> match_count
    THEN
      RAISE EXCEPTION 'use_warehouse decision expectedRollCount or epoch is invalid';
    END IF;
  ELSIF NEW."kind" = 'produce_all' THEN
    IF NEW."actorKind" <> 'user'
      OR NEW."actorRole" <> 'finance'::"Role"
      OR calculation."availability" <> 'verified_full'
      OR calculation."inventoryEpoch" <> (
        SELECT "epoch"
        FROM "warehouse_coverage_inventory_epochs"
        WHERE "id" = 1
      )
      OR match_count <> calculation."matchedRollCount"
      OR NEW."committedInventoryEpoch" IS NOT NULL
      OR NEW."expectedRollCount" <> 0
    THEN
      RAISE EXCEPTION 'produce_all decision requires fresh verified full calculation';
    END IF;
  ELSIF NEW."kind" = 'auto_produce_all' THEN
    IF NEW."actorKind" <> 'system'
      OR NEW."systemActorKey" IS DISTINCT FROM 'warehouse_coverage_engine'
      OR NEW."committedInventoryEpoch" IS NOT NULL
      OR NEW."expectedRollCount" <> 0
      OR calculation."availability" <> 'unavailable'
    THEN
      RAISE EXCEPTION 'auto_produce_all decision actor or reserve count is invalid';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "warehouse_coverage_decisions_validate_insert"
BEFORE INSERT ON "warehouse_coverage_decisions"
FOR EACH ROW EXECUTE FUNCTION "warehouse_coverage_validate_decision"();

CREATE FUNCTION "warehouse_coverage_validate_case"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  expected_scope TEXT;
  expected_open_scope TEXT;
  calculation_order TEXT;
  decision_order TEXT;
  decision_calculation TEXT;
BEGIN
  IF NEW."coverageScope" IS NULL
    AND NEW."coverageOrigin" IS NULL
    AND NEW."sourceCoverageCalculationId" IS NULL
    AND NEW."sourceCoverageDecisionId" IS NULL
    AND NEW."sourceCoverageStateVersion" IS NULL
  THEN
    IF TG_OP = 'UPDATE' AND OLD."coverageScope" IS NOT NULL THEN
      RAISE EXCEPTION 'coverage case lifecycle/provenance/version is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."coverageScope" IS NULL
    OR NEW."coverageOrigin" IS NULL
    OR NEW."sourceCoverageCalculationId" IS NULL
    OR NEW."sourceCoverageStateVersion" IS NULL
    OR NEW."sourceCoverageStateVersion" <= 0
  THEN
    RAISE EXCEPTION 'coverage case has partial legacy provenance';
  END IF;

  expected_scope := 'warehouse_coverage_v2:' || NEW."orderId";
  expected_open_scope := expected_scope || ':' || NEW."coverageOrigin";
  SELECT "orderId" INTO calculation_order
  FROM "warehouse_coverage_calculations"
  WHERE "id" = NEW."sourceCoverageCalculationId";
  IF calculation_order IS DISTINCT FROM NEW."orderId"
    OR NEW."coverageScope" IS DISTINCT FROM expected_scope
    OR NEW."ownerRole" <> 'warehouse'::"Role"
  THEN
    RAISE EXCEPTION 'coverage case scope/owner/calculation mismatch';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1
    FROM "warehouse_coverage_states"
    WHERE "orderId" = NEW."orderId"
      AND "currentCalculationId" = NEW."sourceCoverageCalculationId"
      AND "stateVersion" = NEW."sourceCoverageStateVersion"
  ) THEN
    RAISE EXCEPTION 'coverage case source state version/calculation mismatch';
  END IF;

  IF NEW."coverageOrigin" = 'finance_request' THEN
    IF NEW."type" <> 'warehouse_coverage_recheck'
      OR NEW."createdByRole" <> 'finance'::"Role"
      OR NEW."sourceCoverageDecisionId" IS NOT NULL
    THEN
      RAISE EXCEPTION 'finance coverage case origin tuple is invalid';
    END IF;
  ELSIF NEW."coverageOrigin" = 'decision_linked_physical_exception' THEN
    SELECT "orderId", "calculationId"
    INTO decision_order, decision_calculation
    FROM "warehouse_coverage_decisions"
    WHERE "id" = NEW."sourceCoverageDecisionId";
    IF NEW."type" <> 'warehouse_coverage_physical_exception'
      OR NEW."createdByRole" <> 'warehouse'::"Role"
      OR NEW."sourceCoverageDecisionId" IS NULL
      OR decision_order IS DISTINCT FROM NEW."orderId"
      OR decision_calculation IS DISTINCT FROM NEW."sourceCoverageCalculationId"
      OR NOT EXISTS (
        SELECT 1
        FROM "warehouse_coverage_decisions"
        WHERE "id" = NEW."sourceCoverageDecisionId"
          AND "kind" = 'use_warehouse'
      )
    THEN
      RAISE EXCEPTION 'physical coverage case decision tuple is invalid';
    END IF;
  ELSE
    RAISE EXCEPTION 'coverage case origin is invalid';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."coverageScope" IS NULL
      OR NEW."version" <> OLD."version" + 1
      OR NEW."coverageScope" IS DISTINCT FROM OLD."coverageScope"
      OR NEW."coverageOrigin" IS DISTINCT FROM OLD."coverageOrigin"
      OR NEW."sourceCoverageCalculationId" IS DISTINCT FROM OLD."sourceCoverageCalculationId"
      OR NEW."sourceCoverageDecisionId" IS DISTINCT FROM OLD."sourceCoverageDecisionId"
      OR NEW."sourceCoverageStateVersion" IS DISTINCT FROM OLD."sourceCoverageStateVersion"
      OR (OLD."status" <> 'open' AND NEW."status" = 'open')
    THEN
      RAISE EXCEPTION 'coverage case lifecycle/provenance/version is immutable';
    END IF;
  END IF;

  IF NEW."status" = 'open' THEN
    IF NEW."openScopeKey" IS DISTINCT FROM expected_open_scope THEN
      RAISE EXCEPTION 'coverage case openScopeKey is invalid';
    END IF;
  ELSE
    IF NEW."openScopeKey" IS NOT NULL THEN
      RAISE EXCEPTION 'resolved coverage case must clear openScopeKey';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "order_resolution_cases_coverage_validate_write"
BEFORE INSERT OR UPDATE ON "order_resolution_cases"
FOR EACH ROW EXECUTE FUNCTION "warehouse_coverage_validate_case"();

CREATE FUNCTION "warehouse_coverage_validate_production_order"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  workflow_version INTEGER;
BEGIN
  SELECT "warehouseCoverageWorkflowVersion"
  INTO workflow_version
  FROM "commercial_orders"
  WHERE "id" = NEW."commercialOrderId";

  IF workflow_version = 1 THEN
    IF NEW."sourceCoverageCalculationId" IS NOT NULL
      OR NEW."sourceCoverageDecisionId" IS NOT NULL
      OR NEW."sourceCoverageInputFingerprint" IS NOT NULL
      OR NEW."sourceCoverageGeneration" IS NOT NULL
    THEN
      RAISE EXCEPTION 'V1 production order cannot carry coverage provenance';
    END IF;
  ELSIF workflow_version = 2 THEN
    IF NEW."sourceCoverageCalculationId" IS NULL
      OR NEW."sourceCoverageDecisionId" IS NULL
      OR NEW."sourceCoverageInputFingerprint" IS NULL
      OR NEW."sourceCoverageGeneration" IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM "warehouse_coverage_calculations" calculation
        JOIN "warehouse_coverage_decisions" decision
          ON decision."id" = NEW."sourceCoverageDecisionId"
        WHERE calculation."id" = NEW."sourceCoverageCalculationId"
          AND calculation."orderId" = NEW."commercialOrderId"
          AND calculation."generation" = NEW."sourceCoverageGeneration"
          AND calculation."inputFingerprint" = NEW."sourceCoverageInputFingerprint"
          AND decision."orderId" = NEW."commercialOrderId"
          AND decision."calculationId" = calculation."id"
          AND decision."generation" = calculation."generation"
          AND decision."inputFingerprint" = calculation."inputFingerprint"
          AND decision."kind" IN ('produce_all', 'auto_produce_all')
      )
    THEN
      RAISE EXCEPTION 'V2 production order coverage provenance mismatch';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE'
    AND (
      NEW."sourceCoverageCalculationId" IS DISTINCT FROM OLD."sourceCoverageCalculationId"
      OR NEW."sourceCoverageDecisionId" IS DISTINCT FROM OLD."sourceCoverageDecisionId"
      OR NEW."sourceCoverageInputFingerprint" IS DISTINCT FROM OLD."sourceCoverageInputFingerprint"
      OR NEW."sourceCoverageGeneration" IS DISTINCT FROM OLD."sourceCoverageGeneration"
    )
  THEN
    RAISE EXCEPTION 'production order coverage provenance is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "production_orders_coverage_validate_write"
BEFORE INSERT OR UPDATE ON "production_orders"
FOR EACH ROW EXECUTE FUNCTION "warehouse_coverage_validate_production_order"();

CREATE FUNCTION "warehouse_coverage_validate_roll"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  workflow_version INTEGER;
BEGIN
  IF NEW."currentCoverageFactId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "warehouse_roll_coverage_facts"
    WHERE "id" = NEW."currentCoverageFactId"
      AND "rollId" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'current coverage fact must belong to the same roll';
  END IF;

  IF NEW."reservedForOrderId" IS NOT NULL THEN
    SELECT "warehouseCoverageWorkflowVersion"
    INTO workflow_version
    FROM "commercial_orders"
    WHERE "id" = NEW."reservedForOrderId";
  END IF;
  IF workflow_version = 2 AND NEW."reservedByCoverageDecisionId" IS NULL THEN
    RAISE EXCEPTION 'V2 roll reservation requires coverage decision provenance';
  END IF;

  IF NEW."reservedByCoverageDecisionId" IS NOT NULL THEN
    IF NEW."reservedForOrderId" IS NULL
      OR NEW."reservedAt" IS NULL
      OR NEW."reservedByProposalId" IS NOT NULL
      OR NEW."currentCoverageFactId" IS NULL
    THEN
      RAISE EXCEPTION 'coverage decision roll reservation provenance mismatch';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM "warehouse_coverage_decisions"
      WHERE "id" = NEW."reservedByCoverageDecisionId"
    ) AND NOT EXISTS (
        SELECT 1
        FROM "warehouse_coverage_decisions" decision
        JOIN "warehouse_coverage_matches" match
          ON match."calculationId" = decision."calculationId"
         AND match."rollId" = NEW."id"
        WHERE decision."id" = NEW."reservedByCoverageDecisionId"
          AND decision."kind" = 'use_warehouse'
          AND decision."orderId" = NEW."reservedForOrderId"
          AND match."coverageFactId" = NEW."currentCoverageFactId"
          AND (
            NEW."reservedForPositionId" IS NULL
            OR NEW."reservedForPositionId" = match."positionId"
          )
      )
    THEN
      RAISE EXCEPTION 'coverage decision roll reservation provenance mismatch';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD."reservedByCoverageDecisionId" IS NOT NULL
    AND NEW."reservedByCoverageDecisionId" IS DISTINCT FROM OLD."reservedByCoverageDecisionId"
  THEN
    IF NEW."reservedByCoverageDecisionId" IS NOT NULL
      OR NEW."reservedForOrderId" IS NOT NULL
      OR NEW."reservedForPositionId" IS NOT NULL
      OR NEW."reservedAt" IS NOT NULL
      OR NOT EXISTS (
        SELECT 1
        FROM "order_resolution_cases" coverage_case
        JOIN "warehouse_coverage_recheck_memberships" membership
          ON membership."caseId" = coverage_case."id"
         AND membership."rollId" = NEW."id"
        WHERE coverage_case."coverageOrigin" = 'decision_linked_physical_exception'
          AND coverage_case."status" = 'open'
          AND coverage_case."sourceCoverageDecisionId" =
            OLD."reservedByCoverageDecisionId"
          AND membership."sourceDecisionId" = OLD."reservedByCoverageDecisionId"
          AND membership."sourceKind" = 'decision_match'
      )
    THEN
      RAISE EXCEPTION 'physical recovery must clear an exact decision reservation set';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "warehouse_rolls_coverage_validate_write"
BEFORE INSERT OR UPDATE ON "warehouse_rolls"
FOR EACH ROW EXECUTE FUNCTION "warehouse_coverage_validate_roll"();

CREATE FUNCTION "warehouse_coverage_validate_membership"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  coverage_case "order_resolution_cases"%ROWTYPE;
  calculation "warehouse_coverage_calculations"%ROWTYPE;
BEGIN
  IF NOT "warehouse_coverage_is_reason_codes"(NEW."reasonCodes") THEN
    RAISE EXCEPTION 'coverage membership reasonCodes are not canonical';
  END IF;
  SELECT * INTO coverage_case
  FROM "order_resolution_cases"
  WHERE "id" = NEW."caseId";
  SELECT * INTO calculation
  FROM "warehouse_coverage_calculations"
  WHERE "id" = NEW."sourceCalculationId";
  IF NOT FOUND
    OR coverage_case."orderId" IS DISTINCT FROM NEW."orderId"
    OR coverage_case."sourceCoverageCalculationId" IS DISTINCT FROM NEW."sourceCalculationId"
    OR coverage_case."status" IS DISTINCT FROM 'open'
    OR calculation."orderId" IS DISTINCT FROM NEW."orderId"
  THEN
    RAISE EXCEPTION 'coverage membership case/order/calculation mismatch';
  END IF;
  IF NEW."sourceCoverageFactId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "warehouse_roll_coverage_facts"
    WHERE "id" = NEW."sourceCoverageFactId"
      AND "rollId" = NEW."rollId"
  ) THEN
    RAISE EXCEPTION 'coverage membership fact must belong to roll';
  END IF;

  IF coverage_case."coverageOrigin" = 'finance_request' THEN
    IF NEW."sourceDecisionId" IS NOT NULL
      OR NEW."sourceKind" NOT IN ('verified_candidate', 'uncertain_candidate')
      OR (
        NEW."sourceKind" = 'verified_candidate'
        AND NOT calculation."verifiedCandidateRollIds" ? NEW."rollId"
      )
      OR (
        NEW."sourceKind" = 'uncertain_candidate'
        AND NOT calculation."uncertainCandidateRollIds" ? NEW."rollId"
      )
    THEN
      RAISE EXCEPTION 'finance coverage membership candidate/sourceKind mismatch';
    END IF;
  ELSIF coverage_case."coverageOrigin" = 'decision_linked_physical_exception' THEN
    IF NEW."sourceKind" <> 'decision_match'
      OR NEW."sourceDecisionId" IS DISTINCT FROM coverage_case."sourceCoverageDecisionId"
      OR NOT EXISTS (
        SELECT 1
        FROM "warehouse_coverage_decisions" decision
        JOIN "warehouse_coverage_matches" match
          ON match."calculationId" = decision."calculationId"
        WHERE decision."id" = NEW."sourceDecisionId"
          AND decision."orderId" = NEW."orderId"
          AND match."rollId" = NEW."rollId"
          AND (
            NEW."sourceCoverageFactId" IS NULL
            OR match."coverageFactId" = NEW."sourceCoverageFactId"
          )
      )
    THEN
      RAISE EXCEPTION 'decision_match coverage membership is outside source decision';
    END IF;
  ELSE
    RAISE EXCEPTION 'coverage membership requires a coverage case';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "warehouse_coverage_recheck_memberships_validate_insert"
BEFORE INSERT ON "warehouse_coverage_recheck_memberships"
FOR EACH ROW EXECUTE FUNCTION "warehouse_coverage_validate_membership"();

CREATE FUNCTION "warehouse_coverage_validate_state"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  calculation "warehouse_coverage_calculations"%ROWTYPE;
  decision "warehouse_coverage_decisions"%ROWTYPE;
  old_decision "warehouse_coverage_decisions"%ROWTYPE;
  physical_recovery_ok BOOLEAN;
  persisted_match_count INTEGER;
BEGIN
  IF NEW."currentCalculationId" IS NULL THEN
    IF NEW."generation" <> 0
      OR NEW."state" <> 'calculating'
      OR NEW."currentDecisionId" IS NOT NULL
    THEN
      RAISE EXCEPTION 'coverage state without calculation must be generation zero';
    END IF;
  ELSE
    SELECT * INTO calculation
    FROM "warehouse_coverage_calculations"
    WHERE "id" = NEW."currentCalculationId";
    IF NOT FOUND
      OR calculation."orderId" IS DISTINCT FROM NEW."orderId"
      OR calculation."generation" IS DISTINCT FROM NEW."generation"
    THEN
      RAISE EXCEPTION 'coverage state calculation order/generation mismatch';
    END IF;
    SELECT count(*)::integer INTO persisted_match_count
    FROM "warehouse_coverage_matches"
    WHERE "calculationId" = calculation."id";
    IF persisted_match_count <> (CASE
      WHEN calculation."availability" = 'verified_full'
        THEN calculation."matchedRollCount"
      ELSE 0
    END) THEN
      RAISE EXCEPTION 'coverage state calculation persisted match count mismatch';
    END IF;
  END IF;

  IF NEW."currentDecisionId" IS NOT NULL THEN
    SELECT * INTO decision
    FROM "warehouse_coverage_decisions"
    WHERE "id" = NEW."currentDecisionId";
    IF NOT FOUND
      OR decision."orderId" IS DISTINCT FROM NEW."orderId"
      OR decision."calculationId" IS DISTINCT FROM NEW."currentCalculationId"
      OR decision."generation" IS DISTINCT FROM NEW."generation"
    THEN
      RAISE EXCEPTION 'coverage state decision/calculation/generation mismatch';
    END IF;
    IF
      (decision."kind" = 'use_warehouse' AND NEW."state" <> 'warehouse_reserved')
      OR (decision."kind" = 'produce_all' AND NEW."state" <> 'production_required')
      OR (
        decision."kind" = 'auto_produce_all'
        AND NEW."state" NOT IN ('production_required', 'stale')
      )
      OR (
        decision."kind" = 'auto_produce_all'
        AND NEW."state" = 'production_required'
        AND calculation."inventoryEpoch" <> (
          SELECT "epoch"
          FROM "warehouse_coverage_inventory_epochs"
          WHERE "id" = 1
        )
      )
      OR (
        NEW."state" = 'stale'
        AND (
          decision."kind" <> 'auto_produce_all'
          OR calculation."inventoryEpoch" >= (
            SELECT "epoch"
            FROM "warehouse_coverage_inventory_epochs"
            WHERE "id" = 1
          )
        )
      )
    THEN
      RAISE EXCEPTION 'coverage state and terminal decision kind mismatch';
    END IF;
  ELSIF NEW."state" IN ('warehouse_reserved', 'production_required') THEN
    RAISE EXCEPTION 'terminal coverage state requires current decision';
  ELSIF NEW."currentCalculationId" IS NOT NULL THEN
    IF NEW."state" = 'awaiting_finance'
      AND calculation."availability" <> 'verified_full'
    THEN
      RAISE EXCEPTION 'awaiting_finance state requires a decisive calculation';
    ELSIF NEW."state" = 'unknown'
      AND calculation."availability" <> 'unknown'
    THEN
      RAISE EXCEPTION 'unknown state requires unknown calculation';
    ELSIF NEW."state" = 'recheck_requested' AND NOT EXISTS (
      SELECT 1
      FROM "order_resolution_cases"
      WHERE "orderId" = NEW."orderId"
        AND "status" = 'open'
        AND "sourceCoverageCalculationId" = NEW."currentCalculationId"
        AND "coverageOrigin" IN (
          'finance_request',
          'decision_linked_physical_exception'
        )
    ) THEN
      RAISE EXCEPTION 'recheck_requested state requires matching open coverage case';
    ELSIF NEW."state" NOT IN ('awaiting_finance', 'unknown', 'recheck_requested') THEN
      RAISE EXCEPTION 'coverage state/availability tuple is invalid';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."stateVersion" <> OLD."stateVersion" + 1 THEN
      RAISE EXCEPTION 'coverage stateVersion CAS must increment by exactly one';
    END IF;
    IF NEW."generation" NOT IN (OLD."generation", OLD."generation" + 1) THEN
      RAISE EXCEPTION 'coverage state generation may advance by at most one';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "production_orders"
      WHERE "commercialOrderId" = NEW."orderId"
    ) AND (
      NEW."generation" IS DISTINCT FROM OLD."generation"
      OR NEW."currentCalculationId" IS DISTINCT FROM OLD."currentCalculationId"
      OR NEW."currentDecisionId" IS DISTINCT FROM OLD."currentDecisionId"
    ) THEN
      RAISE EXCEPTION 'coverage state is terminal after production order creation';
    END IF;

    IF OLD."currentDecisionId" IS NOT NULL
      AND NEW."currentDecisionId" IS DISTINCT FROM OLD."currentDecisionId"
    THEN
      SELECT * INTO old_decision
      FROM "warehouse_coverage_decisions"
      WHERE "id" = OLD."currentDecisionId";

      IF old_decision."kind" = 'produce_all' THEN
        RAISE EXCEPTION 'explicit terminal coverage decision cannot be cleared';
      ELSIF old_decision."kind" = 'auto_produce_all' THEN
        IF NEW."currentDecisionId" IS NOT NULL THEN
          IF OLD."state" <> 'stale'
            OR decision."kind" <> 'auto_produce_all'
            OR NEW."generation" <> OLD."generation" + 1
          THEN
            RAISE EXCEPTION 'stale auto decision replacement is invalid';
          END IF;
        ELSIF NEW."state" = 'recheck_requested' THEN
          IF NEW."generation" <> OLD."generation"
            OR NEW."currentCalculationId" IS DISTINCT FROM OLD."currentCalculationId"
            OR NOT EXISTS (
              SELECT 1
              FROM "order_resolution_cases"
              WHERE "orderId" = NEW."orderId"
                AND "status" = 'open'
                AND "coverageOrigin" = 'finance_request'
                AND "sourceCoverageCalculationId" = OLD."currentCalculationId"
            )
          THEN
            RAISE EXCEPTION 'finance recheck cannot clear auto decision';
          END IF;
        ELSIF NEW."state" IN ('unknown', 'awaiting_finance') THEN
          IF OLD."state" <> 'stale'
            OR NEW."generation" <> OLD."generation" + 1
            OR NEW."currentCalculationId" IS NOT DISTINCT FROM OLD."currentCalculationId"
            OR (
              NEW."state" = 'unknown'
              AND calculation."availability" <> 'unknown'
            )
            OR (
              NEW."state" = 'awaiting_finance'
              AND calculation."availability" <> 'verified_full'
            )
          THEN
            RAISE EXCEPTION 'refreshed calculation cannot clear stale auto decision';
          END IF;
        ELSE
          RAISE EXCEPTION 'auto decision clear transition is not whitelisted';
        END IF;
      ELSIF old_decision."kind" = 'use_warehouse' THEN
        SELECT EXISTS (
          SELECT 1
          FROM "order_resolution_cases" coverage_case
          WHERE coverage_case."orderId" = NEW."orderId"
            AND coverage_case."status" = 'open'
            AND coverage_case."coverageOrigin" = 'decision_linked_physical_exception'
            AND coverage_case."sourceCoverageDecisionId" = OLD."currentDecisionId"
            AND coverage_case."sourceCoverageCalculationId" = OLD."currentCalculationId"
            AND (
              SELECT count(*)
              FROM "warehouse_coverage_recheck_memberships" membership
              WHERE membership."caseId" = coverage_case."id"
                AND membership."sourceDecisionId" = OLD."currentDecisionId"
                AND membership."sourceKind" = 'decision_match'
            ) = old_decision."expectedRollCount"
            AND NOT EXISTS (
              SELECT 1 FROM "warehouse_rolls"
              WHERE "reservedByCoverageDecisionId" = OLD."currentDecisionId"
            )
            AND EXISTS (
              SELECT 1 FROM "warehouse_acceptance_tasks"
              WHERE "coverageDecisionId" = OLD."currentDecisionId"
                AND "status" = 'exception'
            )
        ) INTO physical_recovery_ok;
        IF NEW."currentDecisionId" IS NOT NULL
          OR NEW."state" <> 'recheck_requested'
          OR NEW."generation" <> OLD."generation"
          OR NEW."currentCalculationId" IS DISTINCT FROM OLD."currentCalculationId"
          OR NOT physical_recovery_ok
        THEN
          RAISE EXCEPTION 'physical recovery state transition is not exact';
        END IF;
      END IF;
    END IF;
  ELSIF NEW."stateVersion" <> 1 THEN
    RAISE EXCEPTION 'initial coverage stateVersion must equal one';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "warehouse_coverage_states_validate_write"
BEFORE INSERT OR UPDATE ON "warehouse_coverage_states"
FOR EACH ROW EXECUTE FUNCTION "warehouse_coverage_validate_state"();

CREATE FUNCTION "warehouse_coverage_assert_decision_set"(decision_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  decision "warehouse_coverage_decisions"%ROWTYPE;
  active_roll_count INTEGER;
  task_id TEXT;
  task_count INTEGER;
  physical_recovery BOOLEAN;
BEGIN
  SELECT * INTO decision
  FROM "warehouse_coverage_decisions"
  WHERE "id" = decision_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*)::integer INTO active_roll_count
  FROM "warehouse_rolls"
  WHERE "reservedByCoverageDecisionId" = decision."id";

  IF decision."kind" <> 'use_warehouse' THEN
    IF active_roll_count <> 0 OR EXISTS (
      SELECT 1
      FROM "warehouse_acceptance_tasks"
      WHERE "coverageDecisionId" = decision."id"
    ) THEN
      RAISE EXCEPTION 'final decision set must be empty for production decision';
    END IF;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM "order_resolution_cases" coverage_case
    WHERE coverage_case."status" = 'open'
      AND coverage_case."coverageOrigin" = 'decision_linked_physical_exception'
      AND coverage_case."sourceCoverageDecisionId" = decision."id"
      AND (
        SELECT count(*)
        FROM "warehouse_coverage_recheck_memberships" membership
        WHERE membership."caseId" = coverage_case."id"
          AND membership."sourceDecisionId" = decision."id"
          AND membership."sourceKind" = 'decision_match'
      ) = decision."expectedRollCount"
      AND NOT EXISTS (
        SELECT 1
        FROM "warehouse_coverage_matches" match
        WHERE match."calculationId" = decision."calculationId"
          AND NOT EXISTS (
            SELECT 1
            FROM "warehouse_coverage_recheck_memberships" membership
            WHERE membership."caseId" = coverage_case."id"
              AND membership."rollId" = match."rollId"
              AND membership."sourceDecisionId" = decision."id"
              AND membership."sourceKind" = 'decision_match'
          )
      )
  ) INTO physical_recovery;

  IF active_roll_count = 0 AND physical_recovery THEN
    RETURN;
  END IF;
  IF active_roll_count <> decision."expectedRollCount" THEN
    RAISE EXCEPTION 'final decision set expectedRollCount mismatch';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "warehouse_coverage_matches" match
    LEFT JOIN "warehouse_rolls" roll
      ON roll."id" = match."rollId"
     AND roll."reservedByCoverageDecisionId" = decision."id"
     AND roll."reservedForOrderId" = decision."orderId"
     AND roll."reservedAt" IS NOT NULL
     AND roll."currentCoverageFactId" = match."coverageFactId"
    WHERE match."calculationId" = decision."calculationId"
      AND roll."id" IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM "warehouse_rolls" roll
    WHERE roll."reservedByCoverageDecisionId" = decision."id"
      AND NOT EXISTS (
        SELECT 1
        FROM "warehouse_coverage_matches" match
        WHERE match."calculationId" = decision."calculationId"
          AND match."rollId" = roll."id"
          AND match."coverageFactId" = roll."currentCoverageFactId"
      )
  ) THEN
    RAISE EXCEPTION 'final decision set roll/match provenance mismatch';
  END IF;

  SELECT count(*)::integer, min("id")
  INTO task_count, task_id
  FROM "warehouse_acceptance_tasks"
  WHERE "coverageDecisionId" = decision."id"
    AND "mode" = 'reserve'
    AND "orderId" = decision."orderId"
    AND "proposalId" IS NULL
    AND "positionId" IS NULL
    AND "status" <> 'exception';
  IF task_count <> 1 THEN
    RAISE EXCEPTION 'final decision set requires exactly one reserve task';
  END IF;
  IF (
    SELECT count(*) FROM "scan_rows" WHERE "taskId" = task_id
  ) <> decision."expectedRollCount"
    OR EXISTS (
      SELECT 1
      FROM "scan_rows" scan
      WHERE scan."taskId" = task_id
        AND (
          scan."fromOrderId" IS DISTINCT FROM decision."orderId"
          OR NOT EXISTS (
            SELECT 1
            FROM "warehouse_rolls" roll
            WHERE roll."reservedByCoverageDecisionId" = decision."id"
              AND roll."rollCode" = scan."rollCode"
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM "warehouse_rolls" roll
      WHERE roll."reservedByCoverageDecisionId" = decision."id"
        AND NOT EXISTS (
          SELECT 1
          FROM "scan_rows" scan
          WHERE scan."taskId" = task_id
            AND scan."rollCode" = roll."rollCode"
        )
    )
  THEN
    RAISE EXCEPTION 'final decision set scan rows do not equal matches';
  END IF;
END;
$$;

CREATE FUNCTION "warehouse_coverage_validate_final_decision"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM "warehouse_coverage_assert_decision_set"(NEW."id");
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "warehouse_coverage_decisions_final_set_deferred"
AFTER INSERT ON "warehouse_coverage_decisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "warehouse_coverage_validate_final_decision"();

CREATE FUNCTION "warehouse_coverage_validate_final_sets"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  decision_row RECORD;
  invalid_v2_task BOOLEAN := false;
BEGIN
  IF TG_TABLE_NAME = 'warehouse_rolls' THEN
    FOR decision_row IN EXECUTE
      'SELECT DISTINCT decision_id AS id
       FROM (
         SELECT "reservedByCoverageDecisionId" AS decision_id FROM old_rows
         UNION
         SELECT "reservedByCoverageDecisionId" AS decision_id FROM new_rows
       ) affected
       WHERE decision_id IS NOT NULL'
    LOOP
      PERFORM "warehouse_coverage_assert_decision_set"(decision_row.id);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'warehouse_acceptance_tasks' THEN
    IF TG_OP <> 'DELETE' THEN
      EXECUTE
        'SELECT EXISTS (
           SELECT 1
           FROM new_rows task
           JOIN "commercial_orders" order_row ON order_row."id" = task."orderId"
           WHERE task."mode" = ''reserve''
             AND task."coverageDecisionId" IS NULL
             AND order_row."warehouseCoverageWorkflowVersion" = 2
         )'
      INTO invalid_v2_task;
      IF invalid_v2_task THEN
        RAISE EXCEPTION 'V2 reserve task requires coverage decision provenance';
      END IF;
    END IF;
    IF TG_OP = 'INSERT' THEN
      FOR decision_row IN EXECUTE
        'SELECT DISTINCT "coverageDecisionId" AS id
         FROM new_rows
         WHERE "coverageDecisionId" IS NOT NULL'
      LOOP
        PERFORM "warehouse_coverage_assert_decision_set"(decision_row.id);
      END LOOP;
    ELSIF TG_OP = 'DELETE' THEN
      FOR decision_row IN EXECUTE
        'SELECT DISTINCT "coverageDecisionId" AS id
         FROM old_rows
         WHERE "coverageDecisionId" IS NOT NULL'
      LOOP
        PERFORM "warehouse_coverage_assert_decision_set"(decision_row.id);
      END LOOP;
    ELSE
      FOR decision_row IN EXECUTE
        'SELECT DISTINCT decision_id AS id
         FROM (
           SELECT "coverageDecisionId" AS decision_id FROM old_rows
           UNION
           SELECT "coverageDecisionId" AS decision_id FROM new_rows
         ) affected
         WHERE decision_id IS NOT NULL'
      LOOP
        PERFORM "warehouse_coverage_assert_decision_set"(decision_row.id);
      END LOOP;
    END IF;
  ELSIF TG_TABLE_NAME = 'scan_rows' THEN
    IF TG_OP = 'INSERT' THEN
      FOR decision_row IN EXECUTE
        'SELECT DISTINCT task."coverageDecisionId" AS id
         FROM new_rows changed
         JOIN "warehouse_acceptance_tasks" task ON task."id" = changed."taskId"
         WHERE task."coverageDecisionId" IS NOT NULL'
      LOOP
        PERFORM "warehouse_coverage_assert_decision_set"(decision_row.id);
      END LOOP;
    ELSIF TG_OP = 'DELETE' THEN
      FOR decision_row IN EXECUTE
        'SELECT DISTINCT task."coverageDecisionId" AS id
         FROM old_rows changed
         JOIN "warehouse_acceptance_tasks" task ON task."id" = changed."taskId"
         WHERE task."coverageDecisionId" IS NOT NULL'
      LOOP
        PERFORM "warehouse_coverage_assert_decision_set"(decision_row.id);
      END LOOP;
    ELSE
      FOR decision_row IN EXECUTE
        'SELECT DISTINCT task."coverageDecisionId" AS id
         FROM (
           SELECT "taskId" FROM old_rows
           UNION
           SELECT "taskId" FROM new_rows
         ) changed
         JOIN "warehouse_acceptance_tasks" task ON task."id" = changed."taskId"
         WHERE task."coverageDecisionId" IS NOT NULL'
      LOOP
        PERFORM "warehouse_coverage_assert_decision_set"(decision_row.id);
      END LOOP;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "warehouse_rolls_coverage_validate_reservations_update"
AFTER UPDATE ON "warehouse_rolls"
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "warehouse_coverage_validate_final_sets"();

CREATE TRIGGER "warehouse_acceptance_tasks_coverage_validate_insert"
AFTER INSERT ON "warehouse_acceptance_tasks"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "warehouse_coverage_validate_final_sets"();
CREATE TRIGGER "warehouse_acceptance_tasks_coverage_validate_update"
AFTER UPDATE ON "warehouse_acceptance_tasks"
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "warehouse_coverage_validate_final_sets"();
CREATE TRIGGER "warehouse_acceptance_tasks_coverage_validate_delete"
AFTER DELETE ON "warehouse_acceptance_tasks"
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION "warehouse_coverage_validate_final_sets"();

CREATE TRIGGER "scan_rows_coverage_validate_insert"
AFTER INSERT ON "scan_rows"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "warehouse_coverage_validate_final_sets"();
CREATE TRIGGER "scan_rows_coverage_validate_update"
AFTER UPDATE ON "scan_rows"
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "warehouse_coverage_validate_final_sets"();
CREATE TRIGGER "scan_rows_coverage_validate_delete"
AFTER DELETE ON "scan_rows"
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION "warehouse_coverage_validate_final_sets"();

CREATE FUNCTION "warehouse_coverage_has_exact_keys"(value JSONB, expected TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT
    jsonb_typeof(value) = 'object'
    AND (
      SELECT array_agg(key ORDER BY key)
      FROM jsonb_object_keys(value) AS keys(key)
    ) IS NOT DISTINCT FROM (
      SELECT array_agg(key ORDER BY key)
      FROM unnest(expected) AS keys(key)
    );
$$;

CREATE FUNCTION "warehouse_coverage_projection_shape"(
  value JSONB,
  include_finance_rolls BOOLEAN,
  include_case_id BOOLEAN,
  expected_case_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path FROM CURRENT
AS $$
DECLARE
  expected_keys TEXT[] := ARRAY[
    'availability',
    'availableActions',
    'calculatedAt',
    'generation',
    'matchedRollCount',
    'nextOwner',
    'reasonCodes',
    'requiredRollCount',
    'stale',
    'state',
    'stateVersion',
    'uncertainRollCount',
    'workflowVersion'
  ];
BEGIN
  IF include_finance_rolls THEN
    expected_keys := array_append(expected_keys, 'financeRolls');
  END IF;
  IF include_case_id THEN
    expected_keys := array_append(expected_keys, 'caseId');
  END IF;
  IF jsonb_typeof(value -> 'availableActions') <> 'array' THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(value -> 'availableActions') AS actions(action)
    WHERE jsonb_typeof(action) <> 'string'
  ) THEN
    RETURN false;
  END IF;
  IF (
    SELECT count(*)
    FROM jsonb_array_elements_text(value -> 'availableActions') AS actions(action)
  ) <> (
    SELECT count(DISTINCT action)
    FROM jsonb_array_elements_text(value -> 'availableActions') AS actions(action)
  ) THEN
    RETURN false;
  END IF;
  IF NOT "warehouse_coverage_has_exact_keys"(value, expected_keys)
    OR jsonb_typeof(value -> 'workflowVersion') <> 'number'
    OR value ->> 'workflowVersion' <> '2'
    OR jsonb_typeof(value -> 'state') <> 'string'
    OR value ->> 'state' NOT IN (
      'calculating',
      'awaiting_finance',
      'production_required',
      'unknown',
      'recheck_requested',
      'warehouse_reserved',
      'stale'
    )
    OR jsonb_typeof(value -> 'stateVersion') <> 'number'
    OR (value ->> 'stateVersion') !~ '^[1-9][0-9]*$'
    OR jsonb_typeof(value -> 'generation') NOT IN ('number', 'null')
    OR (
      jsonb_typeof(value -> 'generation') = 'number'
      AND (value ->> 'generation') !~ '^[1-9][0-9]*$'
    )
    OR jsonb_typeof(value -> 'availability') NOT IN ('string', 'null')
    OR (
      jsonb_typeof(value -> 'availability') = 'string'
      AND value ->> 'availability' NOT IN ('verified_full', 'unavailable', 'unknown')
    )
    OR NOT "warehouse_coverage_is_reason_codes"(value -> 'reasonCodes')
    OR jsonb_typeof(value -> 'nextOwner') <> 'string'
    OR value ->> 'nextOwner' NOT IN ('finance', 'commercial', 'warehouse', 'system')
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(value -> 'availableActions') AS actions(action)
      WHERE action NOT IN (
        'use_warehouse',
        'produce_all',
        'request_recheck',
        'correct_order_spec',
        'resolve_recheck',
        'refresh',
        'report_physical_exception'
      )
    )
    OR jsonb_typeof(value -> 'requiredRollCount') <> 'number'
    OR jsonb_typeof(value -> 'matchedRollCount') <> 'number'
    OR jsonb_typeof(value -> 'uncertainRollCount') <> 'number'
    OR (value ->> 'requiredRollCount') !~ '^[0-9]+$'
    OR (value ->> 'matchedRollCount') !~ '^[0-9]+$'
    OR (value ->> 'uncertainRollCount') !~ '^[0-9]+$'
    OR jsonb_typeof(value -> 'calculatedAt') NOT IN ('string', 'null')
    OR (
      jsonb_typeof(value -> 'calculatedAt') = 'string'
      AND value ->> 'calculatedAt'
        !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    )
    OR jsonb_typeof(value -> 'stale') <> 'boolean'
    OR (
      include_case_id
      AND (
        jsonb_typeof(value -> 'caseId') <> 'string'
        OR value ->> 'caseId' IS DISTINCT FROM expected_case_id
      )
    )
  THEN
    RETURN false;
  END IF;
  IF include_finance_rolls THEN
    IF jsonb_typeof(value -> 'financeRolls') <> 'array'
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(value -> 'financeRolls') AS rolls(item)
        WHERE NOT "warehouse_coverage_has_exact_keys"(
          item,
          ARRAY['positionId', 'rollCode']
        )
          OR jsonb_typeof(item -> 'positionId') <> 'string'
          OR jsonb_typeof(item -> 'rollCode') <> 'string'
          OR length(btrim(item ->> 'positionId')) = 0
          OR length(btrim(item ->> 'rollCode')) = 0
      )
    THEN
      RETURN false;
    END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE FUNCTION "warehouse_coverage_validate_command"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  calculation "warehouse_coverage_calculations"%ROWTYPE;
  current_state "warehouse_coverage_states"%ROWTYPE;
  result_decision "warehouse_coverage_decisions"%ROWTYPE;
  result_case "order_resolution_cases"%ROWTYPE;
  scope_case "order_resolution_cases"%ROWTYPE;
  actor_matches BOOLEAN;
  include_finance BOOLEAN;
  include_case BOOLEAN;
  expected_actions JSONB;
  expected_state TEXT;
  expected_owner TEXT;
  expected_availability TEXT;
  expected_reasons JSONB;
BEGIN
  IF NEW."kind" = 'cancel_reservation' THEN
    IF NEW."actorKind" <> 'system'
      OR NEW."systemActorKey" IS DISTINCT FROM 'warehouse_coverage_engine'
    THEN
      RAISE EXCEPTION 'cancel command requires exact system actor';
    END IF;
  ELSE
    IF NEW."actorKind" <> 'user' THEN
      RAISE EXCEPTION 'routine coverage command requires user actor';
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM "users"
      WHERE "id" = NEW."actorId"
        AND "role" = NEW."actorRole"
    ) INTO actor_matches;
    IF NOT actor_matches
      OR (NEW."kind" IN ('refresh', 'decide', 'request_recheck')
        AND NEW."actorRole" <> 'finance'::"Role")
      OR (NEW."kind" = 'resolve_recheck' AND NEW."actorRole" <> 'warehouse'::"Role")
    THEN
      RAISE EXCEPTION 'coverage command actor role mismatch';
    END IF;
  END IF;

  IF NEW."resultKind" = 'calculation' THEN
    SELECT * INTO calculation
    FROM "warehouse_coverage_calculations"
    WHERE "id" = NEW."resultCalculationId";
  ELSIF NEW."resultKind" = 'decision' THEN
    SELECT * INTO result_decision
    FROM "warehouse_coverage_decisions"
    WHERE "id" = NEW."resultDecisionId";
    SELECT * INTO calculation
    FROM "warehouse_coverage_calculations"
    WHERE "id" = result_decision."calculationId";
  ELSE
    SELECT * INTO result_case
    FROM "order_resolution_cases"
    WHERE "id" = NEW."resultCaseId";
    SELECT * INTO calculation
    FROM "warehouse_coverage_calculations"
    WHERE "id" = result_case."sourceCoverageCalculationId";
  END IF;
  IF calculation."id" IS NULL
    OR calculation."orderId" IS DISTINCT FROM NEW."orderId"
    OR NEW."resultGeneration" IS DISTINCT FROM calculation."generation"
    OR NEW."safeResult" ->> 'generation' IS DISTINCT FROM calculation."generation"::text
    OR NEW."safeResult" ->> 'stateVersion' IS DISTINCT FROM NEW."resultStateVersion"::text
    OR NEW."safeResult" ->> 'requiredRollCount'
      IS DISTINCT FROM calculation."requiredRollCount"::text
    OR NEW."safeResult" ->> 'matchedRollCount'
      IS DISTINCT FROM calculation."matchedRollCount"::text
    OR NEW."safeResult" ->> 'uncertainRollCount'
      IS DISTINCT FROM calculation."uncertainRollCount"::text
    OR (
      NEW."safeResult" ->> 'calculatedAt'
    )::timestamptz IS DISTINCT FROM calculation."calculatedAt"
  THEN
    RAISE EXCEPTION 'coverage command result calculation/generation/stateVersion mismatch';
  END IF;

  include_finance := NEW."kind" IN ('refresh', 'decide', 'request_recheck');
  include_case := NEW."kind" IN ('request_recheck', 'cancel_reservation');
  IF NOT "warehouse_coverage_projection_shape"(
    NEW."safeResult",
    include_finance,
    include_case,
    NEW."resultCaseId"
  ) THEN
    RAISE EXCEPTION 'coverage command safeResult projection shape is invalid';
  END IF;

  IF include_finance AND (
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW."safeResult" -> 'financeRolls') AS rolls(item)
      GROUP BY item ->> 'positionId', item ->> 'rollCode'
      HAVING count(*) > 1
    )
    OR
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW."safeResult" -> 'financeRolls') AS rolls(item)
      WHERE NOT EXISTS (
        SELECT 1
        FROM "warehouse_coverage_matches" match
        JOIN "warehouse_rolls" roll ON roll."id" = match."rollId"
        WHERE match."calculationId" = calculation."id"
          AND match."positionId" = item ->> 'positionId'
          AND roll."rollCode" = item ->> 'rollCode'
      )
    )
    OR EXISTS (
      SELECT 1
      FROM "warehouse_coverage_matches" match
      JOIN "warehouse_rolls" roll ON roll."id" = match."rollId"
      WHERE match."calculationId" = calculation."id"
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(NEW."safeResult" -> 'financeRolls') AS rolls(item)
          WHERE item ->> 'positionId' = match."positionId"
            AND item ->> 'rollCode' = roll."rollCode"
        )
    )
    OR (
      SELECT count(*)
      FROM jsonb_array_elements(NEW."safeResult" -> 'financeRolls')
    ) <> (
      SELECT count(*)
      FROM "warehouse_coverage_matches"
      WHERE "calculationId" = calculation."id"
    )
  ) THEN
    RAISE EXCEPTION 'coverage command financeRolls projection mismatch';
  END IF;

  IF NEW."kind" = 'refresh' THEN
    expected_availability := calculation."availability";
    expected_reasons := calculation."reasonCodes";
    IF calculation."availability" = 'verified_full' THEN
      expected_state := 'awaiting_finance';
      expected_owner := 'finance';
      expected_actions := '["use_warehouse","produce_all","request_recheck"]'::jsonb;
    ELSIF calculation."availability" = 'unavailable' THEN
      expected_state := 'production_required';
      expected_owner := 'system';
      expected_actions := CASE
        WHEN EXISTS (
          SELECT 1
          FROM "production_orders"
          WHERE "commercialOrderId" = NEW."orderId"
        ) THEN '[]'::jsonb
        ELSE '["request_recheck"]'::jsonb
      END;
    ELSE
      expected_state := 'unknown';
      IF calculation."reasonCodes" ? 'unsupported_policy_version' THEN
        expected_owner := 'system';
        expected_actions := '[]'::jsonb;
      ELSIF calculation."reasonCodes" ? 'order_spec_incomplete' THEN
        expected_owner := 'commercial';
        expected_actions := '[]'::jsonb;
      ELSE
        expected_owner := 'finance';
        expected_actions := '["request_recheck"]'::jsonb;
      END IF;
    END IF;
  ELSIF NEW."kind" = 'decide' THEN
    IF result_decision."orderId" IS DISTINCT FROM NEW."orderId"
      OR result_decision."kind" NOT IN ('use_warehouse', 'produce_all')
    THEN
      RAISE EXCEPTION 'coverage command decision kind/order mismatch';
    END IF;
    expected_state := CASE
      WHEN result_decision."kind" = 'use_warehouse' THEN 'warehouse_reserved'
      ELSE 'production_required'
    END;
    expected_owner := CASE
      WHEN result_decision."kind" = 'use_warehouse' THEN 'warehouse'
      ELSE 'system'
    END;
    expected_availability := calculation."availability";
    expected_reasons := calculation."reasonCodes";
    expected_actions := '[]'::jsonb;
  ELSIF NEW."kind" = 'request_recheck' THEN
    IF result_case."orderId" IS DISTINCT FROM NEW."orderId"
      OR result_case."coverageOrigin" <> 'finance_request'
      OR result_case."status" <> 'open'
      OR result_case."openScopeKey" IS DISTINCT FROM (
        'warehouse_coverage_v2:' || NEW."orderId" || ':finance_request'
      )
    THEN
      RAISE EXCEPTION 'coverage command recheck case/order mismatch';
    END IF;
    expected_state := 'recheck_requested';
    expected_owner := 'warehouse';
    expected_availability := 'unknown';
    expected_reasons := '["warehouse_recheck_pending"]'::jsonb;
    expected_actions := '[]'::jsonb;
  ELSIF NEW."kind" = 'resolve_recheck' THEN
    SELECT * INTO scope_case
    FROM "order_resolution_cases"
    WHERE "id" = NEW."scopeCaseId";
    IF NOT FOUND
      OR scope_case."orderId" IS DISTINCT FROM NEW."orderId"
      OR scope_case."coverageOrigin" NOT IN (
        'finance_request',
        'decision_linked_physical_exception'
      )
      OR scope_case."status" <> 'resolved'
      OR scope_case."openScopeKey" IS NOT NULL
      OR scope_case."coverageScope" IS DISTINCT FROM (
        'warehouse_coverage_v2:' || NEW."orderId"
      )
      OR NOT EXISTS (
        SELECT 1
        FROM "warehouse_coverage_calculations" source_calculation
        WHERE source_calculation."id" = scope_case."sourceCoverageCalculationId"
          AND source_calculation."orderId" = NEW."orderId"
          AND source_calculation."generation" + 1 = calculation."generation"
      )
    THEN
      RAISE EXCEPTION 'resolve command scopeCaseId mismatch';
    END IF;
    expected_availability := calculation."availability";
    expected_reasons := calculation."reasonCodes";
    expected_actions := '[]'::jsonb;
    IF calculation."availability" = 'verified_full' THEN
      expected_state := 'awaiting_finance';
      expected_owner := 'finance';
    ELSIF calculation."availability" = 'unavailable' THEN
      expected_state := 'production_required';
      expected_owner := 'system';
    ELSE
      expected_state := 'unknown';
      IF calculation."reasonCodes" ? 'unsupported_policy_version' THEN
        expected_owner := 'system';
      ELSIF calculation."reasonCodes" ? 'order_spec_incomplete' THEN
        expected_owner := 'commercial';
      ELSE
        expected_owner := 'finance';
      END IF;
    END IF;
  ELSE
    IF result_case."orderId" IS DISTINCT FROM NEW."orderId"
      OR result_case."coverageOrigin" <> 'decision_linked_physical_exception'
      OR result_case."status" <> 'open'
      OR result_case."openScopeKey" IS DISTINCT FROM (
        'warehouse_coverage_v2:' || NEW."orderId"
        || ':decision_linked_physical_exception'
      )
      OR NOT EXISTS (
        SELECT 1
        FROM "warehouse_acceptance_tasks"
        WHERE "id" = NEW."scopeTaskId"
          AND "orderId" = NEW."orderId"
          AND "coverageDecisionId" = result_case."sourceCoverageDecisionId"
          AND "status" = 'exception'
      )
    THEN
      RAISE EXCEPTION 'cancel command scopeTaskId/resultCaseId mismatch';
    END IF;
    expected_state := 'recheck_requested';
    expected_owner := 'warehouse';
    expected_availability := 'unknown';
    expected_reasons := '["warehouse_recheck_pending"]'::jsonb;
    expected_actions := '[]'::jsonb;
  END IF;

  IF NEW."safeResult" ->> 'state' IS DISTINCT FROM expected_state
    OR NEW."safeResult" ->> 'nextOwner' IS DISTINCT FROM expected_owner
    OR NEW."safeResult" ->> 'availability' IS DISTINCT FROM expected_availability
    OR NEW."safeResult" -> 'reasonCodes' IS DISTINCT FROM expected_reasons
    OR NEW."safeResult" -> 'availableActions' IS DISTINCT FROM expected_actions
    OR NEW."safeResult" ->> 'stale' IS DISTINCT FROM 'false'
  THEN
    RAISE EXCEPTION 'coverage command safeResult projection semantics mismatch';
  END IF;

  IF NEW."kind" IN ('request_recheck', 'cancel_reservation')
    AND result_case."sourceCoverageStateVersion" + 1
      IS DISTINCT FROM NEW."resultStateVersion"
  THEN
    RAISE EXCEPTION 'coverage command result case source state version mismatch';
  END IF;

  SELECT * INTO current_state
  FROM "warehouse_coverage_states"
  WHERE "orderId" = NEW."orderId";
  IF NOT FOUND
    OR current_state."stateVersion" IS DISTINCT FROM NEW."resultStateVersion"
    OR current_state."generation" IS DISTINCT FROM calculation."generation"
    OR current_state."currentCalculationId" IS DISTINCT FROM calculation."id"
    OR current_state."state" IS DISTINCT FROM expected_state
  THEN
    RAISE EXCEPTION 'coverage command result state/version/current pointer mismatch';
  END IF;
  IF NEW."kind" = 'decide' THEN
    IF current_state."currentDecisionId" IS DISTINCT FROM result_decision."id" THEN
      RAISE EXCEPTION 'coverage command result decision pointer mismatch';
    END IF;
  ELSIF expected_state IN ('awaiting_finance', 'unknown', 'recheck_requested') THEN
    IF current_state."currentDecisionId" IS NOT NULL THEN
      RAISE EXCEPTION 'coverage command result decision pointer mismatch';
    END IF;
  ELSIF expected_state = 'production_required' AND NOT EXISTS (
    SELECT 1
    FROM "warehouse_coverage_decisions"
    WHERE "id" = current_state."currentDecisionId"
      AND "orderId" = NEW."orderId"
      AND "calculationId" = calculation."id"
      AND "generation" = calculation."generation"
      AND "kind" = 'auto_produce_all'
  ) THEN
    RAISE EXCEPTION 'coverage command auto decision pointer mismatch';
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'coverage command safeResult projection value is invalid';
END;
$$;

CREATE TRIGGER "warehouse_coverage_commands_validate_insert"
BEFORE INSERT ON "warehouse_coverage_commands"
FOR EACH ROW EXECUTE FUNCTION "warehouse_coverage_validate_command"();

COMMIT;
