import type { PalletLabelLayoutDefinitionV1 } from '@plenka/contracts';
import { LEGACY_PUBLISHED_PALLET_LABEL_LAYOUT } from '../../src/common/pallet-label-layout/pallet-label-layout.validator';

export function rightShiftedCompactPalletLabelLayout(): PalletLabelLayoutDefinitionV1 {
  const layout = structuredClone(LEGACY_PUBLISHED_PALLET_LABEL_LAYOUT);
  const geometry = {
    header: { xDots: 272, yDots: 40, widthDots: 504, heightDots: 32 },
    identity: { xDots: 240, yDots: 88, widthDots: 200, heightDots: 72 },
    product: { xDots: 232, yDots: 168, widthDots: 208, heightDots: 144 },
    rollCodes: { xDots: 280, yDots: 320, widthDots: 160, heightDots: 232 },
    packaging: {
      xDots: 424,
      yDots: 576,
      widthDots: 352,
      heightDots: 48,
      maxFontSize: 11,
    },
    storage: { xDots: 424, yDots: 632, widthDots: 352, heightDots: 144 },
  } as const;

  for (const [id, values] of Object.entries(geometry)) {
    Object.assign(layout.elements.find((element) => element.id === id)!, values);
  }
  return layout;
}
