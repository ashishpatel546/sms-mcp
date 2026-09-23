import type { SchoolContext } from '../src/resolve.js';

export const TODAY = '2026-09-24'; // a Thursday

export function makeContext(over: Partial<SchoolContext> = {}): SchoolContext {
  return {
    today: TODAY,
    school: { name: 'Edusphere Academy', slug: 'edusphere' },
    session: { id: 1, name: '2026-2027', from: '2026-04-01', to: '2027-03-31' },
    me: {
      userId: 7,
      name: 'Sandhya Kumari',
      roles: ['TEACHER'],
      staffId: 2,
      designation: 'Teacher',
      classTeacherOf: [{ classId: 9, sectionId: 2, label: 'Class 6-B' }],
      teaches: [],
    },
    can: {
      viewStudents: true,
      viewAttendance: true,
      markAttendance: true,
      editMarkedAttendance: false,
      viewHomework: true,
      setHomework: true,
      viewExams: true,
      viewStudentLeaves: true,
      firstApproveStudentLeave: true,
      finalApproveStudentLeave: false,
      viewFeeStatus: false,
      viewStaffAttendanceSummary: false,
      viewStaffAttendanceNames: false,
      approveStaffLeave: false,
      selfServiceHr: true,
      viewUsageBreakdown: false,
    },
    classes: [
      { id: 2, name: 'UKG', sections: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] },
      { id: 9, name: 'Class 6', sections: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] },
      { id: 13, name: 'Class 10', sections: [{ id: 1, name: 'A' }] },
    ],
    subjects: [
      { id: 1, name: 'Mathematics' },
      { id: 2, name: 'Science' },
      { id: 3, name: 'Social Science' },
      { id: 4, name: 'English' },
    ],
    leavePolicies: [
      { id: 11, code: 'CL', name: 'Casual Leave' },
      { id: 12, code: 'SL', name: 'Sick Leave' },
    ],
    credits: { month: '2026-09', remaining: 400, limit: 500 },
    ...over,
  };
}
