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
  'materializeTeamWorkWindow(',
  'fromAssignedToId: assignment.assignedToId',
  'updatedAt: assignment.updatedAt',
  'select: { id: true, organizationId: true, siteId: true, status: true, updatedAt: true }',
  'where: { id: assignment.id, status: assignment.status, updatedAt: assignment.updatedAt }',
  'This task changed while you were editing it. Refresh and try again.',
  'toAssignedToId: parsed.data.assignedToId',
  'user: { isActive: true, jobTitle: { not: null } }',
  'assignedToId: request.user.sub',
  'organizationId: context.site.organizationId',
  'siteId: context.site.id',
];
for (const needle of required) assert.ok(src.includes(needle), `missing task route contract: ${needle}`);
console.log('task route contract passed');
