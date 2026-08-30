const fs = require('node:fs');
const assert = require('node:assert/strict');
const read = (p) => fs.readFileSync(p, 'utf8');

const render = read('render.yaml');
assert.ok(render.includes('MFA_ENCRYPTION_KEY'), 'Render must declare MFA_ENCRYPTION_KEY');
assert.equal((render.match(/branch: continuixai-ops-completion/g) || []).length, 2, 'Render services must deploy the reviewed release branch');

for (const file of ['docker-compose.yml','docker-compose.prod.yml']) {
  const src = read(file);
  assert.ok(src.includes('continuixai_ops'), `${file} must use Continuixai database defaults`);
  const legacy = ['s','t','a','s','h'].join('');
  assert.ok(!new RegExp(`\\b${legacy}(?:_|-|\\b)`, 'i').test(src), `${file} must not contain inherited identifiers`);
}

const tasks = read('apps/api/src/routes/tasks.ts');
assert.ok(tasks.includes('idempotencyKey: parsed.data.idempotencyKey'), 'one-time assignments must persist idempotency key');
assert.ok(tasks.includes('organizationId_idempotencyKey'), 'one-time retries must query tenant-scoped idempotency key');
assert.ok(tasks.includes('siteMemberships: { some: { siteId: context.site.id, isActive: true } }'), 'employee listing must be site scoped');
assert.ok(tasks.includes('skipped: skippedTasks'), 'daily summary must expose skipped tasks');


const workflow = read('apps/api/src/lib/taskWorkflow.ts');
assert.ok(!workflow.includes('jobTitle: string;'), 'task snapshot jobTitle must retain the Prisma JobTitle enum type');
assert.ok(tasks.includes('app.patch("/users/:id/job-title"') && tasks.includes('siteMemberships: { where: { siteId: context.site.id, isActive: true }'), 'job-title mutation must select site membership before checking it');

const auth = read('apps/web/lib/auth-context.tsx');
assert.ok(!auth.includes('clearCountQueue'), 'auth invalidation must not clear unsynced Count queue');
assert.ok(auth.includes('have not synced yet'), 'auth invalidation must warn about unsynced Count work');

const team = read('apps/web/app/team-work/page.tsx');
assert.ok(team.includes('Assigned to<select'), 'Team Work must expose reassignment control');
assert.ok(!team.includes('function todayKey'), 'Team Work must not seed site dates from browser UTC');

const index = read('apps/api/src/index.ts');
assert.ok(index.includes('ENABLE_LEGACY_INVENTORY_FEATURES'), 'legacy API surface must be feature gated');
assert.ok(index.includes('if (legacyInventoryFeaturesEnabled)'), 'legacy API registrations must be disabled by default');

const proxy = read('apps/web/proxy.ts');
for (const legacy of ['/items','/labels','/scan','/settings/integrations']) assert.ok(proxy.includes(`"${legacy}"`), `legacy web route ${legacy} must be redirected`);

for (const script of ['scripts/test-task-workflow-pure.cjs','scripts/test-task-schedule-pure.cjs','scripts/test-task-presentation-pure.cjs','scripts/test-starter-task-catalog.cjs','scripts/transpile-check.cjs']) {
  const src = read(script);
  assert.ok(src.includes("require('typescript')"), `${script} must resolve TypeScript portably`);
  assert.ok(!src.includes('/opt/nvm/'), `${script} must not hardcode a local TypeScript path`);
}


const queue = read('apps/web/lib/storeCountQueue.ts');
assert.ok(queue.includes('ownerUserId: string'), 'Count queue must bind scans to the originating user');
assert.ok(queue.includes('LEGACY_QUEUE_KEY') && queue.includes('localStorage.removeItem(LEGACY_QUEUE_KEY)'), 'Count queue must migrate the pre-rebrand queue key instead of stranding unsynced work');
const countPage = read('apps/web/app/store-count/page.tsx');
assert.ok(countPage.includes('getPendingCountQueue(user.id)'), 'Count replay must filter queued scans by current user');
assert.ok(countPage.includes('ownerUserId: user.id'), 'new queued Count scans must record current user');

const schema = read('apps/api/prisma/schema.prisma');
assert.ok(schema.includes('idempotencyKey String?') && schema.includes('@@unique([organizationId, idempotencyKey])'), 'TaskAssignment must have a unique idempotency key');
assert.ok(schema.includes('model SiteMembership {'), 'site-scoped membership model must exist');
assert.ok(fs.existsSync('apps/api/prisma/migrations/20260907000000_task_assignment_idempotency/migration.sql'), 'idempotency migration missing');
assert.ok(fs.existsSync('apps/api/prisma/migrations/20260908000000_site_membership/migration.sql'), 'site membership migration missing');

const ci = read('.github/workflows/ci.yml');
const legacyCiDb = ['store','scan'].join('_');
assert.ok(!ci.includes(legacyCiDb), 'CI database identifiers must use Continuixai naming');

console.log('Claude Round 1 remediation source contracts passed');
