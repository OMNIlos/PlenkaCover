const PILOT_AGENT_TOKEN_PREFIX = 'ptk_';
const BASE64URL_PAYLOAD = /^[A-Za-z0-9_-]+$/u;
const MIN_PILOT_TOKEN_BYTES = 32;
const MIN_PAYLOAD_SHANNON_ENTROPY = 3.5;

/** Formats exactly 32 random bytes as the canonical pilot credential shared by API and agent. */
export function createCanonicalPilotAgentToken(random: Uint8Array): string {
  if (random.byteLength !== MIN_PILOT_TOKEN_BYTES) {
    throw new Error(`pilot agent token requires exactly ${MIN_PILOT_TOKEN_BYTES} random bytes`);
  }
  const token = `${PILOT_AGENT_TOKEN_PREFIX}${Buffer.from(random).toString('base64url')}`;
  if (!isCanonicalPilotAgentToken(token)) {
    throw new Error('pilot agent token randomness does not satisfy the canonical policy');
  }
  return token;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const symbol of value) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  return [...counts.values()].reduce((entropy, count) => {
    const probability = count / value.length;
    return entropy - probability * Math.log2(probability);
  }, 0);
}

function hasExactRepeatedBlock(value: string): boolean {
  const prefixLengths = new Array<number>(value.length).fill(0);
  for (let index = 1; index < value.length; index += 1) {
    let candidateLength = prefixLengths[index - 1];
    while (candidateLength > 0 && value[index] !== value[candidateLength]) {
      candidateLength = prefixLengths[candidateLength - 1];
    }
    if (value[index] === value[candidateLength]) candidateLength += 1;
    prefixLengths[index] = candidateLength;
  }
  const period = value.length - (prefixLengths.at(-1) ?? 0);
  return period < value.length && value.length % period === 0;
}

/** Pilot gateway credential boundary. Never logs or returns any part of the supplied secret. */
export function isCanonicalPilotAgentToken(token: string): boolean {
  if (!token.startsWith(PILOT_AGENT_TOKEN_PREFIX)) return false;
  const payload = token.slice(PILOT_AGENT_TOKEN_PREFIX.length);
  if (!payload || !BASE64URL_PAYLOAD.test(payload)) return false;

  const decoded = Buffer.from(payload, 'base64url');
  return (
    decoded.length >= MIN_PILOT_TOKEN_BYTES &&
    decoded.toString('base64url') === payload &&
    shannonEntropy(payload) >= MIN_PAYLOAD_SHANNON_ENTROPY &&
    !hasExactRepeatedBlock(payload)
  );
}
