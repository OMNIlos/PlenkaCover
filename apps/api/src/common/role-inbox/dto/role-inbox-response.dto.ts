import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ROLES } from '@plenka/contracts';
import type {
  Role,
  RoleInboxCtaKind,
  RoleInboxItem,
  RoleInboxOrderInfo,
  RoleInboxSeverity,
} from '@plenka/contracts';

const CTA_KINDS: RoleInboxCtaKind[] = [
  'commercial_order',
  'finance_order',
  'production_order',
  'operator_roll',
  'warehouse_cover',
  'warehouse_intake',
  'director_decision',
  'penalty',
  'production_problem',
  'operator_queue',
  'admin_incident',
];

export class RoleInboxCtaResponseDto {
  @ApiProperty({ enum: CTA_KINDS })
  kind!: RoleInboxCtaKind;

  @ApiProperty()
  targetId!: string;

  @ApiProperty()
  section!: string;
}

export class RoleInboxOrderInfoResponseDto implements RoleInboxOrderInfo {
  @ApiProperty()
  orderNumber!: string;

  @ApiProperty({ minimum: 1 })
  rollCount!: number;

  @ApiProperty({ type: [String], maxItems: 20 })
  rollCodes!: string[];

  @ApiProperty({ minimum: 0 })
  omittedRollCount!: number;
}

export class RoleInboxItemResponseDto implements RoleInboxItem {
  @ApiProperty()
  id!: string;

  @ApiProperty({ type: [String] })
  eventIds!: string[];

  @ApiProperty()
  eventType!: string;

  @ApiProperty({ enum: ROLES })
  recipientRole!: Role;

  @ApiProperty({ enum: ROLES })
  nextOwnerRole!: Role;

  @ApiProperty({ enum: ['info', 'warning', 'critical'] })
  severity!: RoleInboxSeverity;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  body!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty()
  unread!: boolean;

  @ApiProperty({ nullable: true, type: String })
  orderId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  orderNumber!: string | null;

  @ApiPropertyOptional({ type: RoleInboxOrderInfoResponseDto })
  orderInfo?: RoleInboxOrderInfoResponseDto;

  @ApiProperty({ nullable: true, type: String })
  financeOrderId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  caseId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  taskId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  positionId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  rollId!: string | null;

  @ApiProperty({ nullable: true, type: RoleInboxCtaResponseDto })
  cta!: RoleInboxCtaResponseDto | null;
}

export class RoleInboxPageResponseDto {
  @ApiProperty({ type: [RoleInboxItemResponseDto] })
  items!: RoleInboxItemResponseDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;

  @ApiProperty({ minimum: 0 })
  unreadCount!: number;
}

export class RoleInboxReadResponseDto {
  @ApiProperty({ example: true })
  ok!: true;

  @ApiProperty()
  eventId!: string;
}
