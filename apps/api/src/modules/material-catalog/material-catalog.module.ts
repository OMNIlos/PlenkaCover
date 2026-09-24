import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MaterialCatalogController } from './material-catalog.controller';
import { MaterialCatalogService } from './material-catalog.service';
import { RecipeCatalogController } from './recipe-catalog.controller';
import { RecipeCatalogService } from './recipe-catalog.service';
import { OneCNomenclatureController } from './onec-nomenclature.controller';
import { OneCNomenclatureService } from './onec-nomenclature.service';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [MaterialCatalogController, OneCNomenclatureController, RecipeCatalogController],
  providers: [MaterialCatalogService, OneCNomenclatureService, RecipeCatalogService],
  exports: [MaterialCatalogService, OneCNomenclatureService, RecipeCatalogService],
})
export class MaterialCatalogModule {}
