import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

test('backup transport works in workerd and rejects redirects without following them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nodewarden-backup-workerd-'));
  try {
    await build({
      stdin: {
        resolveDir: root,
        loader: 'ts',
        contents: `
          import { createRemoteBackupTransferSession, uploadBackupArchive } from './src/services/backup-uploader';
          import { createDefaultBackupRuntimeState, createDefaultBackupScheduleConfig } from './shared/backup-schema';

          async function check(type) {
            for (const status of [200, 301, 302, 303, 307, 308]) {
              const endpoint = 'https://status-' + status + '.example';
              const config = {
                id: 'test', name: 'Test', type, includeAttachments: true,
                schedule: createDefaultBackupScheduleConfig(), runtime: createDefaultBackupRuntimeState(),
                destination: type === 'webdav'
                  ? { baseUrl: endpoint, username: 'dummy-user', password: 'dummy-password', remotePath: 'vault' }
                  : { endpoint, bucket: 'vault', addressingStyle: 'path-style', region: 'auto', accessKeyId: 'dummy-id', secretAccessKey: 'dummy-key', rootPath: '' },
              };
              const session = createRemoteBackupTransferSession(config);
              const operations = {
                put: () => session.putFile('test.zip', new Uint8Array([1])),
                archive: () => uploadBackupArchive(config, new Uint8Array([1]), 'test.zip'),
                list: () => session.list(''),
                download: () => session.download('test.zip'),
                stat: () => session.stat('test.zip'),
                delete: () => session.deleteFile('test.zip'),
              };
              for (const [name, operation] of Object.entries(operations)) {
                if (status === 200) {
                  await operation();
                  continue;
                }
                let rejected = false;
                try { await operation(); } catch (error) {
                  if (!String(error.message).includes('redirect') || !String(error.message).includes(String(status))) throw error;
                  rejected = true;
                }
                if (!rejected) throw new Error(type + ' ' + name + ' followed or accepted redirect ' + status);
              }
            }
          }
          export const webdav = { test: () => check('webdav') };
          export const s3 = { test: () => check('s3') };
        `,
      },
      bundle: true, format: 'esm', platform: 'browser', outfile: join(dir, 'worker.js'),
    });
    await writeFile(join(dir, 'remote.js'), `
      export default {
        async fetch(request) {
          await request.arrayBuffer();
          const url = new URL(request.url);
          const status = Number(/^status-(\\d+)\\.example$/.exec(url.hostname)?.[1]);
          if (!status) throw new Error('Backup request followed a redirect to another host');
          if (!request.headers.has('Authorization')) throw new Error('Missing test authorization');
          if (status !== 200) return new Response(null, { status, headers: { Location: 'https://redirect-target.example' } });
          if (request.method === 'HEAD' || request.method === 'DELETE') return new Response(null, { status: 200 });
          if (request.method === 'MKCOL') return new Response(null, { status: 201 });
          if (request.method === 'PUT') return new Response(null, { status: 201 });
          if (request.method === 'PROPFIND') return new Response('<d:multistatus xmlns:d="DAV:"/>', { status: 207 });
          if (url.searchParams.has('list-type')) return new Response('<ListBucketResult/>');
          return new Response('test');
        },
      };
    `);
    await writeFile(join(dir, 'config.capnp'), `
      using Workerd = import "/workerd/workerd.capnp";
      const config :Workerd.Config = (
        services = [
          (name = "backup", worker = (
            modules = [(name = "worker.js", esModule = embed "worker.js")],
            compatibilityDate = "2024-01-01", globalOutbound = "remote"
          )),
          (name = "remote", worker = (
            modules = [(name = "remote.js", esModule = embed "remote.js")],
            compatibilityDate = "2024-01-01"
          ))
        ]
      );
    `);
    const result = spawnSync(require.resolve('workerd/bin/workerd'), [
      'test', '-I', join(root, 'node_modules'), join(dir, 'config.capnp'), 'backup',
    ], { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
    assert.equal(result.error, undefined, String(result.error || '') + result.stdout + result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
