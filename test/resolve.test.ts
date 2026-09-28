import { describe, expect, it } from 'vitest';
import {
  matchPerson,
  parseDate,
  periodRange,
  resolveClass,
  resolveLeavePolicy,
  ResolveError,
  resolveSubject,
  spokenDate,
} from '../src/resolve.js';
import { makeContext, TODAY } from './fixtures.js';

const ctx = makeContext();

describe('resolveClass', () => {
  it.each([
    ['6B', 'Class 6-B'],
    ['6-b', 'Class 6-B'],
    ['class 6 section B', 'Class 6-B'],
    ['six b', 'Class 6-B'],
    ['sixth B', 'Class 6-B'],
    ['VI B', 'Class 6-B'],
    ['UKG A', 'UKG-A'],
    ['ukg-b', 'UKG-B'],
  ])('%s → %s', (said, label) => {
    expect(resolveClass(ctx, said, true).label).toBe(label);
  });

  it('uses the only section when a class has one', () => {
    expect(resolveClass(ctx, 'class 10', true)).toMatchObject({
      classId: 13,
      sectionId: 1,
    });
  });

  it('asks which section when one is required and ambiguous', () => {
    expect(() => resolveClass(ctx, 'class 6', true)).toThrow(
      'Which section of Class 6? A, B.',
    );
  });

  it('returns the whole class when a section is optional', () => {
    expect(resolveClass(ctx, '6')).toEqual({ classId: 9, label: 'Class 6' });
  });

  it('lists choices for an unknown section or class', () => {
    expect(() => resolveClass(ctx, '6 D')).toThrow('Sections: A, B');
    expect(() => resolveClass(ctx, 'class 12 a')).toThrow(ResolveError);
  });
});

describe('parseDate (today is Thu 24 Sep 2026)', () => {
  it.each([
    [undefined, TODAY],
    ['today', TODAY],
    ['yesterday', '2026-09-23'],
    ['tomorrow', '2026-09-25'],
    ['day after tomorrow', '2026-09-26'],
    ['friday', '2026-09-25'],
    ['thursday', TODAY],
    ['next thursday', '2026-10-01'],
    ['last monday', '2026-09-21'],
    ['mon', '2026-09-28'],
    ['2026-10-02', '2026-10-02'],
    ['2 Oct', '2026-10-02'],
    ['oct 2', '2026-10-02'],
    ['02/10', '2026-10-02'],
    ['2-10-2026', '2026-10-02'],
    ['2/10/26', '2026-10-02'],
    ['30 days ago', '2026-08-25'],
    ['two weeks ago', '2026-09-10'],
    ['in 3 days', '2026-09-27'],
    ['last week', '2026-09-17'],
  ])('%s → %s', (said, iso) => {
    expect(parseDate(said, TODAY)).toBe(iso);
  });

  it.each([
    ['aaj', 'future', TODAY],
    ['kal', 'future', '2026-09-25'],
    ['kal', 'past', '2026-09-23'],
    ['Kal se', 'future', '2026-09-25'],
    ['parson', 'future', '2026-09-26'],
    ['परसों', 'past', '2026-09-22'],
    ['कल', 'future', '2026-09-25'],
  ] as const)('Hindi %s (%s) → %s', (said, lean, iso) => {
    expect(parseDate(said, TODAY, lean)).toBe(iso);
  });

  it('rejects impossible or unclear dates', () => {
    expect(() => parseDate('31/02', TODAY)).toThrow(ResolveError);
    expect(() => parseDate('someday', TODAY)).toThrow(ResolveError);
  });

  it('reads dates back naturally', () => {
    expect(spokenDate(TODAY)).toBe('Thu 24 Sep');
  });
});

describe('resolveSubject / resolveLeavePolicy', () => {
  it('maps spoken subject names to the school’s subjects', () => {
    expect(resolveSubject(ctx, 'maths')).toBe('Mathematics');
    expect(resolveSubject(ctx, 'SST')).toBe('Social Science');
    expect(resolveSubject(ctx, 'science')).toBe('Science');
    expect(resolveSubject(ctx, 'Music')).toBe('Music');
  });

  it('finds leave types by code or name', () => {
    expect(resolveLeavePolicy(ctx, 'CL').id).toBe(11);
    expect(resolveLeavePolicy(ctx, 'sick leave').id).toBe(12);
    expect(resolveLeavePolicy(ctx, 'casual').id).toBe(11);
    expect(() => resolveLeavePolicy(ctx, 'sabbatical')).toThrow('Types:');
  });
});

describe('matchPerson', () => {
  const roster = [
    { id: 1, name: 'Riya Sharma', rollNo: 1 },
    { id: 2, name: 'Riya Verma', rollNo: 2 },
    { id: 3, name: 'Aman Gupta', rollNo: 3 },
    { id: 4, name: 'Aditya Singh', rollNo: 4 },
  ];

  it('matches full names, surnames and roll numbers', () => {
    expect(matchPerson(roster, 'Riya Sharma')).toMatchObject({
      kind: 'one',
      person: { id: 1 },
    });
    expect(matchPerson(roster, 'gupta')).toMatchObject({ person: { id: 3 } });
    expect(matchPerson(roster, 'roll 4')).toMatchObject({ person: { id: 4 } });
    expect(matchPerson(roster, '#2')).toMatchObject({ person: { id: 2 } });
  });

  it('tolerates speech-to-text misspellings', () => {
    expect(matchPerson(roster, 'Amann')).toMatchObject({ person: { id: 3 } });
    expect(matchPerson(roster, 'Adithya')).toMatchObject({ person: { id: 4 } });
  });

  it('reports ambiguity instead of guessing', () => {
    const m = matchPerson(roster, 'Riya');
    expect(m.kind).toBe('many');
  });

  it('reports no match', () => {
    expect(matchPerson(roster, 'Zoya').kind).toBe('none');
  });
});

describe('periodRange', () => {
  // TODAY is Thu 24 Sep 2026.
  it('gives weeks Monday to Sunday, never past today', () => {
    expect(periodRange('this week', TODAY)).toEqual(['2026-09-21', '2026-09-24']);
    expect(periodRange('last week', TODAY)).toEqual(['2026-09-14', '2026-09-20']);
  });

  it('gives calendar months', () => {
    expect(periodRange('this month', TODAY)).toEqual(['2026-09-01', '2026-09-24']);
    expect(periodRange('last month', TODAY)).toEqual(['2026-08-01', '2026-08-31']);
    expect(periodRange('last month', '2026-01-10')).toEqual(['2025-12-01', '2025-12-31']);
  });

  it('treats Sunday as the end of its week', () => {
    expect(periodRange('this week', '2026-09-27')).toEqual(['2026-09-21', '2026-09-27']);
  });
});
