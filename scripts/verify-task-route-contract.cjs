const fs = require('node:fs');
const assert = require('node:assert/strict');
const src = fs.readFileSync('apps/api/src/routes/tasks.ts', 'utf8');
const required = [
  'app.get("/me/summary"',
  'app.get("/employees"',
  'app.get("/team"',
  'app.patch("/templates/:id"',
  'app.delete("/templates/:id"',
  'app.post("/assignments"',
  'app.patch("/assignments/:id"',
  'app.get("/reports"',
  'app.get("/reports.csv"',
  'taskAssignmentEvent.create',
  'taskSnapshotData(',
  'assignedToId: request.user.sub',
  'organizationId: context.site.organizationId',
  'siteId: context.site.id',
];
for (const needle of required) assert.ok(src.includes(needle), `missing task route contract: ${needle}`);
console.log('task route contract passed');
