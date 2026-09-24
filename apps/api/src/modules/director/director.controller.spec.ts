import { DirectorController } from './director.controller';

describe('DirectorController production problems projection', () => {
  it('returns the shared production projection without filtering or remapping it', async () => {
    const projected = [
      {
        id: 'problem-1',
        defectWeightKg: 42.6,
        defectWeightSource: 'operator_scale',
      },
    ];
    const production = {
      listProblems: jest.fn().mockResolvedValue(projected),
    };
    const controller = new DirectorController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      production as never,
    );

    await expect(controller.problems()).resolves.toBe(projected);
    expect(production.listProblems).toHaveBeenCalledWith();
  });
});
