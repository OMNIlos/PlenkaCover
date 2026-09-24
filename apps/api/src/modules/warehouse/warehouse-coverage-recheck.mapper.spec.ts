import {
  canonicalizeWarehouseCoverageCorrectionCommand,
  mapWarehouseCoverageCorrection,
} from './warehouse-coverage-recheck.mapper';

describe('warehouse coverage recheck correction mapper', () => {
  const ownerCounterpartyId = 'counterparty-2';
  const recipeDefinitionId = 'recipe-definition-1';
  const recipeDefinitionVersionId = 'recipe-definition-version-7';
  const lockedContext = {
    rollId: 'roll-1',
    rollCode: 'ROLL-001',
    sourceOrderId: 'order-1',
    sourcePositionId: 'position-1',
    currentOwnerCounterpartyId: 'counterparty-1',
    currentSpec: null,
  };
  const publicCorrection = {
    membershipId: 'membership-1',
    expectedFactVersion: 1,
    ownerCounterpartyId,
    spec: {
      filmType: ' Плёнка   полиэтиленовая ',
      actualThickness: '80 мкм',
      accountingThickness: '80',
      widthMm: 1700,
      plannedLengthM: 275,
      birka: ' Полотно ',
      spoolType: 'Шпуля 76 мм',
      actualWeightKg: '275 кг',
      plannedWeightKg: '275',
      recipeId: null,
      recipeVersion: 'v7',
      recipeDefinitionId,
      recipeDefinitionVersionId,
      recipeVersionNumber: 7,
      ingredients: [
        { rawMaterialDefinitionId: 'raw-b', shareBasisPoints: 4_000 },
        { rawMaterialDefinitionId: 'raw-a', shareBasisPoints: 6_000 },
      ],
    },
  };

  it('maps public text and decimal values to the one canonical internal fact shape', () => {
    const command = canonicalizeWarehouseCoverageCorrectionCommand(publicCorrection);

    expect(JSON.stringify(command)).not.toMatch(
      /rollId|rollCode|sourceOrderId|sourcePositionId|policyVersion/u,
    );
    expect(mapWarehouseCoverageCorrection(command, lockedContext, ' Проверено ')).toEqual({
      rollId: lockedContext.rollId,
      expectedFactVersion: 1,
      reason: 'Проверено',
      nextSpec: {
        rollCode: lockedContext.rollCode,
        sourceOrderId: lockedContext.sourceOrderId,
        sourcePositionId: lockedContext.sourcePositionId,
        ownerCounterpartyId,
        filmType: 'пленка полиэтиленовая',
        actualThicknessMilliMicron: 80_000,
        accountingThicknessMilliMicron: 80_000,
        widthMilliMm: 1_700_000,
        plannedLengthMilliM: 275_000,
        birka: 'полотно',
        spoolType: '76 мм',
        actualWeightMilliKg: 275_000,
        plannedWeightMilliKg: 275_000,
        recipeId: null,
        recipeVersion: 'v7',
        recipeDefinitionId,
        recipeDefinitionVersionId,
        recipeVersionNumber: 7,
        ingredients: [
          { rawMaterialDefinitionId: 'raw-a', shareBasisPoints: 6_000 },
          { rawMaterialDefinitionId: 'raw-b', shareBasisPoints: 4_000 },
        ],
        policyVersion: 'warehouse-coverage-policy/v2',
      },
    });
    expect(JSON.stringify(publicCorrection)).not.toMatch(
      /sourceOrderId|sourcePositionId|policyVersion/u,
    );
  });

  it('merges an owner-only correction from the locked current complete fact', () => {
    const fullCurrentSpec = {
      ...mapWarehouseCoverageCorrection(
        canonicalizeWarehouseCoverageCorrectionCommand(publicCorrection),
        lockedContext,
        'Проверено',
      ).nextSpec,
      ownerCounterpartyId: 'counterparty-1',
    };
    const command = canonicalizeWarehouseCoverageCorrectionCommand({
      membershipId: 'membership-1',
      expectedFactVersion: 1,
      ownerCounterpartyId,
    });

    expect(
      mapWarehouseCoverageCorrection(
        command,
        { ...lockedContext, currentSpec: fullCurrentSpec },
        'Проверено',
      ).nextSpec,
    ).toEqual({
      ...fullCurrentSpec,
      rollCode: lockedContext.rollCode,
      sourceOrderId: lockedContext.sourceOrderId,
      sourcePositionId: lockedContext.sourcePositionId,
      ownerCounterpartyId,
    });
  });

  it('rejects an empty patch and owner-only correction without a locked complete fact', () => {
    expect(() =>
      canonicalizeWarehouseCoverageCorrectionCommand({
        membershipId: 'membership-1',
        expectedFactVersion: 1,
      } as never),
    ).toThrow('owner or spec correction required');
    const ownerOnly = canonicalizeWarehouseCoverageCorrectionCommand({
      membershipId: 'membership-1',
      expectedFactVersion: 1,
      ownerCounterpartyId,
    });
    expect(() => mapWarehouseCoverageCorrection(ownerOnly, lockedContext, 'Проверено')).toThrow(
      'full specification required',
    );
  });
});
