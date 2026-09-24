import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

describe('production cancellation integration', () => {
  it('uses idempotent live commands for assignment and machine-change cancellation', () => {
    expect(appSource).toContain('cancelProductionAssignment(');
    expect(appSource).toContain('cancelProductionMachineChange(');
    expect(appSource).toContain('onCancelAssignment={cancelLiveProductionAssignment}');
    expect(appSource).toContain('onCancelMachineChange={cancelLiveProductionMachineChange}');
    expect(appSource).toMatch(
      /productionPlanningGateRef\.current\.start\([\s\S]*?refreshLiveProductionPlanning/u,
    );
  });
});
