const fs = require('fs');
const assert = require('assert');

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

const auth = read('apps/web/lib/auth-context.tsx');
const proxy = read('apps/web/proxy.ts');

assert.ok(!auth.includes('CLEAR_USER_DATA'), 'dead CLEAR_USER_DATA service-worker postMessage must be removed');
assert.ok(proxy.includes('"/i"'), 'legacy /i deep links must be redirected directly by proxy');

console.log('Claude Round 2 cleanup contracts passed');
