-- A topology record is not proof that hardware is reachable. New devices stay
-- fail-closed until a gateway heartbeat and physical probe update their state.
ALTER TABLE "device_runtimes"
  ALTER COLUMN "status" SET DEFAULT 'offline';
