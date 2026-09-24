import { Module } from '@nestjs/common';
import { ConfigurablePalletLabelRenderer } from './configurable-pallet-label.renderer';
import { PalletLabelLayoutPublicationService } from './pallet-label-layout-publication.service';

@Module({
  providers: [ConfigurablePalletLabelRenderer, PalletLabelLayoutPublicationService],
  exports: [ConfigurablePalletLabelRenderer, PalletLabelLayoutPublicationService],
})
export class PalletLabelLayoutModule {}
