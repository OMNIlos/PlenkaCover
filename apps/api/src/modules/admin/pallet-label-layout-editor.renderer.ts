import { Injectable } from '@nestjs/common';
import type { PalletLabelLayoutDefinitionV2, PalletLabelSnapshot } from '@plenka/contracts';
import {
  ConfigurablePalletLabelRenderer,
  PALLET_LABEL_LAYOUT_PREVIEW_TOKEN,
} from '../../common/pallet-label-layout/configurable-pallet-label.renderer';

@Injectable()
export class PalletLabelLayoutEditorRenderer {
  constructor(
    private readonly renderer: ConfigurablePalletLabelRenderer = new ConfigurablePalletLabelRenderer(),
  ) {}

  renderSvg(label: PalletLabelSnapshot, layout: PalletLabelLayoutDefinitionV2): string {
    return this.renderer.renderSvg(label, layout, {
      qrToken: PALLET_LABEL_LAYOUT_PREVIEW_TOKEN,
      watermark: true,
    });
  }

  render(label: PalletLabelSnapshot, layout: PalletLabelLayoutDefinitionV2): Buffer {
    return this.renderer.render(label, layout, {
      qrToken: PALLET_LABEL_LAYOUT_PREVIEW_TOKEN,
      watermark: true,
    });
  }
}

export { PALLET_LABEL_LAYOUT_PREVIEW_TOKEN };
