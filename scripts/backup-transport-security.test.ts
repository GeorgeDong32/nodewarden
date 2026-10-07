import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBackupEndpointUrl, type BackupDestinationRecord } from '../src/services/backup-config';
import { createRemoteBackupTransferSession, uploadBackupArchive } from '../src/services/backup-uploader';
import { createDefaultBackupRuntimeState, createDefaultBackupScheduleConfig } from '../shared/backup-schema';

function destination(type: 'webdav' | 's3'): BackupDestinationRecord {
  return {
    id: 'audit', name: 'Audit', type, includeAttachments: true,
    schedule: createDefaultBackupScheduleConfig(), runtime: createDefaultBackupRuntimeState(),
    destination: type === 'webdav'
      ? { baseUrl: 'https://backup.example', username: 'dummy-user', password: 'dummy-password', remotePath: 'vault' }
      : { endpoint: 'https://backup.example', bucket: 'vault', addressingStyle: 'path-style', region: 'auto', accessKeyId: 'dummy-id', secretAccessKey: 'dummy-key', rootPath: '' },
  };
}

test('backup endpoints require HTTPS and reject private literal hosts', () => {
  assert.equal(normalizeBackupEndpointUrl('https://backup.example/', 'Backup'), 'https://backup.example');
  for (const url of ['http://backup.example', 'https://127.0.0.1', 'https://[::1]', 'https://169.254.169.254']) {
    assert.throws(() => normalizeBackupEndpointUrl(url, 'Backup'));
  }
});

for (const type of ['webdav', 's3'] as const) {
  for (const status of [301, 302, 303, 307, 308]) {
    test(`${type} transport rejects HTTP ${status} on every credential-bearing request`, async (t) => {
      const requests: Request[] = [];
      t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(url, init);
        requests.push(request);
        return new Response(null, { status, headers: { Location: 'https://redirect-target.example' } });
      });
      const config = destination(type);
      const session = createRemoteBackupTransferSession(config);
      for (const operation of [
        () => session.putFile('audit.zip', new Uint8Array([1])),
        () => uploadBackupArchive(config, new Uint8Array([1]), 'audit.zip'),
        () => session.list(''), () => session.download('audit.zip'),
        () => session.stat('audit.zip'), () => session.deleteFile('audit.zip'),
      ]) await assert.rejects(operation, new RegExp(`redirect.*${status}`));
      assert.equal(requests.length, 6);
      for (const request of requests) {
        assert.equal(request.redirect, 'manual');
        assert.equal(request.headers.has('Authorization'), true);
      }
    });
  }
}

test('WebDAV PUT remains protected after directory creation succeeds', async (t) => {
  const requests: Request[] = [];
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(url, init);
    requests.push(request);
    if (request.method === 'MKCOL') return new Response(null, { status: 201 });
    return new Response(null, { status: 307, headers: { Location: 'https://redirect-target.example' } });
  });
  const config = destination('webdav');
  await assert.rejects(() => createRemoteBackupTransferSession(config).putFile('audit.zip', new Uint8Array([1])), /redirect/);
  await assert.rejects(() => uploadBackupArchive(config, new Uint8Array([1]), 'audit.zip'), /redirect/);
  assert.deepEqual(requests.map((request) => request.method), ['MKCOL', 'PUT', 'MKCOL', 'PUT']);
  assert.ok(requests.every((request) => request.redirect === 'manual'));
});
