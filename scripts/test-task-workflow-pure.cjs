const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript');

const sourcePath = path.resolve(__dirname, '../apps/api/src/lib/taskWorkflow.ts');
if (!fs.existsSync(sourcePath)) throw new Error('taskWorkflow.ts does not exist yet');
const source = fs.readFileSync(sourcePath, 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const cjsModule = { exports: {} };
vm.runInNewContext(`(function(exports, require, module){${output}\n})(module.exports, require, module);`, { module: cjsModule, require, console, Date, Intl, Object, Math, RegExp });
const { taskSnapshotData, reportDateRange, isScheduledBefore } = cjsModule.exports;

const template = {
  id: 'tpl-1', organizationId: 'org-1', siteId: null, jobTitle: 'RECEIVER', title: 'Review expected deliveries',
  instructions: 'Check dock schedule', recurrence: 'DAILY', priority: 'HIGH', rolloverPolicy: 'REMAIN_OVERDUE', dueTime: '08:30'
};
const scheduledDate = new Date('2026-08-28T00:00:00.000Z');
const dueAt = new Date('2026-08-28T12:30:00.000Z');
const snapshot = taskSnapshotData(template, 'site-1', 'user-1', scheduledDate, dueAt);
assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), {
  templateId: 'tpl-1', organizationId: 'org-1', siteId: 'site-1', assignedToId: 'user-1',
  jobTitle: 'RECEIVER', title: 'Review expected deliveries', instructions: 'Check dock schedule', recurrence: 'DAILY',
  scheduledDate: '2026-08-28T00:00:00.000Z', dueAt: '2026-08-28T12:30:00.000Z', priority: 'HIGH', rolloverPolicy: 'REMAIN_OVERDUE'
});

assert.equal(isScheduledBefore(new Date('2026-08-27T00:00:00Z'), new Date('2026-08-28T00:00:00Z')), true);
assert.equal(isScheduledBefore(new Date('2026-08-28T00:00:00Z'), new Date('2026-08-28T00:00:00Z')), false);

assert.deepEqual(JSON.parse(JSON.stringify(reportDateRange('DAILY', scheduledDate))), {
  start: '2026-08-28T00:00:00.000Z', end: '2026-08-28T00:00:00.000Z'
});
assert.deepEqual(JSON.parse(JSON.stringify(reportDateRange('WEEKLY', new Date('2026-08-27T00:00:00Z')))), {
  start: '2026-08-24T00:00:00.000Z', end: '2026-08-30T00:00:00.000Z'
});
assert.deepEqual(JSON.parse(JSON.stringify(reportDateRange('MONTHLY', new Date('2026-02-18T00:00:00Z')))), {
  start: '2026-02-01T00:00:00.000Z', end: '2026-02-28T00:00:00.000Z'
});
console.log('task workflow pure tests passed');
