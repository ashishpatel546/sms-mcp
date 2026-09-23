import { describe, expect, it } from 'vitest';
import { nameList, renderCompact, reply } from '../src/format.js';

describe('renderCompact', () => {
  it('renders record lists as one table, dropping empty columns', () => {
    const out = renderCompact([
      { id: 1, name: 'Riya', admission: null },
      { id: 2, name: 'Aman | B', admission: null },
    ]);
    expect(out).toBe('id | name\n1 | Riya\n2 | Aman / B');
  });

  it('renders objects as key lines and nests structures', () => {
    const out = renderCompact({
      date: '2026-09-24',
      empty: [],
      nothing: null,
      flags: { taken: true, pending: false },
      names: ['A', 'B'],
    });
    expect(out).toBe(
      'date: 2026-09-24\nflags:\n  taken: yes\n  pending: no\nnames: A, B',
    );
  });

  it('is much smaller than the JSON it replaces', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      name: `Student ${i}`,
      class: 'Class 6-B',
      percentage: 70 + (i % 5),
    }));
    expect(renderCompact(rows).length).toBeLessThan(
      JSON.stringify(rows).length * 0.6,
    );
  });
});

describe('reply / nameList', () => {
  it('puts the spoken summary on the first line', () => {
    const r = reply('3 students found.', [{ id: 1 }]);
    expect(r.content[0]).toMatchObject({ text: '3 students found.\nid\n1' });
  });

  it('shortens long name lists for speech', () => {
    expect(nameList(['A'])).toBe('A');
    expect(nameList(['A', 'B', 'C'])).toBe('A, B and C');
    expect(nameList(['A', 'B', 'C', 'D', 'E', 'F'], 4)).toBe(
      'A, B, C, D and 2 others',
    );
  });
});
