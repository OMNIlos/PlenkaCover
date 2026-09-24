BEGIN;

CREATE TABLE "operator_shift_close_commands" (
  "id" TEXT NOT NULL,
  "operationKey" UUID NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "operatorId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "shiftId" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "actorRole" "Role" NOT NULL,
  "resultSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "operator_shift_close_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operator_shift_close_commands_fingerprint_check"
    CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "operator_shift_close_commands_actor_role_check"
    CHECK ("actorRole" = 'operator'::"Role"),
  CONSTRAINT "operator_shift_close_commands_result_ownership_check"
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
        'sessionId', 'shiftId', 'status', 'summary', 'breakdown', 'unresolved'
      ]::TEXT[]) = '{}'::JSONB
      AND "resultSnapshot" #>> '{closingPayroll,sessionId}' = "sessionId"
      AND "resultSnapshot" #>> '{closingPayroll,shiftId}' = "shiftId"
    ) IS TRUE)
);

CREATE UNIQUE INDEX "operator_post_sessions_close_owner_key"
  ON "operator_post_sessions"("id", "operatorId", "shiftId", "postId");
CREATE UNIQUE INDEX "operator_shift_machine_assignments_close_owner_key"
  ON "operator_shift_machine_assignments"("id", "operatorId", "shiftId", "postId");
CREATE UNIQUE INDEX "operator_shift_close_commands_operationKey_key"
  ON "operator_shift_close_commands"("operationKey");
CREATE UNIQUE INDEX "operator_shift_close_commands_sessionId_key"
  ON "operator_shift_close_commands"("sessionId");
CREATE UNIQUE INDEX "operator_shift_close_commands_assignmentId_key"
  ON "operator_shift_close_commands"("assignmentId");
CREATE UNIQUE INDEX "operator_shift_close_commands_session_owner_key"
  ON "operator_shift_close_commands"("sessionId", "operatorId", "shiftId", "postId");
CREATE UNIQUE INDEX "operator_shift_close_commands_assignment_owner_key"
  ON "operator_shift_close_commands"("assignmentId", "operatorId", "shiftId", "postId");
CREATE INDEX "operator_shift_close_commands_operatorId_createdAt_id_idx"
  ON "operator_shift_close_commands"("operatorId", "createdAt", "id");
CREATE INDEX "operator_shift_close_commands_shiftId_createdAt_id_idx"
  ON "operator_shift_close_commands"("shiftId", "createdAt", "id");

ALTER TABLE "operator_shift_close_commands"
  ADD CONSTRAINT "operator_shift_close_commands_operatorId_fkey"
  FOREIGN KEY ("operatorId") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_shift_close_commands"
  ADD CONSTRAINT "operator_shift_close_commands_session_owner_fkey"
  FOREIGN KEY ("sessionId", "operatorId", "shiftId", "postId")
  REFERENCES "operator_post_sessions"("id", "operatorId", "shiftId", "postId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_shift_close_commands"
  ADD CONSTRAINT "operator_shift_close_commands_shiftId_fkey"
  FOREIGN KEY ("shiftId") REFERENCES "shifts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_shift_close_commands"
  ADD CONSTRAINT "operator_shift_close_commands_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "posts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_shift_close_commands"
  ADD CONSTRAINT "operator_shift_close_commands_assignment_owner_fkey"
  FOREIGN KEY ("assignmentId", "operatorId", "shiftId", "postId")
  REFERENCES "operator_shift_machine_assignments"("id", "operatorId", "shiftId", "postId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_operator_shift_close_command_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'operator shift close commands are append-only';
END;
$$;

CREATE TRIGGER operator_shift_close_commands_immutable
BEFORE UPDATE OR DELETE ON "operator_shift_close_commands"
FOR EACH ROW EXECUTE FUNCTION reject_operator_shift_close_command_mutation();

CREATE TRIGGER operator_shift_close_commands_no_truncate
BEFORE TRUNCATE ON "operator_shift_close_commands"
FOR EACH STATEMENT EXECUTE FUNCTION reject_operator_shift_close_command_mutation();

COMMIT;
