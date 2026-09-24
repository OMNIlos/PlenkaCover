import { createHash } from 'node:crypto';
import { PALLET_LABEL_ASSETS } from './pallet-label.assets';

const sha256 = (dataUri: string): string =>
  createHash('sha256')
    .update(Buffer.from(dataUri.split(',')[1], 'base64'))
    .digest('hex');

describe('PALLET_LABEL_ASSETS', () => {
  it('contains only the seven unique source images from one XLS half', () => {
    expect(
      Object.fromEntries(
        (Object.keys(PALLET_LABEL_ASSETS) as Array<keyof typeof PALLET_LABEL_ASSETS>).map((key) => [
          key,
          sha256(PALLET_LABEL_ASSETS[key].dataUri),
        ]),
      ),
    ).toEqual({
      certification: '946d6daa12d574404381eba7fb654b527407b249522eb31ee140025883492897',
      logo: 'a7e8df9be33af44d2d691c1201e6e1d54c053831948ab00af2adac2f4626561b',
      handling1: '3a6f7d07953415ae07d82673eba98369a37c716f21bbdf12c1a8e799464cd833',
      handling2: '8eacc45f1ba1bcf7dda66d74e6fe306b35c42b99404814e3e436356db7b42405',
      handling3: '44113706bdeac84acf9766000f370ece99b43d53f50b063ea0e3e461c9d09fbf',
      handling4: 'c8285bdeb8124d2acba89c87b52dc3c95416eccba3bd868ff029ae4f2a9c4fa1',
      handling5: '9d12da52915339e8ec5388bf5d541f13cf07e6d400293a83b23808960c901767',
    });
    expect(Object.keys(PALLET_LABEL_ASSETS)).toHaveLength(7);
  });
});
