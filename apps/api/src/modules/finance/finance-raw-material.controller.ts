import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiProperty,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { FinanceRawMaterialService } from './finance-raw-material.service';

class FinanceRawMaterialDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  material!: string;

  @ApiProperty({ nullable: true })
  supplier!: string | null;

  @ApiProperty({ nullable: true })
  batchCode!: string | null;

  @ApiProperty({ nullable: true })
  receivedAt!: string | null;

  @ApiProperty({ nullable: true })
  initialWeightKg!: string | null;

  @ApiProperty({ nullable: true })
  purchasePricePerKg!: string | null;

  @ApiProperty({ nullable: true })
  initialValue!: string | null;

  @ApiProperty({ nullable: true })
  currentWeightKg!: string | null;

  @ApiProperty({ nullable: true })
  measuredAt!: string | null;

  @ApiProperty({ nullable: true })
  currentValue!: string | null;

  @ApiProperty({ nullable: true })
  consumedWeightKg!: string | null;

  @ApiProperty({ nullable: true })
  consumedValue!: string | null;
}

@ApiTags('finance')
@Controller('finance/raw-materials')
export class FinanceRawMaterialController {
  constructor(private readonly service: FinanceRawMaterialService) {}

  @Get()
  @RequireCapabilities('finance_order:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: FinanceRawMaterialDto, isArray: true })
  @ApiUnprocessableEntityResponse({ description: 'BigBag catalog exceeds safe bounds.' })
  list() {
    return this.service.list();
  }
}
