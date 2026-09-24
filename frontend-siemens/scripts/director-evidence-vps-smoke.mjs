const requiredEnvironment = [
  'PLENKA_VPS_ORIGIN',
  'DIRECTOR_LOGIN',
  'DIRECTOR_PASSWORD',
  'OPERATOR_1_LOGIN',
  'OPERATOR_1_PASSWORD',
];

const missingEnvironment = requiredEnvironment.filter(
  (name) => !process.env[name]?.trim(),
);
if (missingEnvironment.length > 0) {
  throw new Error(`Missing required environment: ${missingEnvironment.join(', ')}`);
}

const origin = new URL(process.env.PLENKA_VPS_ORIGIN);
if (
  !['http:', 'https:'].includes(origin.protocol) ||
  origin.username ||
  origin.password ||
  origin.search ||
  origin.hash
) {
  throw new Error('PLENKA_VPS_ORIGIN must be an HTTP(S) origin without credentials or query');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function endpoint(pathname) {
  return new URL(pathname, origin).toString();
}

async function login(label, loginValue, password) {
  const response = await fetch(endpoint('/api/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: loginValue, password }),
  });
  if (!response.ok) throw new Error(`${label} login failed with HTTP ${response.status}`);
  const payload = await response.json().catch(() => null);
  assert(typeof payload?.token === 'string' && payload.token, `${label} login returned no token`);
  return payload.token;
}

async function requestEvidence(pathname, token) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const query = new URLSearchParams({
    from: `${today.slice(0, 8)}01`,
    to: today,
    bucket: 'day',
    limit: '1',
  });
  return fetch(endpoint(`${pathname}?${query}`), {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function assertDirectorPage(pathname, token) {
  const response = await requestEvidence(pathname, token);
  assert(response.ok, `${pathname} returned HTTP ${response.status} for Director`);
  const payload = await response.json().catch(() => null);
  assert(Array.isArray(payload?.items), `${pathname} returned no items array`);
  assert(
    payload.nextCursor === null || typeof payload.nextCursor === 'string',
    `${pathname} returned an invalid nextCursor`,
  );
}

async function assertOperatorDenied(pathname, token) {
  const response = await requestEvidence(pathname, token);
  assert(
    response.status === 403,
    `${pathname} returned HTTP ${response.status} for non-Director, expected 403`,
  );
}

const directorToken = await login(
  'Director',
  process.env.DIRECTOR_LOGIN,
  process.env.DIRECTOR_PASSWORD,
);
const operatorToken = await login(
  'Operator',
  process.env.OPERATOR_1_LOGIN,
  process.env.OPERATOR_1_PASSWORD,
);
const evidencePaths = [
  '/api/director/analytics/shift-balances',
  '/api/director/analytics/big-bags',
];

for (const pathname of evidencePaths) {
  await assertDirectorPage(pathname, directorToken);
  await assertOperatorDenied(pathname, operatorToken);
}

console.log('PASS director evidence VPS: Director pages available; non-Director denied');
