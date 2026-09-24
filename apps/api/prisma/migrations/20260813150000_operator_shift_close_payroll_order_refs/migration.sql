ALTER TABLE "operator_shift_close_commands"
  DROP CONSTRAINT "operator_shift_close_commands_result_ownership_check";

ALTER TABLE "operator_shift_close_commands"
  ADD CONSTRAINT "operator_shift_close_commands_result_ownership_check"
  CHECK ((
    jsonb_typeof("resultSnapshot") = 'object'
    AND "resultSnapshot" ?& ARRAY[
      'balance', 'problemId', 'releasedRollIds', 'closingPayroll'
    ]::TEXT[]
    AND ("resultSnapshot" - ARRAY[
      'balance', 'problemId', 'releasedRollIds', 'closingPayroll'
    ]::TEXT[]) = '{}'::JSONB
    AND jsonb_typeof("resultSnapshot" -> 'closingPayroll') = 'object'
    AND ("resultSnapshot" -> 'closingPayroll') ?& ARRAY[
      'sessionId', 'shiftId', 'status', 'summary', 'breakdown', 'unresolved'
    ]::TEXT[]
    AND (("resultSnapshot" -> 'closingPayroll') - ARRAY[
      'sessionId', 'shiftId', 'status', 'appliedTariffOrders', 'summary', 'breakdown', 'unresolved'
    ]::TEXT[]) = '{}'::JSONB
    AND (
      NOT (("resultSnapshot" -> 'closingPayroll') ? 'appliedTariffOrders')
      OR jsonb_typeof("resultSnapshot" #> '{closingPayroll,appliedTariffOrders}') = 'array'
    )
    AND "resultSnapshot" #>> '{closingPayroll,sessionId}' = "sessionId"
    AND "resultSnapshot" #>> '{closingPayroll,shiftId}' = "shiftId"
  ) IS TRUE);
