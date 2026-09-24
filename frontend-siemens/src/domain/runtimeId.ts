let runtimeIdSequence = 0;

export function runtimeId(prefix: string) {
  runtimeIdSequence = (runtimeIdSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now().toString(36)}-${runtimeIdSequence.toString(36)}`;
}
