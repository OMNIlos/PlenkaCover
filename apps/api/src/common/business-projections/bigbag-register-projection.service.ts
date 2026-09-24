import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  BigBagRegisterLocation,
  BigBagRegisterPage,
  BigBagRegisterQuery,
  BigBagRegisterRow,
} from '@plenka/contracts';
import { valueBigBag } from '../money/big-bag-valuation';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;

type BigBagRegisterQueryRow = {
  id: string | null;
  code: string | null;
  material: string | null;
  batch: string | null;
  createdAt: Date | null;
  status: BigBagRegisterRow['status'] | null;
  locationKind: BigBagRegisterLocation['kind'] | null;
  postCode: string | null;
  postName: string | null;
  operatorName: string | null;
  currentWeightKg: number | null;
  priceKopecksPerKg: number | null;
  total: number;
};

function project(row: BigBagRegisterQueryRow): BigBagRegisterRow | null {
  if (
    row.id === null ||
    row.code === null ||
    row.material === null ||
    row.createdAt === null ||
    row.status === null ||
    row.locationKind === null
  ) {
    return null;
  }
  const hasCompletePost =
    row.postCode !== null && row.postName !== null && row.operatorName !== null;
  const hasAnyAssignment =
    row.postCode !== null || row.postName !== null || row.operatorName !== null;
  if (
    (row.locationKind === 'post' && !hasCompletePost) ||
    (row.locationKind !== 'post' && hasAnyAssignment)
  ) {
    return null;
  }
  const totalKopecks =
    row.currentWeightKg === null
      ? null
      : valueBigBag({
          kg: row.currentWeightKg,
          priceKopecksPerKg: row.priceKopecksPerKg,
        }).totalKopecks;
  return {
    id: row.id,
    code: row.code,
    material: row.material,
    batch: row.batch,
    createdAt: row.createdAt.toISOString(),
    status: row.status,
    location: {
      kind: row.locationKind,
      postCode: row.postCode,
      postName: row.postName,
    },
    operatorName: row.operatorName,
    currentWeightKg: row.currentWeightKg,
    totalKopecks,
  };
}

@Injectable()
export class BigBagRegisterProjectionService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: BigBagRegisterQuery): Promise<BigBagRegisterPage> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const search = query.q?.normalize('NFKC').trim().toLocaleLowerCase('ru-RU') ?? '';
    const view = query.view ?? 'all';
    const offset = (page - 1) * pageSize;
    const rows = await this.prisma.$queryRaw<BigBagRegisterQueryRow[]>(Prisma.sql`
      WITH input AS (
        SELECT ${search}::text AS query, ${view}::text AS view
      ),
      open_usage_facts AS (
        SELECT
          bag.id AS big_bag_id,
          COUNT(usage.id)::integer AS open_usage_count,
          COUNT(usage.id) FILTER (
            WHERE session.status = 'active'
              AND post.id IS NOT NULL
              AND NULLIF(BTRIM(post.code), '') IS NOT NULL
              AND NULLIF(BTRIM(post.name), '') IS NOT NULL
              AND operator_actor.id IS NOT NULL
              AND NULLIF(BTRIM(operator_actor."displayName"), '') IS NOT NULL
          )::integer AS active_assignment_count,
          MIN(post.code) FILTER (
            WHERE session.status = 'active'
              AND post.id IS NOT NULL
              AND NULLIF(BTRIM(post.code), '') IS NOT NULL
              AND NULLIF(BTRIM(post.name), '') IS NOT NULL
              AND operator_actor.id IS NOT NULL
              AND NULLIF(BTRIM(operator_actor."displayName"), '') IS NOT NULL
          ) AS post_code,
          MIN(post.name) FILTER (
            WHERE session.status = 'active'
              AND post.id IS NOT NULL
              AND NULLIF(BTRIM(post.code), '') IS NOT NULL
              AND NULLIF(BTRIM(post.name), '') IS NOT NULL
              AND operator_actor.id IS NOT NULL
              AND NULLIF(BTRIM(operator_actor."displayName"), '') IS NOT NULL
          ) AS post_name,
          MIN(operator_actor."displayName") FILTER (
            WHERE session.status = 'active'
              AND post.id IS NOT NULL
              AND NULLIF(BTRIM(post.code), '') IS NOT NULL
              AND NULLIF(BTRIM(post.name), '') IS NOT NULL
              AND operator_actor.id IS NOT NULL
              AND NULLIF(BTRIM(operator_actor."displayName"), '') IS NOT NULL
          ) AS operator_name
        FROM big_bag_units AS bag
        LEFT JOIN shift_bag_usages AS usage
          ON usage."bigBagId" = bag.id
          AND usage."closedAt" IS NULL
        LEFT JOIN operator_post_sessions AS session
          ON session.id = usage."sessionId"
        LEFT JOIN posts AS post
          ON post.id = session."postId"
        LEFT JOIN users AS operator_actor
          ON operator_actor.id = session."operatorId"
        GROUP BY bag.id
      ),
      projected AS (
        SELECT
          bag.id,
          bag.code,
          bag.material,
          bag."batchCode" AS batch,
          bag."createdAt" AS created_at,
          bag.status,
          CASE
            WHEN bag.status = 'consumed'
              AND usage.open_usage_count = 0
              THEN 'consumed'
            WHEN bag.status = 'available'
              AND bag.location = 'warehouse'
              AND usage.open_usage_count = 0
              THEN 'warehouse'
            WHEN bag.status = 'available'
              AND bag.location = 'production'
              AND usage.open_usage_count = 0
              THEN 'production'
            WHEN bag.status = 'in_use'
              AND bag.location = 'production'
              AND usage.open_usage_count = 1
              AND usage.active_assignment_count = 1
              THEN 'post'
            ELSE 'unknown'
          END AS location_kind,
          CASE
            WHEN bag.status = 'in_use'
              AND bag.location = 'production'
              AND usage.open_usage_count = 1
              AND usage.active_assignment_count = 1
              THEN usage.post_code
            ELSE NULL
          END AS post_code,
          CASE
            WHEN bag.status = 'in_use'
              AND bag.location = 'production'
              AND usage.open_usage_count = 1
              AND usage.active_assignment_count = 1
              THEN usage.post_name
            ELSE NULL
          END AS post_name,
          CASE
            WHEN bag.status = 'in_use'
              AND bag.location = 'production'
              AND usage.open_usage_count = 1
              AND usage.active_assignment_count = 1
              THEN usage.operator_name
            ELSE NULL
          END AS operator_name,
          COALESCE(bag."currentKg", bag."lastMeasuredKg", bag."initialKg") AS current_weight_kg,
          bag."priceKopecksPerKg" AS price_kopecks_per_kg
        FROM big_bag_units AS bag
        INNER JOIN open_usage_facts AS usage
          ON usage.big_bag_id = bag.id
        WHERE bag.status IN ('available', 'in_use', 'consumed')
      ),
      filtered AS MATERIALIZED (
        SELECT projected.*
        FROM projected
        CROSS JOIN input
        WHERE (
          input.view = 'all'
          OR (
            projected.status <> 'consumed'
            AND (
              projected.status = 'in_use'
              OR projected.current_weight_kg IS NULL
              OR projected.current_weight_kg > 0
            )
          )
        )
          AND (input.query = '' OR STRPOS(
            TRANSLATE(
              LOWER(CONCAT_WS(
                ' ',
                projected.code,
                projected.material,
                projected.batch,
                projected.status,
                CASE projected.status
                  WHEN 'available' THEN 'доступен доступно'
                  WHEN 'in_use' THEN 'in use'
                  WHEN 'consumed' THEN 'израсходован израсходовано расход'
                END,
                projected.location_kind,
                CASE projected.location_kind
                  WHEN 'warehouse' THEN 'на складе склад'
                  WHEN 'production' THEN 'свободен свободно на производстве производство'
                  WHEN 'post' THEN 'используется занят пост на производстве производство'
                  WHEN 'consumed' THEN 'израсходован израсходовано'
                  WHEN 'unknown' THEN 'статус уточняется местоположение уточняется неизвестно неизвестен'
                END,
                projected.post_code,
                projected.post_name,
                projected.operator_name
              )),
              'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ',
              'абвгдеёжзийклмнопрстуфхцчшщъыьэюя'
            ),
            input.query
          ) > 0)
      ),
      totals AS (
        SELECT COUNT(*)::integer AS total
        FROM filtered
      ),
      page_rows AS (
        SELECT *
        FROM filtered
        ORDER BY code ASC, id ASC
        LIMIT ${pageSize}
        OFFSET ${offset}
      )
      SELECT
        page_rows.id AS "id",
        page_rows.code AS "code",
        page_rows.material AS "material",
        page_rows.batch AS "batch",
        page_rows.created_at AS "createdAt",
        page_rows.status AS "status",
        page_rows.location_kind AS "locationKind",
        page_rows.post_code AS "postCode",
        page_rows.post_name AS "postName",
        page_rows.operator_name AS "operatorName",
        page_rows.current_weight_kg AS "currentWeightKg",
        page_rows.price_kopecks_per_kg AS "priceKopecksPerKg",
        totals.total AS "total"
      FROM totals
      LEFT JOIN page_rows ON TRUE
      ORDER BY page_rows.code ASC NULLS LAST, page_rows.id ASC NULLS LAST
    `);
    return {
      items: rows.map(project).filter((row): row is BigBagRegisterRow => row !== null),
      page,
      pageSize,
      total: rows[0]?.total ?? 0,
    };
  }
}
