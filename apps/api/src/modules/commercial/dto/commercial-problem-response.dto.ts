import { ApiProperty } from '@nestjs/swagger';
import {
  ROLES,
  type CommercialProblemListItem,
  type CommercialProblemPage,
  type Role,
} from '@plenka/contracts';

export class CommercialProblemListItemResponseDto implements CommercialProblemListItem {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  orderId!: string;

  @ApiProperty()
  orderNumber!: string;

  @ApiProperty({ type: String, nullable: true })
  orderTitle!: string | null;

  @ApiProperty({ type: String, nullable: true })
  positionId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  positionFilmType!: string | null;

  @ApiProperty()
  type!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ type: String, nullable: true })
  recovery!: string | null;

  @ApiProperty({ enum: ROLES })
  reportedByRole!: Role;

  @ApiProperty({ enum: ROLES, nullable: true })
  ownerRole!: Role | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  resolvedAt!: string | null;
}

export class CommercialProblemPageResponseDto implements CommercialProblemPage {
  @ApiProperty({ type: CommercialProblemListItemResponseDto, isArray: true })
  items!: CommercialProblemListItem[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}
