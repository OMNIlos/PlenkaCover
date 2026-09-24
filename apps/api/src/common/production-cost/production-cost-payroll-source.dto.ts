import { ApiProperty } from '@nestjs/swagger';
import { Exclude, Expose } from 'class-transformer';
import type { ProductionCostPayrollSource } from '@plenka/contracts';

@Exclude()
export class ProductionCostPayrollSourceResponseDto implements ProductionCostPayrollSource {
  @Expose()
  @ApiProperty()
  tariffOrderId!: string;

  @Expose()
  @ApiProperty()
  tariffOrderName!: string;

  @Expose()
  @ApiProperty({ format: 'date' })
  effectiveFrom!: string;

  @Expose()
  @ApiProperty({ type: 'integer', format: 'int32', minimum: 0 })
  rateKopecksPerKg!: number;

  @Expose()
  @ApiProperty()
  basisLabel!: string;
}
