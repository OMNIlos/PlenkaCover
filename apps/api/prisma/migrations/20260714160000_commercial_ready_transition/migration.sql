-- Durable compare-and-set marker for the first fulfillment-complete transition.

ALTER TABLE "commercial_orders"
ADD COLUMN "readyForShipmentAt" TIMESTAMP(3);
