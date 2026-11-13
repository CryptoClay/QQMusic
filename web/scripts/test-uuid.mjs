import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
const source = stripTypeScriptTypes(
  (await readFile(new URL('../src/lib/uuid.ts', import.meta.url), 'utf8')).replace(/export /g, ''),
);
function uuid(crypto) {
  return vm.runInNewContext(source + ';newUuid();', { crypto });
}
test('HTTP LAN origins without randomUUID get an RFC v4 identifier accepted by command API', () => {
  assert.equal(
    uuid({
      getRandomValues(bytes) {
        bytes.forEach((_, i) => (bytes[i] = i));
        return bytes;
      },
    }),
    '00010203-0405-4607-8809-0a0b0c0d0e0f',
  );
});
test('native UUID is retained and old browsers do not crash app initialization', () => {
  assert.equal(uuid({ randomUUID: () => 'native-uuid' }), 'native-uuid');
  assert.match(uuid(undefined), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
