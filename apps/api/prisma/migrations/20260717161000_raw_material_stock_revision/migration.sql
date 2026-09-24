ALTER TABLE "raw_material_stocks"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "raw_material_stocks_revision_positive_check"
    CHECK ("revision" >= 1);

CREATE FUNCTION "bump_raw_material_stock_revision"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW."materialId",
    NEW."actualQty",
    NEW."unit"
  ) IS DISTINCT FROM ROW(
    OLD."materialId",
    OLD."actualQty",
    OLD."unit"
  ) THEN
    NEW."revision" := OLD."revision" + 1;
  ELSE
    NEW."revision" := OLD."revision";
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "raw_material_stocks_bump_revision"
BEFORE UPDATE ON "raw_material_stocks"
FOR EACH ROW EXECUTE FUNCTION "bump_raw_material_stock_revision"();
