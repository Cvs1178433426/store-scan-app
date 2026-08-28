import { describe, expect, it } from 'vitest';
import { greetingForHour, groupAssignments, isStoreScanTask } from './taskPresentation';

describe('greetingForHour', () => {
  it('uses documented time-of-day boundaries', () => {
    expect(greetingForHour(11, 'Alex')).toBe('Good morning, Alex!');
    expect(greetingForHour(12, 'Alex')).toBe('Good afternoon, Alex!');
    expect(greetingForHour(16, 'Alex')).toBe('Good afternoon, Alex!');
    expect(greetingForHour(17, 'Alex')).toBe('Good evening, Alex!');
  });
});

describe('groupAssignments', () => {
  it('separates overdue, today, this week, and completed today and orders priority', () => {
    const grouped = groupAssignments([
      { id: 'over', title: 'Old', status: 'OPEN', scheduledDate: '2026-08-27T00:00:00Z', priority: 'NORMAL', dueAt: null },
      { id: 'high', title: 'High', status: 'OPEN', scheduledDate: '2026-08-28T00:00:00Z', priority: 'HIGH', dueAt: null },
      { id: 'urgent', title: 'Urgent', status: 'IN_PROGRESS', scheduledDate: '2026-08-28T00:00:00Z', priority: 'URGENT', dueAt: null },
      { id: 'later', title: 'Later', status: 'OPEN', scheduledDate: '2026-08-30T00:00:00Z', priority: 'LOW', dueAt: null },
      { id: 'done', title: 'Done', status: 'COMPLETED', scheduledDate: '2026-08-27T00:00:00Z', completedAt: '2026-08-28T10:00:00Z', priority: 'NORMAL', dueAt: null },
    ], '2026-08-28');
    expect(grouped.overdue.map((x) => x.id)).toEqual(['over']);
    expect(grouped.today.map((x) => x.id)).toEqual(['urgent', 'high']);
    expect(grouped.thisWeek.map((x) => x.id)).toEqual(['later']);
    expect(grouped.completedToday.map((x) => x.id)).toEqual(['done']);
  });
});

describe('Store Scan operational task detection', () => {
  it('only links scan/count task wording', () => {
    expect(isStoreScanTask({ title: 'Complete Store Scan', instructions: null })).toBe(true);
    expect(isStoreScanTask({ title: 'Opening safety walk', instructions: 'Check exits' })).toBe(false);
  });
});
