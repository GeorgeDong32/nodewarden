import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Execute the real lifecycle handlers with state setters, without a DOM/server.
// This catches retained secrets in the long-lived App, not browser autofill.
const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../webapp/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const app = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'App');
assert.ok(app?.body);
const handlerNames = ['clearAuthenticationSecrets', 'finalizeLogin', 'handleRegister', 'lockCurrentSession', 'logoutNow'];
const handlers = app.body.statements.filter((node) => ts.isFunctionDeclaration(node) && handlerNames.includes(node.name?.text || ''));
const code = ts.transpileModule(handlers.map((node) => node.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

function createHarness() {
  const state: Record<string, any> = {
    loginValues: { email: 'audit@example.test', password: 'dummy-master-password' },
    registerValues: { email: 'audit@example.test', name: 'Audit', password: 'dummy-master-password', password2: 'dummy-master-password' },
    recoverValues: { email: 'audit@example.test', password: 'dummy-master-password', recoveryCode: 'dummy-recovery' },
    unlockPassword: 'dummy-unlock', passkeyPassword: 'dummy-passkey', disableTotpPassword: 'dummy-disable',
    totpCode: '123456', pendingTotp: { masterPasswordHash: 'dummy-proof' },
    pendingTotpMode: 'login', pendingPasskeyPassword: { token: 'dummy-token' },
    session: { accessToken: 'old-token', email: 'audit@example.test', symEncKey: 'dummy-key', symMacKey: 'dummy-mac' },
    profile: {}, phase: 'app', decryptedFolders: [], decryptedCiphers: [], decryptedSends: [],
  };
  const context: Record<string, any> = {
    ...state, IS_DEMO_MODE: false, pendingAuthAction: null, defaultKdfIterations: 600000,
    location: '/login', sessionRef: { current: state.session },
    loginScopedBackupRepairAuthRef: { current: { accessToken: 'old-token', masterPasswordHash: 'old-proof' } },
    performRegistration: async () => ({ ok: true }), revokeCurrentSession: async () => {},
    stripProfileSecrets: (profile: unknown) => profile, t: (value: string) => value,
  };
  for (const name of [...Object.keys(state), 'pendingAuthAction', 'unlockPreparing', 'lockedSessionRefreshError', 'disableTotpOpen', 'confirm']) {
    context[`set${name[0].toUpperCase()}${name.slice(1)}`] = (value: any) => {
      state[name] = typeof value === 'function' ? value(state[name]) : value;
      context[name] = state[name];
      if (name === 'session') context.sessionRef.current = state.session;
    };
  }
  for (const name of ['clearProfileSnapshot', 'clearOfflineUnlockRecord', 'clearPasswordSecurityCache', 'navigate', 'pushToast']) context[name] = () => {};
  const actions = runInNewContext(`${code}\n({ finalizeLogin, handleRegister, lockCurrentSession, logoutNow });`, context);
  return { state, context, actions };
}

function assertSecretsCleared(state: Record<string, any>) {
  for (const [name, fields] of Object.entries({ loginValues: ['password'], registerValues: ['password', 'password2'], recoverValues: ['password', 'recoveryCode'] })) {
    for (const field of fields) assert.equal(state[name][field], '', `${name}.${field} retained`);
  }
  for (const name of ['unlockPassword', 'passkeyPassword', 'disableTotpPassword', 'totpCode']) assert.equal(state[name], '', `${name} retained`);
  for (const name of ['pendingTotp', 'pendingTotpMode', 'pendingPasskeyPassword']) assert.equal(state[name], null, `${name} retained`);
  assert.equal(state.loginValues.email, 'audit@example.test');
}

test('completed login clears form secrets and retains only the new backup repair proof', async () => {
  const { actions, state, context } = createHarness();
  await actions.finalizeLogin({ session: { accessToken: 'new-token' }, profile: {}, profilePromise: Promise.resolve({}), freshMasterPasswordHash: 'new-proof' });
  assertSecretsCleared(state);
  assert.equal(state.phase, 'app');
  assert.equal(context.loginScopedBackupRepairAuthRef.current.masterPasswordHash, 'new-proof');
  assert.equal(context.loginScopedBackupRepairAuthRef.current.accessToken, 'new-token');
});

test('successful registration does not leave either master password in the registration form', async () => {
  const { actions, state, context } = createHarness();
  await actions.handleRegister();
  assertSecretsCleared(state);
  assert.equal(state.phase, 'login');
  assert.equal(context.loginScopedBackupRepairAuthRef.current, null);
});

test('locking clears form secrets and the old verification proof as well as session keys', () => {
  const { actions, state, context } = createHarness();
  actions.lockCurrentSession();
  assertSecretsCleared(state);
  assert.equal(state.phase, 'locked');
  assert.equal(state.session.symEncKey, undefined);
  assert.equal(state.session.symMacKey, undefined);
  assert.equal(context.loginScopedBackupRepairAuthRef.current, null);
});

test('logout cannot refill the login or registration forms with the previous password', () => {
  const { actions, state, context } = createHarness();
  actions.logoutNow();
  assertSecretsCleared(state);
  assert.equal(state.session, null);
  assert.equal(state.phase, 'login');
  assert.equal(context.loginScopedBackupRepairAuthRef.current, null);
});
