import { registeredProductionBigBagSeed } from './bigbag-seed';

describe('registeredProductionBigBagSeed', () => {
  it('builds an opaque identity for a pre-staged test bag', () => {
    const seed = registeredProductionBigBagSeed();

    expect(seed).toEqual({
      registrationStatus: 'registered',
      location: 'production',
      locationRevision: 1,
      scanToken: {
        create: {
          token: expect.stringMatching(/^bbt_[0-9a-f]{64}$/u),
        },
      },
    });
  });

  it('does not reuse an opaque identity across new bags', () => {
    const identities = new Set(
      Array.from({ length: 3 }, () => registeredProductionBigBagSeed().scanToken.create.token),
    );

    expect(identities.size).toBe(3);
  });
});
