import { expect, test as setup } from '@playwright/test';

/**
 * Sign-in for the end-to-end tests (ADR 0022) through the real flow: /api/auth/login → the fake
 * identity provider (APP_ENV=test only) → /api/auth/callback. The administrator was bootstrapped
 * once by apps/api/scripts/start-e2e-server.mjs; it creates the e2e operator through the user
 * administration API, as an administrator would.
 */
export const ADMIN_STATE = 'e2e/.auth/admin.json';
export const OPERATOR_STATE = 'e2e/.auth/operator.json';
export const OPERATOR_EMAIL = 'e2e-operator@ayvo.test';

setup('sign in the administrator and the operator', async ({ browser }) => {
  const admin = await browser.newContext();
  const adminPage = await admin.newPage();
  await adminPage.goto('/api/auth/login?next=/admin/users&login_hint=e2e-admin@ayvo.test');
  await expect(adminPage).toHaveURL(/\/admin\/users$/);
  await admin.storageState({ path: ADMIN_STATE });

  const created = await adminPage.request.post('/api/admin/identity/users', {
    data: {
      email: OPERATOR_EMAIL,
      displayName: 'E2E Operátor',
      roles: ['WAREHOUSE_SUPERVISOR', 'PRODUCTION_SUPERVISOR'],
      warehouseCodes: ['MAIN'],
      reason: 'end-to-end test operator',
    },
  });
  expect(created.status()).toBe(201);
  await admin.close();

  const operator = await browser.newContext();
  const operatorPage = await operator.newPage();
  await operatorPage.goto(`/api/auth/login?next=/&login_hint=${OPERATOR_EMAIL}`);
  await expect(operatorPage.getByTestId('current-user')).toHaveText('E2E Operátor');
  await operator.storageState({ path: OPERATOR_STATE });
  await operator.close();
});
