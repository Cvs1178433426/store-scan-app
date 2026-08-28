import { describe, expect, it } from 'vitest';
import { isScheduledBefore, reportDateRange, taskSnapshotData } from './taskWorkflow.js';

describe('task workflow snapshots', () => {
  it('copies every history-bearing field from a template into an assignment', () => {
    const scheduledDate = new Date('2026-08-28T00:00:00.000Z');
    const dueAt = new Date('2026-08-28T12:30:00.000Z');
    expect(taskSnapshotData({
      id: 'tpl-1', organizationId: 'org-1', siteId: null, jobTitle: 'RECEIVER', title: 'Review expected deliveries',
      instructions: 'Check dock schedule', recurrence: 'DAILY', priority: 'HIGH', rolloverPolicy: 'REMAIN_OVERDUE', dueTime: '08:30',
    }, 'site-1', 'user-1', scheduledDate, dueAt)).toEqual({
      templateId: 'tpl-1', organizationId: 'org-1', siteId: 'site-1', assignedToId: 'user-1', jobTitle: 'RECEIVER',
      title: 'Review expected deliveries', instructions: 'Check dock schedule', recurrence: 'DAILY', scheduledDate, dueAt,
      priority: 'HIGH', rolloverPolicy: 'REMAIN_OVERDUE',
    });
  });
});

describe('report ranges', () => {
  it('uses Monday through Sunday for weekly reports', () => {
    expect(reportDateRange('WEEKLY', new Date('2026-08-27T00:00:00Z'))).toEqual({
      start: new Date('2026-08-24T00:00:00Z'), end: new Date('2026-08-30T00:00:00Z'),
    });
  });
  it('uses full calendar months', () => {
    expect(reportDateRange('MONTHLY', new Date('2026-02-18T00:00:00Z'))).toEqual({
      start: new Date('2026-02-01T00:00:00Z'), end: new Date('2026-02-28T00:00:00Z'),
    });
  });
});

describe('date comparisons', () => {
  it('does not call today overdue', () => {
    expect(isScheduledBefore(new Date('2026-08-28T00:00:00Z'), new Date('2026-08-28T00:00:00Z'))).toBe(false);
  });
});
