'use strict';
// Seed data for the in-memory mock store (MOCK=1). Fictional people and projects.
// Next-step dates are relative to today in America/Chicago.

function chicagoToday() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return f.format(new Date()); // YYYY-MM-DD
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

const USERS = {
  manager: { name: 'Dana Reyes', email: 'dana.reyes@example.com', role: 'Manager', code: 'manager-code-1' },
  sales: { name: 'Sam Ortiz', email: 'sam.ortiz@example.com', role: 'Sales', code: 'sales-code-1' },
  outside: { name: 'Olivia Park', email: 'olivia.park@example.com', role: 'Outside', code: 'outside-code-1' },
  former: { name: 'Pat Former', email: 'pat.former@example.com', role: 'Sales', code: 'former-code-1' },
};

function createSeed() {
  const today = chicagoToday();
  const d = (n) => addDays(today, n);
  const M = USERS.manager.name;
  const SA = USERS.sales.name;
  const O = USERS.outside.name;

  const lead = (o) => ({
    fit: '', status: 'New', project: '', owner: '', location: '', state: '', type: '', value: '',
    size: '', stage: '', opening: '', gc: '', architect: '', whyFits: '', nextStep: '',
    nativeNote: '', source: '', nextOwner: '', nextDate: '', notes: '', firstSeen: d(-30),
    lastChecked: d(-2), id: '', ...o,
  });

  const leads = [
    lead({ id: 'L-0001', fit: 'A', status: 'Won', project: 'Riverbend Casino hotel tower carpet', owner: 'Riverbend Nation',
      location: 'Durant', state: 'OK', type: 'Hospitality', value: '$1.2M', size: '38,000 sq yd',
      stage: 'Awarded, install starts in spring', opening: '2027-06', gc: 'Red River Builders',
      architect: 'Hollis Design', whyFits: 'Large woven carpet replacement, like our past casino work.',
      nextStep: 'Confirm install phasing', source: 'https://example.com/riverbend', nextOwner: SA,
      nextDate: d(5), notes: 'PO received.' }),
    lead({ id: 'L-0002', fit: 'A', status: 'Contacted', project: 'Lakeview Medical Center expansion', owner: 'Lakeview Health',
      location: 'Denton', state: 'TX', type: 'Healthcare', value: '$450K', stage: 'Design development',
      gc: 'Summit Construction', nextStep: 'Call the GC about the flooring bid list', nextOwner: SA,
      nextDate: d(-3), source: 'https://example.com/lakeview' }),
    lead({ id: 'L-0003', fit: 'B', status: 'Bidding', project: 'Cedar Hills travel plaza', owner: 'Cedar Hills Nation',
      location: 'Ada', state: 'OK', type: 'Retail', value: '$180K', nextStep: 'Send revised bid',
      nextOwner: O, nextDate: d(0), nativeNote: 'Native-owned subcontractor preference stated in RFP.' }),
    lead({ id: 'L-0004', fit: 'B', status: 'Researching', project: 'Norman office park renovation', owner: 'Prairie Holdings',
      location: 'Norman', state: 'OK', type: 'Office', nextStep: 'Find the property manager',
      nextOwner: O, nextDate: d(6) }),
    lead({ id: 'L-0005', fit: 'C', status: 'New', project: 'Gainesville school district admin building', owner: 'Gainesville ISD',
      location: 'Gainesville', state: 'TX', type: 'Institutional', nextStep: 'Check procurement portal',
      nextOwner: '', nextDate: d(10) }),
    lead({ id: 'L-0006', status: 'Watch', project: 'Fort Worth convention hotel refresh', owner: 'Trinity Hospitality Group',
      location: 'Fort Worth', state: 'TX', type: 'Hospitality', nextStep: 'Watch for renovation announcement',
      nextOwner: 'To be named', notes: '=SUM(A1:A3) stays as text' }),
    lead({ id: 'L-0007', fit: 'A', status: 'Lost', project: 'Tulsa corporate campus', owner: 'Arkansas River Energy',
      location: 'Tulsa', state: 'OK', type: 'Corporate', value: '$900K', nextStep: 'Ask for debrief on the loss',
      nextOwner: M, nextDate: d(-10), notes: 'Lost on price.' }),
    lead({ id: 'L-0008', fit: 'B', status: 'New', project: 'Oklahoma City hotel rebrand', owner: 'Plains Lodging LLC',
      location: 'Oklahoma City', state: 'OK', type: 'Hospitality', nextStep: 'Request intro to renovation manager',
      nextOwner: M, nextDate: d(3) }),
    lead({ id: 'L-0009', status: 'Researching', project: 'Sherman clinic tenant finish-out', owner: 'North Texas Clinics',
      location: 'Sherman', state: 'TX', type: 'Healthcare', nextStep: 'Identify architect',
      nextOwner: USERS.former.name, nextDate: d(-1) }),
    lead({ id: 'L-0010', fit: 'A', status: 'Contacted', project: 'Frisco hotel ballroom carpet', owner: 'Legacy Hotels',
      location: 'Frisco', state: 'TX', type: 'Hospitality', nextStep: 'Schedule site visit', nextOwner: SA, nextDate: '' }),
    // Added by the weekly scan: no Lead ID yet; the store assigns L-0011.
    lead({ id: '', status: 'New', project: 'Durant event center flooring', owner: 'Riverbend Nation', location: 'Durant',
      state: 'OK', type: 'Hospitality', nextStep: 'Review scan result', nextOwner: '', firstSeen: d(-1),
      lastChecked: d(-1) }),
    // Row without a project name: ignored.
    lead({ id: '', status: '', project: '', notes: 'stray row' }),
  ];

  const contacts = [
    { id: 'C-0001', leadId: 'L-0002', name: 'Jordan Blake', title: 'Project manager', company: 'Summit Construction',
      email: 'jordan.blake@example.com', phone: '940-555-0101', verifiedAt: 'Company website staff page',
      notes: '', addedBy: SA, addedOn: d(-20) },
    { id: 'C-0002', leadId: 'L-0003', name: 'Casey Lone Elk', title: 'Facilities director', company: 'Cedar Hills Nation',
      email: '', phone: '580-555-0144', verifiedAt: 'Bid document', notes: 'Prefers phone.', addedBy: O,
      addedOn: d(-12) },
    { id: 'C-0003', leadId: 'L-0007', name: 'Riley Chen', title: 'Procurement', company: 'Arkansas River Energy',
      email: 'riley.chen@example.com', phone: '', verifiedAt: 'Met at trade show', notes: '', addedBy: M,
      addedOn: d(-40) },
    { id: 'C-0004', leadId: 'L-0005', name: 'Morgan Diaz', title: 'Purchasing', company: 'Gainesville ISD',
      email: 'purchasing@example.com', phone: '', verifiedAt: 'District website', notes: '', addedBy: SA,
      addedOn: d(-5) },
  ];

  const stamp = (n, hm) => `${d(n)} ${hm}`;
  const activity = [
    { when: stamp(-20, '09:15'), leadId: 'L-0002', project: 'Lakeview Medical Center expansion', by: SA, type: 'Call',
      note: 'Spoke with Jordan; bid list opens next month.', nextStep: 'Call the GC about the flooring bid list', nextDate: d(-3) },
    { when: stamp(-12, '14:30'), leadId: 'L-0003', project: 'Cedar Hills travel plaza', by: O, type: 'Site visit',
      note: 'Walked the site with Casey.', nextStep: 'Send revised bid', nextDate: d(0) },
    { when: stamp(-8, '11:00'), leadId: 'L-0007', project: 'Tulsa corporate campus', by: M, type: 'Email',
      note: 'Award went to another installer.', nextStep: '', nextDate: '' },
    { when: stamp(-2, '16:45'), leadId: 'L-0002', project: 'Lakeview Medical Center expansion', by: SA, type: 'Voicemail',
      note: 'Left a voicemail for Jordan.', nextStep: '', nextDate: '' },
    { when: stamp(-1, '08:05'), leadId: 'L-0001', project: 'Riverbend Casino hotel tower carpet', by: M, type: 'Update',
      note: 'Changed status to Won', nextStep: '', nextDate: '' },
  ];

  const openBids = [
    { title: 'Community center flooring replacement', nation: 'Cedar Hills Nation', bidId: 'CHN-2026-114',
      closeDate: d(9), contact: 'Procurement office', link: 'https://example.com/bids/chn-2026-114',
      relatedProject: 'Cedar Hills travel plaza' },
    { title: 'Health clinic LVT and carpet tile', nation: 'Riverbend Nation', bidId: 'RBN-77',
      closeDate: d(21), contact: 'Bid desk', link: 'https://example.com/bids/rbn-77', relatedProject: '' },
    { title: 'Administration building carpet', nation: 'Riverbend Nation', bidId: 'RBN-81',
      closeDate: d(4), contact: '', link: 'https://example.com/bids/rbn-81', relatedProject: '' },
  ];

  const users = [
    { ...USERS.manager, active: 'Yes' },
    { ...USERS.sales, active: 'Yes' },
    { ...USERS.outside, active: 'Yes' },
    { ...USERS.former, active: 'No' },
  ];

  return { leads, contacts, activity, openBids, users };
}

module.exports = { createSeed, USERS, chicagoToday, addDays };
