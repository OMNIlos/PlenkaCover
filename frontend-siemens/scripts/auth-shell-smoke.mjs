import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:5173';
const ROLES = [
  ['коммерция', 'commercial'],
  ['производство', 'production'],
  ['ахметов булат', 'operator'],
  ['склад', 'warehouse'],
  ['бухгалтерия', 'finance'],
  ['директор', 'director'],
  ['админ', 'admin'],
];

const browser = await chromium.launch();
let failed = false;

for (const [loginName, uiRole] of ROLES) {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.locator('.auth-input').first().fill(loginName);
    await page.locator('.auth-input[type="password"]').fill('plenka-dev');
    await page.locator('.auth-button').click();
    await page.waitForURL((url) => url.searchParams.get('role') === uiRole, {
      timeout: 15_000,
    });
    await page.locator('.demo-role-switcher').waitFor({ state: 'detached', timeout: 15_000 });
    await page.locator('.account-button').click();
    await page.locator('.logout-button').waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('.logout-button').click();
    await page.locator('.auth-card').waitFor({ state: 'visible', timeout: 15_000 });
    console.log(`OK  ${loginName} → role=${uiRole}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${loginName}: ${String(error).split('\n')[0]}`);
  } finally {
    await context.close();
  }
}

await browser.close();
process.exit(failed ? 1 : 0);
