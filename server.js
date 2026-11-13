/**
 * Program and Project Management Center — Smartsheet Live Data API
 * Hosted on Render.com (free tier)
 *
 * Set environment variables in Render dashboard:
 *   SMARTSHEET_TOKEN  = your Smartsheet API token
 *   ANTHROPIC_API_KEY = your Anthropic API key  (for Key Insights)
 *   CODY_API_KEY      = your Cody AI API key    (for Ask Cody chatbot)
 *   CODY_BOT_ID       = your Cody bot ID        (from GET /api/v1/bots)
 *
 * Endpoints:
 *   GET  /api/health             — health check (no auth needed)
 *   GET  /api/data               — returns live project + risk + compliance data
 *   POST /api/ai                 — proxy for Claude Key Insights (body: { prompt })
 *   POST /api/cody/message       — proxy for Cody chatbot (body: { content, conversation_id? })
 *   POST /api/cody/conversation  — create a new Cody conversation (body: { name })
 *   GET  /api/tools              — PMOE Tool catalogue with fresh S3 download URLs
 *   GET  /api/tool-download?id   — fresh S3 URL for a single attachment (60-s expiry)
 *   GET  /api/facility           — Facility/Construction PM active + completed sheets
 *   GET  /api/charters           — project charters auto-synced from the compliance-sheet attachments
 *   POST /api/charters/refresh   — re-scan attachments now (also ?refresh=1 on GET)
 *   GET  /api/charter-file/:id   — opens a charter file (fresh pre-signed URL redirect)
 *   GET  /api/risks/sources      — every RAID / Risk / Issues log found + rows parsed (diagnostics)
 */

const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Smartsheet source IDs
const SS_BASE          = 'https://api.smartsheet.com/2.0';
const REPORT_ID        = '7165261019828100';  // PMOE Load - Update report
const COMPLIANCE_SHEET = '2177565233991556';  // PM Process Compliance Audit

// ── Risk/Issue Log Sheet Registry ────────────────────────────────────────────
// Two-layer approach:
//   1. KNOWN_RISK_SHEETS — hardcoded IDs for all currently active projects.
//      Confirmed by workspace search on 2026-05-22. Add new pairs here when
//      a new project gets risk/issue logs, OR just wait for the next Render
//      deploy which re-runs discoverRiskSheets() and auto-picks them up.
//   2. discoverRiskSheets() — calls Smartsheet Search API at startup + every 6h
//      to find any sheets added since the last deploy. Merged with KNOWN_RISK_SHEETS
//      so neither layer alone is a single point of failure.
//
// Sheet name conventions in the workspace:
//   "<Project> Risks Log"   /  "Risks Log - <Project>"   → type:'risk'
//   "<Project> Issues Log"  /  "Issues Log - <Project>"  → type:'issue'

const KNOWN_RISK_SHEETS = [
  // ── Active / Planning & Execution ────────────────────────────────────────
  { id: '3940782535823236', project: 'Provident and CTSC Closure',                         type: 'risk'  },
  { id: '1126041895522180', project: 'Provident and CTSC Closure',                         type: 'issue' },
  { id: '7875273287487364', project: 'Lab Automation Upgrade',                             type: 'risk'  },
  { id: '2165427800067972', project: 'Lab Automation Upgrade',                             type: 'issue' },
  { id: '3128683794485124', project: 'RxLink',                                             type: 'risk'  },
  { id: '483624964018052',  project: 'RxLink',                                             type: 'issue' },
  { id: '8088442395119492', project: 'Anal Dysplasia Diagnostic and Treatment Services',   type: 'risk'  },
  { id: '770093000642436',  project: 'Anal Dysplasia Diagnostic and Treatment Services',   type: 'issue' },
  { id: '7359914058928004', project: 'HRO: Clinical Outcomes',                             type: 'issue' },
  { id: '211369967177604',  project: 'Unified Strategy: CCH-CCDPH',                       type: 'issue' }, // MCH
  { id: '7458345595129732', project: 'Unified Strategy: CCH-CCDPH',                       type: 'issue' }, // Immunizations
  { id: '7848235277176708', project: 'Health Equity Committee Capacity Building',          type: 'issue' },
  { id: '7775284465297284', project: 'Pharmacy Domestic Spend',                            type: 'risk'  },
  { id: '2145784931084164', project: 'Pharmacy Domestic Spend',                            type: 'issue' },
  // ── On Hold ───────────────────────────────────────────────────────────────
  { id: '3689972654624644', project: 'CCH-Press Ganey Consumerism',                        type: 'risk'  },
  { id: '8193572281995140', project: 'CCH-Press Ganey Consumerism',                        type: 'issue' },
  { id: '643208660864900',  project: 'Justice-Involved Re-Entry',                          type: 'risk'  },
  { id: '5146808288235396', project: 'Justice-Involved Re-Entry',                          type: 'issue' },
];

// Root of all project folders. Every RAID / Risk / Issues log anywhere beneath it
// is discovered by walking the folder tree (see discoverRiskSheets) — no hard-coded
// sheet IDs needed for new projects.
const PROJECTS_FOLDER_ID = process.env.PROJECTS_FOLDER_ID || '1518840476657540';
let _riskSheetCache   = [];   // seeded from the KNOWN_* lists once they are declared
let _riskCacheExpiry  = 0;
let _riskInflight     = null;
let _lastLogSources   = [];   // per-sheet result of the most recent /api/data (diagnostics)
let _riskWalkInfo     = { at: null, folders: 0, sheets: 0, discovered: 0, error: null };
const RISK_CACHE_TTL  = 10 * 60 * 1000; // 10 minutes — new logs show up within one refresh cycle

// ── Project Plan Sheet Registry ───────────────────────────────────────────────
// Each active project in "Projects - Planning and Execution Phase" has a
// <Project>/Project Plan/ subfolder containing a single Gantt-style plan sheet.
// Schema (confirmed identical across plans):
//   Task | Status (Not Started | In Progress | Complete) | % Complete | Phase | Assigned To
// Parent/summary rows (phase headers) roll up their children — we skip rows that
// are themselves parents so counts reflect real leaf tasks, not headers.
//
// Currently scoped to the 3 projects that already have live risk/issue logs.
// To add more: append { id, project } pairs here. (A folder-walk auto-discovery
// layer like discoverRiskSheets() can be added later to cover all 17 projects.)
const KNOWN_PLAN_SHEETS = [
  { id: '4504076086628228', project: 'Provident and CTSC Closure' }, // sheet titled "Provident ICU Services Suspension"
  { id: '6034098653974404', project: 'Lab Automation Upgrade'   }, // "Integrated Hospital Readiness Plan"
  { id: '1596995377516420', project: 'RxLink'                   }, // "Rx Link"
];

let _planCache       = null;
let _planCacheExpiry = 0;
const PLAN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes — matches dashboard refresh cadence

// ── RAID Log Sheet Registry ───────────────────────────────────────────────────
// A newer, combined "RAID" log format (Risks, Actions, Issues, Decisions all in
// one sheet) used by several projects. Unlike the older separate Risk-Log /
// Issue-Log sheets, these use a single "Type" multipicklist column. We surface
// only rows whose Type includes Risk or Issue into the Risks & Issues register.
//
// Schema (confirmed identical across all four sheets):
//   Type (Risk|Action|Issue|Decision) | Description (please include detail with dates)
//   | Proposed Mitigation for Risk or Issue | Status (Open|In Progress|On Hold|Closed|Overdue)
//   | Priority Level | Project Workstream | Comments / Progress (include resolution)
// The project name lives in a metadata row where Description == "Project Name:"
// (value in the mitigation column); we fall back to the name below if absent.
const KNOWN_RAID_SHEETS = [
  { id: '8490059559817092', project: 'AI Committee' },                                  // "AI Innovation RAID Log"
  { id: '6481509809606532', project: 'Cath Lab- EP Optimization' },                     // "Cath Lab Optimization - Project RAID Log"
  { id: '715449181360004',  project: 'Workforce Pipeline Development (City Colleges of Chicago)' }, // "City Colleges - Project RAID Log"
  { id: '3125161694809988', project: 'Pharmacy Domestic Spend' },                       // "RxSpend - Project RAID Log"
];

// Seed list: everything hard-coded above, in the unified {id, project, type} shape
// (type = 'risk' | 'issue' | 'raid'). The folder walk adds to this; it never removes
// from it, so a failed walk can't make a known log disappear.
function knownLogSheets() {
  return [
    ...KNOWN_RISK_SHEETS.map(s => ({ ...s, src: 'known' })),
    ...KNOWN_RAID_SHEETS.map(s => ({ id: s.id, project: s.project, type: 'raid', src: 'known' }))
  ];
}
_riskSheetCache = knownLogSheets();

// Parse project name + type from a risk/issue log sheet name
function parseRiskSheetName(sheetName) {
  const n = sheetName.trim();
  let m;
  m = n.match(/^(.+?)\s+Risks?\s+Log$/i);   if (m) return { project: m[1].trim(), type: 'risk'  };
  m = n.match(/^(.+?)\s+Issues?\s+Log$/i);  if (m) return { project: m[1].trim(), type: 'issue' };
  m = n.match(/^Risks?\s+Log\s*[-–]\s*(.+)$/i);  if (m) return { project: m[1].trim(), type: 'risk'  };
  m = n.match(/^Issues?\s+Log\s*[-–]\s*(.+)$/i); if (m) return { project: m[1].trim(), type: 'issue' };
  return null;
}

// Normalize abbreviated sheet-name project names to canonical dashboard names
const PROJECT_NAME_MAP = {
  'CCH-Press Ganey':                        'CCH-Press Ganey Consumerism',
  'Lab Automation':                          'Lab Automation Upgrade',
  // Provident/CTSC closure has appeared under several names across Smartsheet
  // sources (risk/issue logs, the plan sheet, and the PMOE Load report). They
  // must all collapse to the single canonical dashboard name, otherwise the
  // charter/closure lookups in index.html miss and the project renders bare.
  'Provident and CTSC Closure':              'Provident and CTSC Closure',
  'Provident ICU and CTSC Closure':          'Provident and CTSC Closure',
  'Provident ICU Closure':                   'Provident and CTSC Closure',
  'Provident ICU Services Suspension':       'Provident and CTSC Closure',
  'Anal Dysplasia Clinic':                   'Anal Dysplasia Diagnostic and Treatment Services',
  'HEC':                                     'Health Equity Committee Capacity Building',
  'HRO Clinical Outcomes':                   'HRO: Clinical Outcomes',
  'MCH':                                     'Unified Strategy: CCH-CCDPH',
  'Immunizations':                           'Unified Strategy: CCH-CCDPH',
  'Cath Lab':                                'Cath Lab- EP Optimization',
  'Cath Lab Optimization Project':           'Cath Lab- EP Optimization',
  'Justice-Involved Re-Entry (1115 Waiver)': 'Justice-Involved Re-Entry',
  // RAID-log self-reported project names → canonical dashboard names
  'AI Innovation':                           'AI Committee',
  'City Colleges Workforce Pipeline':        'Workforce Pipeline Development (City Colleges of Chicago)',
  'RxSpend':                                 'Pharmacy Domestic Spend',
};
// Folder-derived names (project folder under PROJECTS_FOLDER_ID) → canonical dashboard
// names. Only used for logs whose own sheet name doesn't say which project they belong
// to (e.g. a bare "RAID Log"). Kept separate from PROJECT_NAME_MAP on purpose: that map
// also runs over compliance/report names, where a prefix rule here would rename real rows.
const FOLDER_NAME_MAP = {
  'Domestic Spend':                       'Pharmacy Domestic Spend',
  'Grants App':                           'Grants Management App',
  'Non Oncology Infusion':                'Non-Oncology Infusion',
  'City Colleges Workforce':              'Workforce Pipeline Development (City Colleges of Chicago)',
  'AI Innovation':                        'AI Committee',
  'Cath Lab Optimization Project':        'Cath Lab- EP Optimization',
  'Surgery Optimization Project':         'Surgery Optimization Phase 3',
  'Health Equity Recertification':        'Joint Commission Health Equity Recertification',
  'Community Health Worker & Doula':      'Community Health Worker',
  'Unified Strategy':                     'Unified Strategy: CCH-CCDPH',
  'Med Reconciliation and Optimization':  'Medication Refill and Reconciliation Optimization'
};

// Live list of canonical project names (compliance sheet + PMOE Load report), refreshed
// on every /api/data and charter sync. Lets canonProject() resolve abbreviated names.
let _projectCandidates = [];
function setProjectCandidates(names) {
  const set = new Set((names || []).filter(Boolean));
  if (set.size) _projectCandidates = [...set];
}
const _nk = t => (t || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// normProjectName + unique-match against the live project list.
function canonProject(raw) {
  const name = normProjectName((raw || '').trim());
  if (!name || _projectCandidates.includes(name)) return name;
  const nr = _nk(name);
  const exact = _projectCandidates.filter(c => _nk(c) === nr);
  if (exact.length === 1) return exact[0];
  if (nr.length >= 6) {
    const part = _projectCandidates.filter(c => {
      const nc = _nk(c);
      return nc.length >= 6 && (nc.includes(nr) || nr.includes(nc));
    });
    if (part.length === 1) return part[0];
  }
  return name;
}

function normProjectName(raw) {
  if (PROJECT_NAME_MAP[raw]) return PROJECT_NAME_MAP[raw];
  for (const [abbr, full] of Object.entries(PROJECT_NAME_MAP)) {
    if (raw.toLowerCase().startsWith(abbr.toLowerCase())) return full;
  }
  return raw;
}

// ── Log parsing ───────────────────────────────────────────────────────────────
// Four log layouts exist in the project folders:
//   1. Legacy "<Project> Risks Log" / "Issues Log"   (Category | Description | Chance of
//      Occuring | Impact | Action Plan | Status …)                → parseLegacyRiskLog
//   2. RAID v1  (Type multipicklist | "Description (please include detail with dates)" |
//      Proposed Mitigation… | Status | Priority Level | Project Workstream …)
//   3. RAID v2  (ID | Type | Workstream | Summary | Detail | Status | Owner | Due …
//      | Response / Next Step)                                   (e.g. Stroger 4th Floor)
//   4. Risk & Issue Log  (Risk / Issue Title | Grant / Project | Type | Risk Statement |
//      Probability | Impact | Rating | Mitigation / Action Plan | Status …)  (Grants App)
// Layouts 2–4 all carry a Type column, so one tolerant parser (parseRaidLog) finds each
// column by title pattern instead of an exact string. parseLogSheet() picks the parser
// from the sheet's actual columns, so a renamed or newly added log needs no code change.

function parseLegacyRiskLog(sheetData, projectName, logType) {
  const c        = sheetData.columns || [];
  const highId   = c.find(x => x.title === 'High Risk')?.id;
  const catId    = c.find(x => x.title === 'Category')?.id;
  const descId   = c.find(x => x.title === 'Description')?.id;
  const chanceId = c.find(x => x.title === 'Chance of Occuring')?.id;
  const impactId = c.find(x => x.title === 'Impact')?.id;
  const planId   = c.find(x => x.title === 'Action Plan')?.id
                || c.find(x => x.title === 'Status/Action Plan')?.id;
  const statusId = c.find(x => x.title === 'Status')?.id;

  // SIGNAL5 / MONEY6 column types return display words — map them to labels
  const SIGNAL_MAP = { one:'Low', two:'Low-Medium', three:'Medium', four:'Medium-High', five:'High', half:'Medium' };

  return (sheetData.rows || []).map(row => {
    const cell = id => (row.cells || []).find(c => c.columnId == id);
    const desc = cell(descId)?.displayValue;
    if (!desc) return null;

    // Status may be MULTIPICKLIST — value could be an array; use displayValue or join array
    const statusCell = cell(statusId);
    const statusRaw  = statusCell?.displayValue
      || (Array.isArray(statusCell?.value) ? statusCell.value.join(', ') : (statusCell?.value || ''));
    const statusVal  = statusRaw.toLowerCase().trim();

    if (logType === 'risk'  && ['resolved','inactive'].some(v => statusVal.includes(v)))                  return null;
    if (logType === 'issue' && ['addressed/closed','closed','resolved'].some(v => statusVal.includes(v))) return null;

    const rawChance = (cell(chanceId)?.displayValue || '').toLowerCase();
    const rawImpact = (cell(impactId)?.displayValue || '').toLowerCase();

    return {
      project:     projectName,
      logType,
      highRisk:    cell(highId)?.value === true,
      category:    cell(catId)?.displayValue   || '',
      description: desc,
      chance:      SIGNAL_MAP[rawChance] || cell(chanceId)?.displayValue || '',
      impact:      SIGNAL_MAP[rawImpact] || cell(impactId)?.displayValue || '',
      actionPlan:  cell(planId)?.displayValue  || '',
      status:      statusRaw
    };
  }).filter(Boolean);
}


const LOG_CLOSED_STATUSES = ['closed', 'resolved', 'superseded', 'inactive', 'addressed/closed', 'cancelled', 'canceled'];

// Parse a Type-column log (RAID v1 / v2 / Risk & Issue Log) into the standard
// risk/issue record shape the dashboard already renders. Only rows whose Type includes
// "Risk" or "Issue" are surfaced; Actions, Assumptions, Dependencies and Decisions are
// skipped. Closed/superseded rows are dropped.
// Fields emitted: { project, logType, highRisk, category, description, chance,
//                   impact, actionPlan, status }
function parseRaidLog(sheetData, fallbackProject, hintType) {
  const cols = sheetData.columns || [];
  const find = (...pats) => {
    for (const p of pats) {
      const c = cols.find(col => p.test((col.title || '').trim()));
      if (c) return c.id;
    }
    return undefined;
  };
  const typeId    = find(/^type$/i);
  const titleId   = find(/^summary$/i, /^risk\s*\/\s*issue\s*title$/i);
  const bodyId    = find(/^description\b/i, /^risk statement$/i, /^detail$/i);
  const mitId     = find(/^proposed mitigation/i, /^mitigation\s*\/\s*action plan$/i, /^action plan$/i,
                         /^status\s*\/\s*action plan$/i, /^response\s*\/\s*next step$/i);
  const commentId = find(/^comments/i);
  const statusId  = find(/^status$/i);
  const prioId    = find(/^priority level$/i, /^priority\b/i, /^rating$/i);
  const probId    = find(/^probability$/i);
  const impactId  = find(/^impact$/i);
  const streamId  = find(/^project workstream$/i, /^workstream$/i, /^category$/i);
  // Some logs (e.g. the BH-SUD "Risk & Issue Log") tag every row with the project/grant it
  // belongs to. When that value is a known project it overrides the log-level project.
  const rowProjId = find(/^grant\s*\/\s*project$/i, /^project$/i);

  const val = (row, id) => {
    if (!id) return '';
    const c = (row.cells || []).find(x => x.columnId == id);
    if (!c) return '';
    const v = (c.displayValue !== undefined && c.displayValue !== null && c.displayValue !== '')
      ? c.displayValue
      : (Array.isArray(c.value) ? c.value.join(', ') : c.value);
    return (v === undefined || v === null) ? '' : String(v).trim();
  };
  const level = r => r.startsWith('critical') ? 'Critical' : r.startsWith('high') ? 'High'
                   : r.startsWith('medium') ? 'Medium' : r.startsWith('low') ? 'Low' : '';

  // Project name from a "Project Name:" metadata row, when the template has one.
  let projectName = fallbackProject;
  const metaCol = bodyId || titleId;
  for (const row of (sheetData.rows || [])) {
    const d = val(row, metaCol).toLowerCase().replace(/\s+/g, ' ');
    if (d === 'project name:') {
      const nm = val(row, mitId);
      if (nm) projectName = nm;
      break;
    }
  }
  projectName = canonProject(projectName || fallbackProject || '');

  const out = [];
  for (const row of (sheetData.rows || [])) {
    let isRisk, isIssue;
    if (typeId) {
      const typeRaw = val(row, typeId).toLowerCase();
      isRisk  = /\brisk\b/.test(typeRaw);
      isIssue = /\bissue\b/.test(typeRaw);
      if (!isRisk && !isIssue) continue;            // Action / Decision / Assumption / metadata
    } else {
      isIssue = hintType === 'issue';
      isRisk  = !isIssue;
    }

    const title = val(row, titleId), body = val(row, bodyId);
    let description = body;
    if (title && body && title.toLowerCase() !== body.toLowerCase()) description = `${title} — ${body}`;
    else if (title && !body) description = title;
    if (!description || description.toLowerCase().replace(/\s+/g, ' ') === 'project name:') continue;

    const statusVal = val(row, statusId);
    const sl = statusVal.toLowerCase();
    if (LOG_CLOSED_STATUSES.some(v => sl === v || sl.startsWith(v + ' '))) continue;   // drop resolved items

    const prio = val(row, prioId).toLowerCase();
    let rowProject = projectName, rowCategory = val(row, streamId);
    const tag = val(row, rowProjId);
    if (tag) {
      const cp = canonProject(tag);
      if (_projectCandidates.includes(cp)) rowProject = cp;      // resolves to a real project
      else if (!rowCategory) rowCategory = tag;                  // e.g. "Portfolio: …" → shown as the category
    }
    out.push({
      project:     rowProject,
      // Tagged both → issue (the more urgent, present-tense category)
      logType:     isIssue ? 'issue' : 'risk',
      highRisk:    prio.startsWith('critical') || prio.startsWith('high'),
      category:    rowCategory,
      description,
      chance:      level(val(row, probId).toLowerCase()) || level(prio),
      impact:      level(val(row, impactId).toLowerCase()),
      actionPlan:  val(row, mitId) || val(row, commentId),
      status:      statusVal
    });
  }
  return out;
}

// Pick the parser from the sheet's real columns. Anything that looks like the legacy
// layout (or has no Type column) keeps the original, battle-tested legacy parser.
function parseLogSheet(sheetData, meta) {
  const cols = sheetData.columns || [];
  const has = re => cols.some(c => re.test((c.title || '').trim()));
  const nm = (meta.name || sheetData.name || '').toLowerCase();
  const hint = meta.type === 'issue' ? 'issue'
             : meta.type === 'risk'  ? 'risk'
             : (/issue/.test(nm) && !/risk/.test(nm) ? 'issue' : 'risk');
  const legacy = has(/^chance of occuring$/i) || has(/^high risk$/i);
  let recs;
  if (legacy) recs = parseLegacyRiskLog(sheetData, meta.project, hint);
  else if (meta.type === 'raid' || has(/^type$/i)) recs = parseRaidLog(sheetData, meta.project, hint);
  else recs = parseLegacyRiskLog(sheetData, meta.project, hint);
  recs.forEach(r => { r.sheetId = String(sheetData.id || meta.id || ''); r.sheetName = sheetData.name || meta.name || ''; });
  return recs;
}

// ── Log discovery (folder walk) ───────────────────────────────────────────────
// Decide whether a sheet name is a risk / issue / RAID log. Templates, copies, tests and
// non-risk logs (Change Log, Decision Log, Lessons Learned, Discovery Question Log …) are
// ignored. Returns 'raid' | 'risk' | 'issue' | null.
function classifyLogSheet(name) {
  const n = (name || '').toLowerCase();
  if (/template|\btest\b|copy of|\bsample\b|\bdemo\b/.test(n)) return null;
  if (!/\blog\b/.test(n)) return null;
  if (/\braid\b/.test(n)) return 'raid';
  const risk = /\brisks?\b/.test(n), issue = /\bissues?\b/.test(n);
  if (risk && issue) return 'raid';          // combined "Risk & Issue Log"
  if (risk) return 'risk';
  if (issue) return 'issue';
  return null;
}

// Project part of a log sheet name, or null when the name is generic ("RAID Log",
// "Risk & Issue Log") — callers then fall back to the project folder's name.
function projectFromLogName(name) {
  const n = (name || '').trim();
  const KIND = '(?:RAID|Risks?|Issues?|Risks?\\s*(?:&|and)\\s*Issues?)';
  let m = n.match(new RegExp('^(.+?)\\s*[-–]?\\s*(?:Project\\s+)?' + KIND + '\\s+Log$', 'i'));
  if (!m) m = n.match(new RegExp('^' + KIND + '\\s+Log\\s*[-–]\\s*(.+)$', 'i'));
  if (!m) return null;
  const proj = m[1].trim().replace(/[-–\s]+$/, '');
  const meaningful = proj.replace(/\b(risks?|issues?|raid|and|project|log|the)\b|&/gi, '').trim();
  return meaningful ? proj : null;
}

// Breadth-first walk of the projects folder. Uses GET /folders/{id}, which lists the
// sheets and sub-folders directly — unlike the Search API it is not eventually
// consistent and doesn't depend on sheet names or breadcrumb text.
async function walkProjectsFolder() {
  const sheets = [];
  let folders = 0, failed = 0;
  let level = [{ id: PROJECTS_FOLDER_ID, top: '', trail: [], depth: 0 }];
  while (level.length) {
    const next = [];
    await pooled(level, 6, async node => {
      let f;
      try {
        f = await ssJson(`${SS_BASE}/folders/${node.id}`);
      } catch (e) {
        if (node.depth === 0) throw e;           // root unreadable → whole walk failed
        failed++;
        console.warn(`[Risk Discovery] folder ${node.id} (${node.trail.join(' / ')}) unreadable: ${e.message}`);
        return;
      }
      folders++;
      for (const sh of (f.sheets || [])) {
        sheets.push({ id: String(sh.id), name: sh.name || '', top: node.top, trail: node.trail, modifiedAt: sh.modifiedAt });
      }
      if (node.depth < 8) {
        for (const sf of (f.folders || [])) {
          next.push({ id: String(sf.id), top: node.depth === 0 ? sf.name : node.top, trail: [...node.trail, sf.name], depth: node.depth + 1 });
        }
      }
    });
    level = next;
  }
  return { sheets, folders, failed };
}

// Returns the unified list of log sheets [{ id, project, type:'risk'|'issue'|'raid', … }]:
// the hard-coded known sheets plus everything the folder walk finds. Cached for
// RISK_CACHE_TTL; concurrent callers share one walk. On any failure the last good
// list (or the known list) is returned.
async function discoverRiskSheets(force = false) {
  if (!process.env.SMARTSHEET_TOKEN) return _riskSheetCache;
  if (!force && Date.now() < _riskCacheExpiry) return _riskSheetCache;
  if (_riskInflight) return _riskInflight;

  _riskInflight = (async () => {
    try {
      // Make sure canonProject() can resolve against the live project list.
      try { await getComplianceSheet(5 * 60 * 1000); } catch (e) { /* non-fatal */ }
      setProjectCandidates([..._projectCandidates, ...knownLogSheets().map(k => k.project)]);

      const walk = await walkProjectsFolder();
      const known = knownLogSheets();
      const seen = new Set(known.map(k => k.id));
      const discovered = [];

      for (const sh of walk.sheets) {
        if (seen.has(sh.id)) continue;
        if (sh.trail.some(t => /template/i.test(t))) continue;
        const type = classifyLogSheet(sh.name);
        if (!type) continue;
        // Project = the name in the sheet title if it resolves to a real project, else the
        // project folder it lives in (mapped to the canonical name where they differ).
        const fromName  = projectFromLogName(sh.name);
        const mapped    = FOLDER_NAME_MAP[sh.top];
        const cName     = fromName ? canonProject(fromName) : '';
        const cFolder   = sh.top ? canonProject(mapped || sh.top) : '';
        const isKnown   = n => !!n && _projectCandidates.includes(n);
        const project   = isKnown(cName) ? cName : isKnown(cFolder) ? cFolder : (mapped ? cFolder : (cName || cFolder));
        if (!project) continue;
        seen.add(sh.id);
        discovered.push({ id: sh.id, project, type, name: sh.name, folder: sh.top, src: 'folder-walk' });
      }

      const combined = [...known, ...discovered];
      _riskWalkInfo = { at: new Date().toISOString(), folders: walk.folders, sheets: walk.sheets.length,
                        discovered: discovered.length, failedFolders: walk.failed, error: null };
      console.log(`[Risk Discovery] walked ${walk.folders} folders / ${walk.sheets.length} sheets → ${combined.length} logs (${known.length} known + ${discovered.length} discovered)`);
      discovered.forEach(s => console.log(`  NEW ${s.type.padEnd(5)} ${s.id} ${s.project}  ← "${s.name}" [${s.folder}]`));

      _riskSheetCache  = combined;
      _riskCacheExpiry = Date.now() + RISK_CACHE_TTL;
      return combined;
    } catch (err) {
      console.warn('[Risk Discovery] folder walk failed, keeping previous list:', err.message);
      _riskWalkInfo = { ..._riskWalkInfo, error: err.message, failedAt: new Date().toISOString() };
      _riskCacheExpiry = Date.now() + 60 * 1000;   // retry in a minute, don't hammer on error
      return _riskSheetCache;
    } finally {
      _riskInflight = null;
    }
  })();
  return _riskInflight;
}

// ── Shared Smartsheet helpers ─────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// fetch with retry on 429 / 5xx / network errors. Returns the Response (caller checks .ok).
async function ssFetch(url, opts = {}, tries = 3) {
  let last;
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(url, { headers: ssHeaders(), ...opts });
      if (r.status === 429 || r.status >= 500) { last = r; await sleep(800 * 2 ** a); continue; }
      return r;
    } catch (e) { last = e; await sleep(500 * 2 ** a); }
  }
  if (last instanceof Error) throw last;
  return last;
}
async function ssJson(url) {
  const r = await ssFetch(url);
  if (!r.ok) throw new Error(`Smartsheet ${r.status} for ${url.replace(SS_BASE, '')}`);
  return r.json();
}

// Run fn over items with at most `limit` in flight; results keep input order.
async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// PM Process Compliance Audit sheet, shared by charter sync + project-name resolution.
let _compCache = { at: 0, data: null };
async function getComplianceSheet(maxAgeMs = 60 * 1000) {
  if (_compCache.data && Date.now() - _compCache.at < maxAgeMs) return _compCache.data;
  const d = await ssJson(`${SS_BASE}/sheets/${COMPLIANCE_SHEET}?pageSize=500`);
  _compCache = { at: Date.now(), data: d };
  const projCol = (d.columns || []).find(c => c.title === 'Project')?.id;
  setProjectCandidates((d.rows || []).map(r => {
    const c = (r.cells || []).find(x => x.columnId == projCol);
    return normProjectName(c?.displayValue || '');
  }));
  return d;
}

function ssHeaders() {
  return {
    'Authorization': `Bearer ${process.env.SMARTSHEET_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

// Normalise PM display names from Smartsheet to canonical full names.
// Smartsheet contact columns return whatever the user set as their display name
// (could be "Last, First", "first.last@org.com", "First", etc.)
function normalisePM(raw) {
  if (!raw) return '';
  const known = [
    'Julius Ablis',
    'Elizabeth Wallish',
    'Jasmin Sanchez',
    'Lane Harmon',
    'Precious Avery',
    'Lydia Karch'
  ];
  const cleaned = raw.replace(/\s*\(.*?\)/g, '').trim(); // strip "(email@...)" suffix
  // 1. Full name substring match (case-insensitive)
  for (const name of known) {
    if (cleaned.toLowerCase().includes(name.toLowerCase())) return name;
  }
  // 2. Last-name match — handles "Ablis, Julius" or just "Ablis"
  for (const name of known) {
    const lastName = name.split(' ')[1].toLowerCase();
    if (cleaned.toLowerCase().includes(lastName)) return name;
  }
  // 3. First-name-only match — handles just "Julius"
  for (const name of known) {
    const firstName = name.split(' ')[0].toLowerCase();
    if (cleaned.toLowerCase() === firstName) return name;
  }
  // 4. Email prefix match — handles "jablis@..." → "Julius Ablis"
  const emailMatch = raw.match(/^([a-z]+)[\.\-_]?([a-z]+)@/i);
  if (emailMatch) {
    const [, part1, part2] = emailMatch;
    for (const name of known) {
      const [first, last] = name.toLowerCase().split(' ');
      if ((part1 === first && part2 === last) || (part1 === last && part2 === first) ||
          last.startsWith(part2.toLowerCase()) || first.startsWith(part1.toLowerCase())) {
        return name;
      }
    }
  }
  return cleaned || raw;
}

// ── Health check — no token needed ───────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    smartsheet_configured: !!process.env.SMARTSHEET_TOKEN,
    anthropic_configured:  !!process.env.ANTHROPIC_API_KEY,
    cody_configured:       !!(process.env.CODY_API_KEY && process.env.CODY_BOT_ID),
    risk_sheets_cached:    _riskSheetCache.length,
    risk_cache_expires:    _riskCacheExpiry ? new Date(_riskCacheExpiry).toISOString() : null,
    risk_walk:             _riskWalkInfo,
    charters_indexed:      Object.keys(_charterIndex.byProject).length,
    charters_parsed:       [..._charterParsed.values()].filter(p => p.result && p.result.parsed).length
  });
});

// ── Force-refresh risk/issue sheet discovery cache ────────────────────────────
// Call this after adding a new project's risk/issue logs to Smartsheet so the
// app picks them up immediately without waiting for the 6-hour TTL.
app.post('/api/risks/refresh', async (req, res) => {
  const sheets = await discoverRiskSheets(true); // force a fresh folder walk
  res.json({ refreshed: true, sheetsFound: sheets.length, walk: _riskWalkInfo, sheets });
});

// Diagnostics: every log the app is reading, where it came from, and how many open
// risk/issue rows it yielded on the last /api/data. Use ?refresh=1 to re-walk the folder.
app.get('/api/risks/sources', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured.' });
  try {
    const sheets = await discoverRiskSheets(req.query.refresh === '1');
    const stat = Object.fromEntries(_lastLogSources.map(x => [x.id, x]));
    res.json({
      rootFolder: PROJECTS_FOLDER_ID, walk: _riskWalkInfo, total: sheets.length,
      sheets: sheets.map(s => ({ ...s, lastRead: stat[s.id] || null }))
    });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ── AI proxy — routes Key Insights + Cody chatbot calls through server ───────
// API key stays server-side; CORS is never an issue.
// Body params:
//   prompt  (string, required) — the current user message
//   system  (string, optional) — system prompt (used by Cody for context)
//   history (array,  optional) — prior conversation turns [{role,content},…]
app.post('/api/ai', async (req, res) => {
  const { prompt, system, history } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY not configured. Add it in the Render environment variables.'
    });
  }

  // Build messages array: prior history + current user message
  const messages = [
    ...(Array.isArray(history) ? history : []),
    { role: 'user', content: prompt }
  ];

  try {
    const payload = {
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages
    };
    // Only include system prompt if provided (Key Insights callers don't send one)
    if (system && typeof system === 'string' && system.trim()) {
      payload.system = system;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':         'application/json',
        'x-api-key':            process.env.ANTHROPIC_API_KEY,
        'anthropic-version':    '2023-06-01'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errBody = await response.text();
      return res.status(502).json({ error: `Anthropic error ${response.status}: ${errBody}` });
    }

    const data = await response.json();
    const text = (data.content || []).map(b => b.text || '').join('');
    res.json({ text });

  } catch (err) {
    console.error('AI proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Cody chatbot proxy ────────────────────────────────────────────────────────
const CODY_BASE = 'https://getcody.ai/api/v1';

function codyHeaders() {
  return {
    'Authorization': `Bearer ${process.env.CODY_API_KEY}`,
    'Content-Type': 'application/json'
  };
}

// Create a new Cody conversation session
app.post('/api/cody/conversation', async (req, res) => {
  if (!process.env.CODY_API_KEY || !process.env.CODY_BOT_ID) {
    return res.status(500).json({ error: 'CODY_API_KEY or CODY_BOT_ID not configured in Render.' });
  }
  try {
    const r = await fetch(`${CODY_BASE}/conversations`, {
      method: 'POST',
      headers: codyHeaders(),
      body: JSON.stringify({
        name: `PMOE Dashboard Session ${Date.now()}`,
        bot_id: process.env.CODY_BOT_ID
      })
    });
    if (!r.ok) {
      const err = await r.text();
      return res.status(502).json({ error: `Cody error ${r.status}: ${err}` });
    }
    const data = await r.json();
    res.json({ conversation_id: data.data?.id });
  } catch (err) {
    console.error('Cody conversation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Hybrid chat endpoint — Cody knowledge base + Claude dashboard intelligence ──
// Strategy:
//   1. Ask Cody first — it has access to your uploaded PMOE knowledge base documents.
//   2. Detect if Cody's answer is a "don't know" response (no info in knowledge base).
//   3. If Cody answered well → return it directly (source: 'cody').
//   4. If Cody didn't know → ask Claude with full dashboard context (source: 'claude').
//   5. If Cody partially answered → Claude enriches it with live dashboard data (source: 'hybrid').
//
// Body: { content, conversation_id, dashboard_context }
//   content           — the user's message
//   conversation_id   — Cody conversation session ID
//   dashboard_context — JSON string of current portfolio state for Claude's context

const CODY_FALLBACK_PHRASES = [
  "i'm unable to provide",
  "i cannot provide",
  "no information",
  "not in my knowledge base",
  "i don't have",
  "i do not have",
  "knowledge base does not",
  "isn't in my knowledge",
  "not available in",
  "unable to find",
  "i lack the",
  "outside my knowledge",
  "i have no information",
  "there is no information",
  "there is no data",
  "i am unable to",
  "my knowledge base",
  "not included in",
  "cannot find any",
  "no details about"
];

function isCodyFallback(text) {
  const lower = (text || '').toLowerCase();
  return CODY_FALLBACK_PHRASES.some(phrase => lower.includes(phrase));
}

async function askClaude(userMessage, dashboardContext, conversationHistory, planText) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const systemPrompt = `You are Ask Cody, the PMOE Virtual Assistant for Cook County Health's Project Management & Operational Excellence (PMOE) department. You help users understand and navigate the Program and Project Management Center dashboard.

You have access to the following live dashboard data (refreshed every 5 minutes from Smartsheet):
${dashboardContext}
${planText || ''}

The dashboard data above includes:
- All active projects with their PM, status, phase, sponsor, and latest deliverable updates
- Risks and issues from EVERY active project's individual Risk Log and Issue Log sheets in the PMOE Workspace — discovered automatically so new project logs appear without any manual configuration
- PM Process Compliance Audit data (charter, project plan, risks log, closeout status)
- Project plan task status: for projects with a live plan sheet, the count of completed / in-progress / not-started tasks, overall percent complete, and the names of completed and in-progress tasks (see the PROJECT PLAN TASK STATUS section)

Guidelines:
- Be concise, warm, and professional.
- When answering about projects, reference specific details from the dashboard data above.
- For questions about tasks completed, progress, or what's done/in-flight on a project, use the PROJECT PLAN TASK STATUS section. Cite specific task names and the percent complete when relevant.
- If a project is not listed in the PROJECT PLAN TASK STATUS section, its plan isn't wired in yet — say task-level detail isn't available for that project and point the user to the relevant PM, rather than guessing.
- For risk and issue questions, look in the risksData section — it covers all active project logs.
- For navigation questions, guide users to the relevant dashboard tab.
- If asked about a specific project, pull its PM, status, phase, and latest update from the data.
- Never mention "Claude", "Anthropic", or that you are an AI language model. You are Cody, PMOE's assistant.
- If truly unable to answer, suggest the user contact the relevant PM directly or press Refresh for the latest live data.`;

  const messages = [
    ...(Array.isArray(conversationHistory) ? conversationHistory : []),
    { role: 'user', content: userMessage }
  ];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: systemPrompt,
        messages
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    return (data.content || []).map(b => b.text || '').join('').trim();
  } catch (e) {
    console.error('Claude fallback error:', e.message);
    return null;
  }
}

app.post('/api/chat', async (req, res) => {
  const { content, conversation_id, dashboard_context, history } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content is required' });

  const hasCody   = !!(process.env.CODY_API_KEY && conversation_id);
  const hasClaude = !!process.env.ANTHROPIC_API_KEY;

  let codyText  = null;
  let codyFailed = false;

  // ── Step 1: Try Cody first ───────────────────────────────────────────────
  if (hasCody) {
    try {
      const r = await fetch(`${CODY_BASE}/messages`, {
        method: 'POST',
        headers: codyHeaders(),
        body: JSON.stringify({ content, conversation_id })
      });
      if (r.ok) {
        const data = await r.json();
        codyText   = data.data?.content || '';
        codyFailed = data.data?.failed_responding || false;
        if (codyFailed) codyText = null;
      }
    } catch (e) {
      console.warn('Cody step failed:', e.message);
      codyFailed = true;
    }
  }

  // ── Step 2: Decide routing ───────────────────────────────────────────────
  const codyDidntKnow = !codyText || isCodyFallback(codyText);

  if (!codyDidntKnow) {
    // Cody answered from its knowledge base — return directly
    return res.json({ text: codyText, source: 'cody' });
  }

  // ── Step 3: Claude fallback / enrichment ────────────────────────────────
  if (hasClaude) {
    // Pull live project-plan task summaries server-side so the bot can answer
    // task-completion / progress questions even if the frontend context is stale.
    let planText = '';
    try {
      planText = planSummariesToText(await fetchProjectPlans());
    } catch (e) {
      console.warn('plan summary fetch failed:', e.message);
    }
    const claudeText = await askClaude(content, dashboard_context || '(no dashboard data provided)', history, planText);
    if (claudeText) {
      return res.json({ text: claudeText, source: codyText ? 'hybrid' : 'claude' });
    }
  }

  // ── Step 4: Last resort — surface whatever Cody said or generic message ──
  return res.json({
    text: codyText || "I'm sorry, I don't have enough information to answer that right now. Please try pressing Refresh to load the latest dashboard data, or reach out to the relevant project manager directly.",
    source: 'fallback'
  });
});

// ── Project Plan parsing ──────────────────────────────────────────────────────
// Returns a COMPACT per-project summary (not raw task dump) so it stays cheap to
// inject into the chatbot's context on every message.
//   { project, totalTasks, complete, inProgress, notStarted, percentComplete,
//     completedTasks: [names], inProgressTasks: [{name, pct}] }
//
// Parent/summary rows: Smartsheet marks them via row.parentId relationships.
// A row is a PARENT if any other row lists it as parentId — those are phase
// headers (e.g. "Facility Readiness") and are excluded from task counts.
function parsePlan(sheetData, projectName) {
  const cols     = sheetData.columns || [];
  const taskId   = cols.find(c => c.title === 'Task')?.id;
  const statusId = cols.find(c => c.title === 'Status')?.id;
  const pctId    = cols.find(c => c.title === '% Complete')?.id;
  const rows     = sheetData.rows || [];

  // Identify parent rows (rows referenced as someone else's parentId)
  const parentIds = new Set();
  rows.forEach(r => { if (r.parentId) parentIds.add(String(r.parentId)); });

  const cellOf = (row, id) => (row.cells || []).find(c => c.columnId == id);

  let complete = 0, inProgress = 0, notStarted = 0;
  const completedTasks  = [];
  const inProgressTasks = [];

  for (const row of rows) {
    // Skip phase-header / summary rows — count only leaf tasks
    if (parentIds.has(String(row.id))) continue;

    const task = (cellOf(row, taskId)?.displayValue || cellOf(row, taskId)?.value || '').toString().trim();
    if (!task) continue;
    // Skip a top-level row whose name equals the project (the plan's title row)
    if (task.toLowerCase() === projectName.toLowerCase()) continue;

    const statusRaw = (cellOf(row, statusId)?.displayValue || cellOf(row, statusId)?.value || '').toString().trim();
    const status    = statusRaw.toLowerCase();
    const pctRaw    = cellOf(row, pctId)?.value;
    const pct       = (pctRaw === 0 || pctRaw) ? Math.round(Number(pctRaw) * 100) : null;

    if (status.includes('complete')) {
      complete++;
      completedTasks.push(task);
    } else if (status.includes('progress')) {
      inProgress++;
      inProgressTasks.push({ name: task, pct });
    } else {
      // "Not Started" or blank/unknown → treat as not started
      notStarted++;
    }
  }

  const totalTasks      = complete + inProgress + notStarted;
  const percentComplete = totalTasks ? Math.round((complete / totalTasks) * 100) : 0;

  return {
    project:        projectName,
    totalTasks,
    complete,
    inProgress,
    notStarted,
    percentComplete,
    completedTasks,
    inProgressTasks
  };
}

async function fetchProjectPlans() {
  if (_planCache && Date.now() < _planCacheExpiry) return _planCache;
  if (!process.env.SMARTSHEET_TOKEN) return _planCache || [];

  try {
    const responses = await Promise.all(
      KNOWN_PLAN_SHEETS.map(s =>
        fetch(`${SS_BASE}/sheets/${s.id}?pageSize=500`, { headers: ssHeaders() })
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      )
    );
    const summaries = responses
      .map((data, i) => data ? parsePlan(data, KNOWN_PLAN_SHEETS[i].project) : null)
      .filter(Boolean);

    _planCache       = summaries;
    _planCacheExpiry = Date.now() + PLAN_CACHE_TTL;
    return summaries;
  } catch (err) {
    console.warn('[Project Plans] fetch failed:', err.message);
    return _planCache || [];
  }
}

// Render plan summaries into a compact text block for the chatbot system context.
function planSummariesToText(summaries) {
  if (!summaries || !summaries.length) return '';
  const lines = ['\nPROJECT PLAN TASK STATUS (live from each project\'s plan sheet):'];
  for (const p of summaries) {
    lines.push(`\n  ${p.project} — ${p.percentComplete}% complete (${p.complete}/${p.totalTasks} tasks done, ${p.inProgress} in progress, ${p.notStarted} not started)`);
    if (p.completedTasks.length) {
      const shown = p.completedTasks.slice(0, 40);
      lines.push(`    Completed: ${shown.join('; ')}${p.completedTasks.length > shown.length ? ` …(+${p.completedTasks.length - shown.length} more)` : ''}`);
    }
    if (p.inProgressTasks.length) {
      const shown = p.inProgressTasks.slice(0, 40)
        .map(t => t.pct != null ? `${t.name} (${t.pct}%)` : t.name);
      lines.push(`    In progress: ${shown.join('; ')}${p.inProgressTasks.length > 40 ? ` …(+${p.inProgressTasks.length - 40} more)` : ''}`);
    }
  }
  return lines.join('\n');
}

// GET /api/project-plans — exposes the compact plan summaries (used by dashboard + debugging)
app.get('/api/project-plans', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) {
    return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured.' });
  }
  try {
    const summaries = await fetchProjectPlans();
    res.json({ fetchedAt: new Date().toISOString(), plans: summaries });
  } catch (err) {
    console.error('Project plans error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Main data endpoint ────────────────────────────────────────────────────────
app.get('/api/data', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) {
    return res.status(500).json({
      error: 'SMARTSHEET_TOKEN not configured. Set it in Render environment variables.'
    });
  }

  try {
    // Unified list of every RAID / Risk / Issues log: known sheets + whatever the walk of
    // the projects folder found (cached 10 min). New logs appear without a deploy.
    const RISK_ISSUE_SHEETS = await discoverRiskSheets();

    // Fetch all Smartsheet sources in parallel (log sheets throttled to 8 in flight)
    const [reportRes, complianceRes, riskIssueData] = await Promise.all([
      fetch(`${SS_BASE}/reports/${REPORT_ID}?pageSize=100`, { headers: ssHeaders() }),
      fetch(`${SS_BASE}/sheets/${COMPLIANCE_SHEET}?pageSize=200`, { headers: ssHeaders() }),
      pooled(RISK_ISSUE_SHEETS, 8, async s => {
        try {
          const r = await ssFetch(`${SS_BASE}/sheets/${s.id}?pageSize=500`);
          return { meta: s, data: r.ok ? await r.json() : null, status: r.status };
        } catch (e) { return { meta: s, data: null, status: 0, error: e.message }; }
      })
    ]);

    if (reportRes.status === 401) {
      return res.status(401).json({ error: 'Smartsheet token invalid. Update SMARTSHEET_TOKEN in Render.' });
    }
    if (!reportRes.ok) {
      return res.status(502).json({ error: `Smartsheet error: ${reportRes.status}` });
    }

    const [reportData, compData] = await Promise.all([
      reportRes.json(),
      complianceRes.json()
    ]);

    // Refresh the live project-name list from the compliance sheet we just fetched so
    // canonProject() can resolve abbreviated log/folder names to dashboard names.
    {
      const pc = (compData.columns || []).find(x => x.title === 'Project')?.id;
      setProjectCandidates((compData.rows || []).map(r =>
        normProjectName((r.cells || []).find(c => c.columnId == pc)?.displayValue || '')));
    }

    // ── Parse PMOE Load-Update report ─────────────────────────────────────
    const cols        = reportData.columns || [];
    const projectVid  = cols.find(c => c.title === 'Projects')?.virtualId;
    const delivVid    = cols.find(c => c.title === 'Deliverable')?.virtualId;
    const statusVid   = cols.find(c => c.title === 'Status')?.virtualId;
    const assignedVid = cols.find(c => c.title === 'Assigned To')?.virtualId;
    const sponsorVid   = cols.find(c => c.title === 'Sponsor')?.virtualId;
    const riskVid     = cols.find(c => c.title === 'Risk or Issue')?.virtualId;
    const impactVid   = cols.find(c => c.title === 'Impact/Notes')?.virtualId;

    const projectMap = {};
    (reportData.rows || []).forEach(row => {
      const cell    = vid => (row.cells || []).find(c => c.virtualColumnId == vid);
      // Canonicalise the project name at the point of ingest. Smartsheet sources
      // use several variants (e.g. "Provident ICU and CTSC Closure"); the frontend
      // keys CHARTER_DATA / CLOSURE_REPORTS off the canonical name, so normalising
      // here fixes the lookup for every downstream consumer at once.
      const project = normProjectName(cell(projectVid)?.displayValue || '');
      const deliv   = cell(delivVid)?.displayValue   || '';
      const status  = cell(statusVid)?.displayValue  || '';
      const pm      = normalisePM(cell(assignedVid)?.displayValue || '');
      const risk    = cell(riskVid)?.displayValue    || '';
      const impact  = cell(impactVid)?.displayValue  || '';
      const date    = (row.modifiedAt || '').split('T')[0];

      if (!project) return;

      const sponsor = cell(sponsorVid)?.displayValue || '';

      if (!projectMap[project]) {
        projectMap[project] = { project, pm, sponsor, lastUpdated: date, deliverables: [] };
      }
      if (deliv || status) {
        projectMap[project].deliverables.push({
          name: deliv, status, risk: risk || '', impact: impact || ''
        });
      }
      if (pm      && !projectMap[project].pm)      projectMap[project].pm      = normalisePM(pm);
      if (sponsor && !projectMap[project].sponsor) projectMap[project].sponsor  = sponsor;
      if (date > (projectMap[project].lastUpdated || '')) projectMap[project].lastUpdated = date;
    });

    const pmoeLoadData = Object.values(projectMap);
    setProjectCandidates([..._projectCandidates, ...pmoeLoadData.map(p => p.project)]);

    // ── Back-fill PM & sponsor from compliance data when report row is blank ──
    // The PMOE Load-Update report's "Assigned To" cell may be empty for newly added
    // projects (e.g. Provident ICU Closure). Compliance sheet reliably has the PM.
    // We do a second pass after complianceParsed is built (below) to fill gaps.

    // ── Parse risk & issue log sheets ─────────────────────────────────────
    // parseLogSheet() chooses the legacy or Type-column (RAID) parser from each sheet's
    // actual columns. Unreadable sheets are logged and skipped, never fatal.
    const logSourceStats = [];
    const risksData = riskIssueData.flatMap(({ meta, data, status, error }) => {
      if (!data) {
        console.warn(`[Risk logs] ${meta.id} (${meta.project} / ${meta.name || meta.type}) not readable: ${error || status}`);
        logSourceStats.push({ id: meta.id, project: meta.project, type: meta.type, src: meta.src, ok: false, status: error || status });
        return [];
      }
      const recs = parseLogSheet(data, meta);
      logSourceStats.push({ id: meta.id, name: data.name || meta.name || '', project: meta.project, type: meta.type, src: meta.src, ok: true, rows: recs.length });
      return recs;
    });
    _lastLogSources = logSourceStats;

    // ── Parse PM Process Compliance Audit ─────────────────────────────────
    const cc        = compData.columns || [];
    const projId    = cc.find(x => x.title === 'Project')?.id;
    const pmId      = cc.find(x => x.title === 'Project Manager')?.id;
    const charterId = cc.find(x => x.title === 'Project Charter - Final Version')?.id;
    const planId    = cc.find(x => x.title === 'Project Plan')?.id;
    const risksId   = cc.find(x => x.title === 'Risks Log')?.id;
    const closeId   = cc.find(x => x.title === 'Closeout Report')?.id;
    const statId    = cc.find(x => x.title === 'Status')?.id;

    const toVal = cell => {
      if (!cell) return false;
      if (cell.value === true)  return true;
      if (cell.value === false) return false;
      if (cell.displayValue === 'NA') return 'NA';
      return !!cell.value;
    };

    const complianceParsed = (compData.rows || []).map(row => {
      const cell = id => (row.cells || []).find(c => c.columnId == id);
      const name = normProjectName(cell(projId)?.displayValue || '');
      if (!name) return null;
      return {
        project:  name,
        pm:       normalisePM(cell(pmId)?.displayValue || ''),
        charter:  toVal(cell(charterId)),
        plan:     toVal(cell(planId)),
        risks:    toVal(cell(risksId)),
        closeout: toVal(cell(closeId)),
        status:   cell(statId)?.displayValue || ''
      };
    }).filter(Boolean);


    // ── Back-fill PM from compliance data for any pmoeLoadData entry missing a PM ──
    // The PMOE Load-Update report's "Assigned To" may be empty for newly added
    // projects (e.g. Provident ICU Closure). Compliance sheet reliably has the PM.
    const compPmLookup = {};
    complianceParsed.forEach(c => {
      if (c.project && c.pm) compPmLookup[c.project.toLowerCase().trim()] = c.pm;
    });
    pmoeLoadData.forEach(p => {
      if (!p.pm && p.project) {
        const fallback = compPmLookup[p.project.toLowerCase().trim()];
        if (fallback) p.pm = fallback;
      }
    });
    // ── Return all live data ──────────────────────────────────────────────
    res.json({
      fetchedAt:      new Date().toISOString(),
      pmoeLoadData,
      risksData,
      complianceData: complianceParsed,
      meta: {
        projectRows:    pmoeLoadData.length,
        riskRows:       risksData.length,
        riskSheets:     RISK_ISSUE_SHEETS.length,
        riskSheetsUnreadable: logSourceStats.filter(x => !x.ok).length,
        complianceRows: complianceParsed.length
      }
    });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Master File endpoint — phases, sponsors, PM from PMOE Load (Master File) ──
// Sheet ID: 6897799930374020
const MASTER_SHEET = '6897799930374020';

app.get('/api/master', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) {
    return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured.' });
  }
  try {
    // Fetch ALL columns — no columnIds filter so we get everything including Start/End
    const r = await fetch(
      `${SS_BASE}/sheets/${MASTER_SHEET}?pageSize=500`,
      { headers: ssHeaders() }
    );
    if (!r.ok) return res.status(502).json({ error: `Smartsheet ${r.status}` });
    const data = await r.json();

    const cols     = data.columns || [];
    const initId   = cols.find(c => c.title === 'Initiative')?.id;
    const statusId = cols.find(c => c.title === 'Status')?.id;
    const phaseId  = cols.find(c => c.title === 'Phase')?.id;
    const sponsorId= cols.find(c => c.title === 'Sponsors')?.id;
    const pmId     = cols.find(c => c.title === 'Project Manager')?.id;
    const startId  = cols.find(c => c.title === 'Start')?.id;
    const endId    = cols.find(c => c.title === 'End')?.id;
    const domainId = cols.find(c => c.title === 'Strategic Domain')?.id;
    const healthId = cols.find(c => c.title === 'Health Status')?.id;

    // ── Parent/child detection ────────────────────────────────────────────
    // In the Master File, top-level projects and their sub-deliverable rows
    // BOTH carry an Initiative name. Sub-deliverable rows are CHILD rows and
    // carry a parentId. We treat a row as a top-level PROJECT only when it has
    // NO parentId, and skip any row that has one.
    //
    // This replaces the old "empty phase = child" heuristic, which wrongly
    // dropped Complete/Closed projects (a closed project has phase "Closed",
    // not empty) and let some child rows through.
    const allRows = data.rows || [];

    // Valid top-level statuses in this sheet: In Progress, On Hold, Complete,
    // Cancelled, Not Started. We now return ALL of them (previously only
    // In Progress / On Hold) so the frontend can RE-BUCKET a project when its
    // status changes (e.g. → Complete) instead of the card silently staying in
    // Active with a stale status/phase and a blanked-out PM.
    const VALID_STATUSES = ['In Progress', 'On Hold', 'Complete', 'Completed', 'Cancelled', 'Not Started'];

    const projects = allRows.map(row => {
      const cell = id => (row.cells || []).find(c => c.columnId == id);
      const rawName = cell(initId)?.displayValue;
      if (!rawName) return null;

      // Skip sub-deliverable / child rows — they carry a parentId.
      if (row.parentId) return null;

      const name = normProjectName(rawName);
      const status = cell(statusId)?.displayValue || '';
      if (!VALID_STATUSES.includes(status)) return null;

      const phase = cell(phaseId)?.displayValue || '';
      return {
        name,
        status,
        phase,
        sponsor: cell(sponsorId)?.displayValue || '',
        pm:      normalisePM(cell(pmId)?.displayValue || ''),
        start:   cell(startId)?.value          || '',
        end:     cell(endId)?.value            || '',
        domain:  cell(domainId)?.displayValue  || '',
        health:  cell(healthId)?.displayValue  || 'Green',
      };
    }).filter(Boolean);

    res.json({ fetchedAt: new Date().toISOString(), projects });
  } catch (err) {
    console.error('Master error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── Project Benefits Monitoring endpoint ──────────────────────────────────────
// Live-reads the Program Benefits Register so the "PRB Projects – Benefits
// Register" tab picks up Smartsheet edits automatically.
//
// IMPORTANT (source of truth): the confirmed, accessible Benefits Register
// sheet is 3430790473928580 ("Program Benefits Register - For Chiefs"). The ID
// 1883548111136644 that was requested is NOT readable by this API token (it
// returns 403 / not-found), so it is NOT used here. To switch sources later,
// set the BENEFITS_SHEET env var in Render to the correct, SHARED sheet ID —
// no code change needed. Until then it defaults to the known-good sheet.
const BENEFITS_SHEET = process.env.BENEFITS_SHEET || '3430790473928580';

// Health symbol → the frontend's { health: 'Yes' | 'Hold' | 'No' } values.
function normBenefitHealth(v) {
  const s = (v || '').toString().trim().toLowerCase();
  if (s === 'yes' || s === 'green')  return 'Yes';
  if (s === 'hold' || s === 'yellow')return 'Hold';
  if (s === 'no'  || s === 'red')    return 'No';
  return v || '';
}

// "2023.0" → "2023"; leaves "2025 (Dec-May)" and "2026 (Q2)" untouched.
function normFiscalYear(v) {
  const s = (v || '').toString().trim();
  const m = s.match(/^(\d{4})\.0$/);
  return m ? m[1] : s;
}

app.get('/api/benefits', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) {
    return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured.' });
  }
  try {
    const r = await fetch(
      `${SS_BASE}/sheets/${BENEFITS_SHEET}?pageSize=500`,
      { headers: ssHeaders() }
    );
    if (r.status === 401) {
      return res.status(401).json({ error: 'Smartsheet token invalid. Update SMARTSHEET_TOKEN in Render.' });
    }
    if (r.status === 403 || r.status === 404) {
      // Sheet not shared to this token / wrong ID — tell the client to keep
      // its embedded data rather than blanking the page.
      return res.status(200).json({
        fetchedAt: new Date().toISOString(),
        benefits: [],
        warning: `Benefits sheet ${BENEFITS_SHEET} not accessible (HTTP ${r.status}). Share it with the API account or fix BENEFITS_SHEET.`
      });
    }
    if (!r.ok) return res.status(502).json({ error: `Smartsheet ${r.status}` });
    const data = await r.json();

    const cols = data.columns || [];
    const col = (...titles) => {
      for (const t of titles) {
        const c = cols.find(x => x.title === t);
        if (c) return c.id;
      }
      return null;
    };
    const programId  = col('Program');
    const projectId  = col('Program Component (Project)', 'Project', 'Program Component');
    const fyId       = col('Fiscal Year', 'FY');
    const metricId   = col('Metric');
    const plannedId  = col('Projected/Planned Benefit', 'Planned', 'Projected Benefit');
    const actualId   = col('Actual Performance', 'Actual');
    const ratioId    = col('Performance Ratio', 'Ratio');
    const healthId   = col('Performance Health', 'Health');

    // Rows use fill-down: blank Program / Project cells inherit the value from
    // the row above (the sheet is sorted so grouped rows share a header).
    let lastProgram = '';
    let lastProject = '';

    const benefits = (data.rows || []).map(row => {
      const cellVal = id => {
        if (!id) return '';
        const c = (row.cells || []).find(x => x.columnId == id);
        return (c && (c.displayValue != null ? c.displayValue : c.value)) || '';
      };

      let program = cellVal(programId).toString().trim();
      let project = cellVal(projectId).toString().trim();
      if (program) lastProgram = program; else program = lastProgram;
      if (project) lastProject = project; else project = lastProject;

      const fy      = normFiscalYear(cellVal(fyId));
      const metric  = cellVal(metricId).toString().trim();
      const planned = cellVal(plannedId).toString();
      const actual  = cellVal(actualId).toString();
      const ratioRaw= cellVal(ratioId).toString().trim();
      const health  = normBenefitHealth(cellVal(healthId));

      // Skip fully-empty spacer rows.
      if (!project && !planned && !actual && !fy) return null;

      const ratioNum = parseFloat(ratioRaw);
      return {
        program,
        project,
        fy,
        metric,
        planned,
        actual,
        ratio: isNaN(ratioNum) ? null : ratioNum,
        health
      };
    }).filter(Boolean);

    res.json({ fetchedAt: new Date().toISOString(), benefits, sheet: BENEFITS_SHEET });
  } catch (err) {
    console.error('Benefits error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── EARN / Domestic Spend endpoint ────────────────────────────────────────────
// Reads the EARN Leadership Dashboard (a Smartsheet Sight) and reconstructs the
// exact metrics/series so the "Domestic Spend (EARN)" tab mirrors the dashboard
// and updates on every refresh.
//
// Why read the DASHBOARD and not the backing sheet (2007482860785540): that
// sheet is a 167-row widget scratch-pad with generic column names and stacked
// mini-tables — label-matching against it is fragile. The dashboard's widget
// payloads, by contrast, carry clean titled series (e.g. "FY 2026 Domestic
// Spend", "2026 Pharmacy Domestic Spend Actual vs Budgeted"), which is a far
// more stable contract. Set EARN_DASHBOARD in Render to repoint if needed.
const EARN_DASHBOARD = process.env.EARN_DASHBOARD || '1883548111136644';

// A Sight chart series holds points as { x, y } (or an array under .data).
function seriesPoints(series) {
  if (!series) return [];
  const raw = series.data || series.seriesData || [];
  return (raw || []).map(pt => ({
    x: pt.x != null ? pt.x : (pt.xValue != null ? pt.xValue : ''),
    y: (pt.y != null ? pt.y : (pt.yValue != null ? pt.yValue : null))
  }));
}
function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

app.get('/api/earn', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) {
    return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured.' });
  }
  try {
    const r = await fetch(
      `${SS_BASE}/sights/${EARN_DASHBOARD}`,
      { headers: ssHeaders() }
    );
    if (r.status === 401) {
      return res.status(401).json({ error: 'Smartsheet token invalid. Update SMARTSHEET_TOKEN in Render.' });
    }
    if (r.status === 403 || r.status === 404) {
      // Dashboard not shared to this token / wrong ID — tell the client to keep
      // its embedded values rather than blanking the tab.
      return res.status(200).json({
        accessible: false,
        warning: `EARN dashboard ${EARN_DASHBOARD} not accessible (HTTP ${r.status}). Share it with the API account or fix EARN_DASHBOARD.`
      });
    }
    if (!r.ok) return res.status(502).json({ error: `Smartsheet ${r.status}` });
    const sight = await r.json();

    const widgets = sight.widgets || [];
    const byTitle = t => widgets.find(w => (w.title || '').trim() === t);
    const allByTitle = t => widgets.filter(w => (w.title || '').trim() === t);

    // ── Metric tiles ──────────────────────────────────────────────────────
    // Several METRIC widgets share the title "FY 2025 Domestic Spend" /
    // "FY 2026 Domestic Spend"; distinguish them by their cell label
    // (Empaneled / Non Empaneled / TOTAL).
    function metricByLabel(title, labelIncludes) {
      const list = allByTitle(title);
      for (const w of list) {
        const cd = w.contents?.cellData?.[0];
        const label = (cd?.label || '').toLowerCase();
        if (label.includes(labelIncludes.toLowerCase())) {
          return numOrNull(cd?.cell?.objectValue ?? cd?.cell?.value ?? cd?.cell?.displayValue);
        }
      }
      return null;
    }

    const fy2025 = {
      empaneled:    metricByLabel('FY 2025 Domestic Spend', 'empaneled'),
      nonEmpaneled: metricByLabel('FY 2025 Domestic Spend', 'non empaneled'),
      total:        metricByLabel('FY 2025 Domestic Spend', 'total'),
      goal:         139000000,
      awayFromGoal: null,
    };
    const fy2026 = {
      empaneled:    metricByLabel('FY 2026 Domestic Spend', 'empaneled'),
      nonEmpaneled: metricByLabel('FY 2026 Domestic Spend', 'non empaneled'),
      total:        metricByLabel('FY 2026 Domestic Spend', 'total'),
      goal:         137700000,
      awayFromGoal: null,
    };
    if (fy2025.total != null) fy2025.awayFromGoal = fy2025.total - fy2025.goal;
    if (fy2026.total != null) fy2026.awayFromGoal = fy2026.goal - fy2026.total;

    // ── Pharmacy budget vs actual (two line series each year) ──────────────
    function pharmacyFromChart(title, budgetTitleIncludes, actualTitleIncludes) {
      const w = byTitle(title);
      const series = w?.contents?.series || [];
      const findSeries = inc => series.find(s => (s.title || '').toLowerCase().includes(inc));
      const budgetS = findSeries(budgetTitleIncludes);
      const actualS = findSeries(actualTitleIncludes);
      const bPts = seriesPoints(budgetS);
      const aPts = seriesPoints(actualS);
      const months = (bPts.length ? bPts : aPts).map(p => p.x);
      return months.map((m, i) => ({
        month:  m,
        budget: numOrNull(bPts[i]?.y),
        actual: numOrNull(aPts.find(p => p.x === m)?.y)
      }));
    }
    const pharmacyFY2025 = pharmacyFromChart('2025 Pharmacy Domestic Spend Budgeted vs Actual', 'budget', 'actual');
    const pharmacyFY2026 = pharmacyFromChart('2026 Pharmacy Domestic Spend Actual vs Budgeted', 'budget', 'total');

    // ── FY2026 Empaneled vs Non-Empaneled by month ────────────────────────
    let monthlyBreakdown = [];
    {
      const w = byTitle('FY2026 Domestic Spend Empaneled and Non Empaneled');
      const series = w?.contents?.series || [];
      const emp = seriesPoints(series.find(s => (s.title||'').toLowerCase().includes('empaneled') && !(s.title||'').toLowerCase().includes('non')));
      const non = seriesPoints(series.find(s => (s.title||'').toLowerCase().includes('non')));
      const months = (emp.length ? emp : non).map(p => p.x);
      monthlyBreakdown = months.map((m, i) => ({
        month: m,
        empaneled:    numOrNull(emp[i]?.y),
        nonEmpaneled: numOrNull(non.find(p => p.x === m)?.y)
      }));
    }

    // ── FY2026 Domestic Spend Month over Month (total per month) ──────────
    // Previously NOT returned by this endpoint, so the app kept its embedded
    // (stale) baseline. Find the widget by title (tolerant of spacing/case),
    // then fall back to any chart widget whose title mentions month over month.
    const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const fullMonth = x => {
      const t = String(x == null ? '' : x).trim().toLowerCase();
      const i = MONTH_NAMES.findIndex(m => m.toLowerCase().startsWith(t.slice(0, 3)) && t.length >= 3);
      return i >= 0 ? MONTH_NAMES[i] : String(x);
    };
    let monthlyTotal = [];
    let monthlyTotalSource = 'none';
    {
      const norm = t => (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const cands = widgets.filter(w => /month over month/.test(norm(w.title)));
      const w = cands.find(x => /2026/.test(norm(x.title))) || cands[0];
      const series = w?.contents?.series || [];
      if (w && series.length) {
        // Prefer a series named like total; otherwise the first series.
        const sr = series.find(s2 => /total/i.test(s2.title || '')) || series[0];
        const pts = seriesPoints(sr);
        monthlyTotal = pts.map(p => ({ month: fullMonth(p.x), total: numOrNull(p.y) }));
        monthlyTotalSource = 'widget:' + (w.title || '');
      }
      if (!monthlyTotal.some(m => m.total != null) && monthlyBreakdown.some(m => m.empaneled != null)) {
        // Last resort: derive from the live Empaneled + Non-Empaneled widget.
        monthlyTotal = monthlyBreakdown.map(m => ({
          month: fullMonth(m.month),
          total: (m.empaneled == null && m.nonEmpaneled == null) ? null : (m.empaneled || 0) + (m.nonEmpaneled || 0)
        }));
        monthlyTotalSource = 'derived-from-breakdown';
      }
    }

    // ── Cumulative EARN KPI (2025 vs 2026) ────────────────────────────────
    let cumulative = { fy2025: [], fy2026: [] };
    {
      const w = byTitle('EARN KPI Report');
      const series = w?.contents?.series || [];
      const s25 = seriesPoints(series.find(s => (s.title||'').includes('2025')));
      const s26 = seriesPoints(series.find(s => (s.title||'').includes('2026')));
      cumulative.fy2025 = s25.map(p => ({ month: p.x, value: numOrNull(p.y) }));
      cumulative.fy2026 = s26.map(p => ({ month: p.x, value: numOrNull(p.y) }));
    }

    // ── CountyCare members ─────────────────────────────────────────────────
    let countyCareMembers = [];
    {
      const w = byTitle('CountyCare Members at CCH');
      const s = seriesPoints((w?.contents?.series || [])[0]);
      countyCareMembers = s.map(p => ({ month: p.x, members: numOrNull(p.y) }));
    }

    // ── Care coordination (pie) ────────────────────────────────────────────
    let careCoordination = [];
    {
      const w = byTitle('Top 1% of Patients Enrolled in Care Coordination');
      const s = seriesPoints((w?.contents?.series || [])[0]);
      careCoordination = s.map(p => ({ label: p.x, value: numOrNull(p.y) }));
    }

    // ── Revenue resubmission of claims (bar) ───────────────────────────────
    let revenueClaims = [];
    {
      const w = byTitle('Revenue Resubmission of Claims');
      (w?.contents?.series || []).forEach(sr => {
        const pts = seriesPoints(sr);
        // horizontal bars: value is on x
        const val = numOrNull(pts[0]?.x ?? pts[0]?.y);
        if (sr.title) revenueClaims.push({ label: sr.title, value: val });
      });
    }

    // Diff tiles
    const pharmacyFY2025diff = metricByLabel('FY2025 Difference Actual vs Budgeted', '') ?? null;
    const pharmacyFY2026diff = metricByLabel('FY2026 Difference Actual vs Budgeted', '') ?? null;

    res.json({
      accessible: true,
      fetchedAt: new Date().toISOString(),
      fy2025, fy2026,
      pharmacyFY2025, pharmacyFY2026,
      pharmacyFY2025diff, pharmacyFY2026diff,
      monthlyBreakdown, monthlyTotal, monthlyTotalSource, cumulative,
      countyCareMembers, careCoordination, revenueClaims
    });
  } catch (err) {
    console.error('EARN error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── Generic Smartsheet dashboard reader ───────────────────────────────────────
// GET /api/dashboard?id=<sightId>
// Reads any allow-listed Smartsheet Sight and returns a normalized, render-ready
// payload: { title, metrics[], charts[], tables[] } so the frontend can draw
// native tiles / charts / tables. Same philosophy as /api/earn, but content-
// agnostic. Powers the Benefits Monitoring dashboards (Agency Staffing
// Utilization, ACHN Provider & Ops Coordination).
const DASHBOARD_ALLOW = new Set([
  '7309380296173444',  // Copy of CCH Agency Staffing Request & Utilization Tracker
  '1398405785249668',  // Copy of ACHN Provider and Operations Coordination
  '1883548111136644',  // EARN (parity)
]);

// Reduce a GRIDGANTT widget's htmlContent to a clean { headers[], rows[][] }.
// Smartsheet wraps some cell text in a NESTED <table> (spacer/expander layout),
// so we first flatten any nested tables to their plain text before splitting the
// outer grid into rows/cells.
// Sanitize Smartsheet widget rich-text/title HTML into a safe subset the
// dashboard can render verbatim: keep paragraphs, line breaks, and inline
// emphasis + color/alignment; drop scripts, classes, and everything else.
function sanitizeSsHtml(html) {
  if (!html || typeof html !== 'string') return '';
  let s = html;
  // strip anything dangerous / structural
  s = s.replace(/<\s*(script|style|iframe|object|embed|link|meta)[\s\S]*?<\/\s*\1\s*>/gi, '');
  s = s.replace(/<\s*(script|style|iframe|object|embed|link|meta)[^>]*\/?>/gi, '');
  s = s.replace(/on\w+\s*=\s*"[^"]*"/gi, '').replace(/on\w+\s*=\s*'[^']*'/gi, '');
  // keep only a whitelist of tags; convert others to their text by stripping tags
  const allowed = new Set(['p','br','span','b','strong','i','em','u','ul','ol','li','div']);
  s = s.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (m, tag, attrs) => {
    const t = tag.toLowerCase();
    if (!allowed.has(t)) return '';
    if (m[1] === '/') return `</${t}>`;
    // sanitize style: keep a few visual properties only
    let style = '';
    const sm = attrs.match(/style\s*=\s*"([^"]*)"/i) || attrs.match(/style\s*=\s*'([^']*)'/i);
    if (sm) {
      const keep = [];
      sm[1].split(';').forEach(decl => {
        const [propRaw, valRaw] = decl.split(':');
        if (!propRaw || !valRaw) return;
        const prop = propRaw.trim().toLowerCase();
        const val  = valRaw.trim();
        if (['color','font-weight','font-style','text-decoration','text-align','font-size'].includes(prop)
            && /^[#a-zA-Z0-9 ,.\(\)%-]+$/.test(val)) {
          keep.push(`${prop}:${val}`);
        }
      });
      if (keep.length) style = ` style="${keep.join(';')}"`;
    }
    return `<${t}${style}>`;
  });
  return s.trim();
}

function parseGridHtml(html) {
  if (!html || typeof html !== 'string') return null;

  const strip = s => s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim();

  // Find the OUTER grid table with a depth counter (nested tables mean a plain
  // non-greedy regex would stop at the first inner </table>).
  const startRe = /<table[^>]*clsGridGantt[^>]*>/i;
  let sm = html.match(startRe);
  let startIdx = sm ? html.indexOf(sm[0]) : -1;
  if (startIdx < 0) { const g = html.match(/<table\b/i); startIdx = g ? html.indexOf(g[0]) : -1; }
  if (startIdx < 0) return null;
  const openTag = (html.slice(startIdx).match(/^<table[^>]*>/i) || ['<table>'])[0];
  let i = startIdx + openTag.length, depth = 1, endIdx = -1;
  const tokRe = /<(\/?)table\b[^>]*>/gi;
  tokRe.lastIndex = i;
  let tk;
  while ((tk = tokRe.exec(html))) {
    depth += tk[1] ? -1 : 1;
    if (depth === 0) { endIdx = tk.index + tk[0].length; break; }
  }
  if (endIdx < 0) endIdx = html.length;
  let table = html.slice(startIdx, endIdx);

  // Separate the outer wrapper so we only flatten nested tables in the interior.
  let inner = table.slice(openTag.length).replace(/<\/table>\s*$/i, '');

  // Flatten nested tables (inside cells) to plain text, innermost-first, so the
  // outer row/cell splitter isn't confused by inner <tr>/<td>.
  let guard = 0;
  while (/<table\b/i.test(inner) && guard < 30) {
    guard++;
    const next = inner.replace(/<table\b(?:(?!<table\b)[\s\S])*?<\/table>/gi, m => ' ' + strip(m) + ' ');
    if (next === inner) break;
    inner = next;
  }
  table = openTag + inner + '</table>';

  // Headers from <thead>
  let headers = [];
  const thead = table.match(/<thead[\s\S]*?<\/thead>/i);
  if (thead) {
    const ths = thead[0].match(/<td\b[\s\S]*?<\/td>/gi) || [];
    headers = ths.map(strip);
    if (headers.length && headers[0] === '') headers.shift();
  }

  // Rows from <tbody> (fall back to whole table minus thead)
  const tbody = table.match(/<tbody[\s\S]*?<\/tbody>/i);
  const bodyHtml = tbody ? tbody[0] : table.replace(/<thead[\s\S]*?<\/thead>/i, '');
  const rows = [];
  const trs = bodyHtml.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trs) {
    const tds = tr.match(/<td\b[\s\S]*?<\/td>/gi) || [];
    let cells = tds.map(strip);
    if (cells.length && cells[0] === '') cells.shift();   // drop 0-width spacer col
    if (cells.some(c => c !== '')) rows.push(cells);
  }
  if (!headers.length && !rows.length) return null;
  return { headers, rows: rows.slice(0, 60) };
}

app.get('/api/dashboard', async (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id query param required' });
  if (!DASHBOARD_ALLOW.has(id)) {
    return res.status(403).json({ error: `Dashboard ${id} is not on the allow-list.` });
  }
  if (!process.env.SMARTSHEET_TOKEN) {
    return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured.' });
  }
  try {
    const r = await fetch(`${SS_BASE}/sights/${id}`, { headers: ssHeaders() });
    if (r.status === 401) return res.status(401).json({ error: 'Smartsheet token invalid.' });
    if (r.status === 403 || r.status === 404) {
      return res.status(200).json({
        accessible: false,
        warning: `Dashboard ${id} not accessible (HTTP ${r.status}). Share it with the API account.`
      });
    }
    if (!r.ok) return res.status(502).json({ error: `Smartsheet ${r.status}` });
    const sight = await r.json();

    const widgets = (sight.widgets || []).slice().sort((a, b) => {
      const ay = a.yPosition ?? 0, by = b.yPosition ?? 0;
      if (ay !== by) return ay - by;
      return (a.xPosition ?? 0) - (b.xPosition ?? 0);
    });

    const metrics = [], charts = [], tables = [];
    const blocks = [];   // ordered, faithful reproduction of every widget

    for (const w of widgets) {
      const type  = (w.type || '').toUpperCase();
      const title = (w.title || '').trim();
      const c     = w.contents || {};
      const pos   = { x: w.xPosition ?? 0, y: w.yPosition ?? 0, w: w.width ?? 0, h: w.height ?? 0 };
      const showTitle = w.showTitle !== false;

      if (type === 'TITLE') {
        const html = sanitizeSsHtml(c.htmlContent || '');
        if (html) blocks.push({ kind: 'title', pos, html });
        continue;
      }

      if (type === 'RICHTEXT') {
        const html = sanitizeSsHtml(c.htmlContent || '');
        // Keep the widget even if body is empty but it has a heading — the
        // title itself is a section label the PM authored ("Pending Requests…").
        if (html || title) blocks.push({ kind: 'note', pos, title: showTitle ? title : '', html });
        continue;
      }

      if (type === 'IMAGE') {
        // Logos etc. — record so the layout order is faithful, but the client
        // only shows a subtle placeholder (we don't proxy the private image).
        blocks.push({ kind: 'image', pos, fileName: (c.fileName || '').trim() });
        continue;
      }

      if (type === 'METRIC') {
        // A METRIC widget can carry several labeled values (e.g. TAT: Target /
        // Actual / ACHN / ACT-CORE). Capture ALL of them in order.
        const items = [];
        for (const cd of (c.cellData || [])) {
          const label = (cd.label || '').trim();
          const disp  = cd.cell?.displayValue ?? cd.profileField?.displayValue;
          const raw   = disp ?? cd.objectValue ?? cd.cell?.objectValue ?? cd.cell?.value
                      ?? cd.profileField?.objectValue;
          const value = numOrNull(raw);
          if (value == null && (raw == null || raw === '')) continue;
          const display = disp != null ? String(disp) : (value != null ? String(value) : String(raw));
          items.push({ label, value: value != null ? value : raw, display });
          // keep flat metrics[] for older callers
          metrics.push({ title: title || label || 'Metric', label, value: value != null ? value : raw, display });
        }
        if (items.length) blocks.push({ kind: 'metric', pos, title: showTitle ? title : '', items });
        continue;
      }

      if (type === 'CHART') {
        const series = (c.series || []).map(s => ({
          name: (s.title || '').trim(),
          points: seriesPoints(s)
            .map(p => ({ x: p.x, y: numOrNull(p.y) ?? numOrNull(p.x) }))
            .filter(pt => pt.x !== '' && pt.x != null)
        })).filter(s => s.points.length);
        if (series.length) {
          charts.push({ title, series });
          blocks.push({ kind: 'chart', pos, title: showTitle ? title : title, series });
        }
        continue;
      }

      if (type === 'GRIDGANTT') {
        const parsed = parseGridHtml(c.htmlContent);
        if (parsed) {
          tables.push({ title, headers: parsed.headers, rows: parsed.rows });
          blocks.push({ kind: 'table', pos, title: showTitle ? title : title, headers: parsed.headers, rows: parsed.rows });
        }
        continue;
      }
    }

    res.json({
      accessible: true,
      fetchedAt: new Date().toISOString(),
      id,
      title: sight.name || '',
      permalink: sight.permalink || '',
      blocks,
      metrics, charts, tables
    });
  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── PMOE Tools: sheet ID for tool catalogue ───────────────────────────────────
// ── PMOE Tools ────────────────────────────────────────────────────────────────
const TOOLS_SHEET_ID  = '6284275220434820';
const COVER_COLUMN_ID = '1045942156693380';

// Batch-fetch pre-signed image URLs for a list of Smartsheet imageIds.
// Uses POST /sheets/{id}/cells/imageurls which is the correct API for SYS_CELLIMAGE cells.
// Returns a map of { imageId → url }.
async function batchImageUrls(imageIds) {
  if (!imageIds.length) return {};
  try {
    const body = imageIds.map(id => ({ imageId: id }));
    const r = await fetch(`${SS_BASE}/sheets/${TOOLS_SHEET_ID}/cells/imageurls`, {
      method:  'POST',
      headers: { ...ssHeaders(), 'Content-Type': 'application/json' },
      body:    JSON.stringify(body)
    });
    if (!r.ok) {
      console.warn('imageurls batch failed:', r.status, await r.text().catch(() => ''));
      return {};
    }
    const data = await r.json();
    // Response: array of { imageId, url }
    const map = {};
    for (const item of (data || [])) {
      if (item.imageId && item.url) map[item.imageId] = item.url;
    }
    return map;
  } catch (e) {
    console.warn('batchImageUrls error:', e.message);
    return {};
  }
}

// GET /api/cover-image?rowId=<rowId>
// Proxies the cover image for a given sheet row.
// Fetches sheet row to get the imageId, then resolves the temp S3 URL via
// the batch imageurls API, then streams the bytes to the client.
// Using buffer (arrayBuffer) instead of pipe() for node-fetch v2 compatibility.
app.get('/api/cover-image', async (req, res) => {
  const { rowId } = req.query;
  if (!rowId) return res.status(400).send('rowId required');
  if (!process.env.SMARTSHEET_TOKEN) return res.status(500).send('Token not configured');

  try {
    // Fetch the row to get the Cover cell's image object
    const rowRes = await fetch(
      `${SS_BASE}/sheets/${TOOLS_SHEET_ID}/rows/${rowId}?include=objectValue`,
      { headers: ssHeaders() }
    );
    if (!rowRes.ok) return res.status(rowRes.status).send('Row fetch failed');
    const rowData = await rowRes.json();

    // Find the Cover cell and extract the imageId
    const coverCell = (rowData.cells || []).find(c => String(c.columnId) === COVER_COLUMN_ID);
    const imageId   = coverCell?.image?.id || coverCell?.image?.imageId || '';

    if (!imageId) return res.status(404).send('No cover image for this row');

    // Resolve the imageId to a temporary S3 URL
    const urlMap   = await batchImageUrls([imageId]);
    const imageUrl = urlMap[imageId];

    if (!imageUrl) return res.status(404).send('Image URL not resolved');

    // Fetch image as a buffer and send to client
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return res.status(502).send('Image S3 fetch failed');

    const buffer      = await imgRes.buffer();          // node-fetch v2 .buffer()
    const contentType = imgRes.headers.get('content-type') || 'image/png';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);

  } catch (err) {
    console.error('cover-image error:', err.message);
    res.status(500).send(err.message);
  }
});

// GET /api/tools
// Returns all tools with file download URLs. Cover images are served separately
// via /api/cover-image so they can be fetched fresh with auth on demand.
app.get('/api/tools', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) {
    return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured.' });
  }
  try {
    // Fetch sheet (with objectValue to get cell image objects) and attachments in parallel
    const [sheetRes, attachListRes] = await Promise.all([
      fetch(`${SS_BASE}/sheets/${TOOLS_SHEET_ID}?pageSize=500&include=objectValue`, { headers: ssHeaders() }),
      fetch(`${SS_BASE}/sheets/${TOOLS_SHEET_ID}/attachments?pageSize=500`,         { headers: ssHeaders() })
    ]);
    if (!sheetRes.ok)      return res.status(502).json({ error: `Sheet ${sheetRes.status}` });
    if (!attachListRes.ok) return res.status(502).json({ error: `Attachments ${attachListRes.status}` });

    const [sheetData, attachListData] = await Promise.all([sheetRes.json(), attachListRes.json()]);

    const cols      = sheetData.columns || [];
    const catColId  = cols.find(c => c.title === 'Tool Category')?.id;
    const toolColId = cols.find(c => c.title === 'Tool')?.id;

    // Build rowId → { rowId, category, tool, hasImage }
    const rowMap = {};
    for (const row of (sheetData.rows || [])) {
      const cell     = id => (row.cells || []).find(c => c.columnId == id);
      const coverCell = (row.cells || []).find(c => String(c.columnId) === COVER_COLUMN_ID);
      const hasImage = !!(coverCell?.image?.id || coverCell?.image?.imageId);
      rowMap[row.id] = {
        rowId:    String(row.id),
        category: cell(catColId)?.displayValue || cell(catColId)?.value || '',
        tool:     cell(toolColId)?.displayValue || cell(toolColId)?.value || '',
        hasImage
      };
    }

    const rowAttachments = (attachListData.data || []).filter(a => a.parentType === 'ROW');
    const attachedRowIds = new Set(rowAttachments.map(a => String(a.parentId)));

    // Fetch fresh download URLs for each file attachment
    const toolsWithFiles = (await Promise.all(
      rowAttachments.map(async a => {
        try {
          const r = await fetch(`${SS_BASE}/sheets/${TOOLS_SHEET_ID}/attachments/${a.id}`, { headers: ssHeaders() });
          if (!r.ok) return null;
          const detail = await r.json();
          const row = rowMap[a.parentId] || {};
          return {
            id:       String(a.id),
            rowId:    String(a.parentId),
            category: row.category || '',
            tool:     row.tool     || '',
            hasImage: row.hasImage || false,
            fileName: a.name       || '',
            mimeType: a.mimeType   || '',
            sizeKb:   Math.round(a.sizeInKb || 0),
            url:      detail.url   || null
          };
        } catch { return null; }
      })
    )).filter(Boolean);

    // Rows with no file attachment (Digital, Operations Research, Statistical)
    const toolsNoFiles = Object.values(rowMap)
      .filter(row => row.tool && row.category && !attachedRowIds.has(row.rowId))
      .map(row => ({
        id:       `row-${row.rowId}`,
        rowId:    row.rowId,
        category: row.category,
        tool:     row.tool,
        hasImage: row.hasImage,
        fileName: '',
        mimeType: '',
        sizeKb:   0,
        url:      null
      }));

    res.json({ fetchedAt: new Date().toISOString(), tools: [...toolsWithFiles, ...toolsNoFiles] });
  } catch (err) {
    console.error('Tools error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tool-download?id=<attachmentId>
app.get('/api/tool-download', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });
  if (!process.env.SMARTSHEET_TOKEN) return res.status(500).json({ error: 'Token not configured' });
  try {
    const r = await fetch(`${SS_BASE}/sheets/${TOOLS_SHEET_ID}/attachments/${id}`, { headers: ssHeaders() });
    if (!r.ok) return res.status(502).json({ error: `Smartsheet ${r.status}` });
    const data = await r.json();
    res.json({ url: data.url || null, name: data.name || '' });
  } catch (err) {
    console.error('tool-download error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Service Request HUB ───────────────────────────────────────────────────────
// Sheet: "Ticket" (Sheet ID 1447137828097924)
// Columns: Department | Service Request | Link
// Returns live form-link directory grouped by department.
const TICKET_SHEET = '1447137828097924';

app.get('/api/service-requests', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) {
    return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured.' });
  }
  try {
    const r = await fetch(
      `${SS_BASE}/sheets/${TICKET_SHEET}?pageSize=500`,
      { headers: ssHeaders() }
    );
    if (!r.ok) return res.status(502).json({ error: `Smartsheet ${r.status}` });
    const data = await r.json();

    const cols = data.columns || [];
    const colId = name => cols.find(c => c.title === name)?.id;

    const deptId    = colId('Department');
    const titleId   = colId('Service Request');
    const linkId    = colId('Link');

    const requests = (data.rows || []).map(row => {
      const cell  = id => (row.cells || []).find(c => c.columnId == id);
      let   dept  = cell(deptId)?.displayValue  || '';
      const title = cell(titleId)?.displayValue || '';
      const url   = cell(linkId)?.displayValue  || cell(linkId)?.value || '';
      if (!dept || !title) return null;
      // Rename Finance-Revenue Cycle → PMOE-Finance-Revenue Cycle for display,
      // regardless of how it's stored in Smartsheet.
      const dn = dept.trim().toLowerCase();
      if (dn === 'finance-revenue cycle' || dn === 'finance - revenue cycle') {
        dept = 'PMOE-Finance-Revenue Cycle';
      }
      return { dept, title, url };
    }).filter(Boolean);

    res.json({ fetchedAt: new Date().toISOString(), requests });
  } catch (err) {
    console.error('Service requests error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Facility / Construction PM endpoint ───────────────────────────────────────
// Two sheets, near-identical schemas:
//   Active    sheet 606351922253700 ("CCH FM PM")           — has a Status column
//   Completed sheet 7478093437423492 ("FM PM Completed Projects") — no Status column
//   Cancelled sheet 7047434415853444 ("FM PM Cancelled Projects") — has a Status column
//
// Columns (by title, order-independent):
//   Project Type | Project Name | Scope Summary | Project Manager |
//   Update/Notes | Start Date | End Date | Project Location | [Status]
//
// We return the rows exactly as structured in the sheet (columns array + rows array
// of {rowId, values{}}) so the frontend can render a faithful, editable table.
// We ALSO derive Projects-page buckets from the Active sheet's Status column:
//   Status === 'On Hold'   → onhold
//   Status === 'Cancelled' → cancelled   (no such value today; wired for the future)
//   anything else          → active
// Completed rows all come from the Completed sheet.
const FACILITY_ACTIVE_SHEET    = '606351922253700';
const FACILITY_COMPLETED_SHEET = '7478093437423492';
const FACILITY_CANCELLED_SHEET = '7047434415853444';

// Sheets that the facility write endpoints are allowed to modify. Women & Children
// (1534157585862532) reuses the same editable-table engine, so it is permitted too.
const FACILITY_WRITABLE_SHEETS = new Set([
  FACILITY_ACTIVE_SHEET, FACILITY_COMPLETED_SHEET, FACILITY_CANCELLED_SHEET,
  '1534157585862532'
]);

// Column titles we surface, in display order. Status is appended only when present.
const FACILITY_BASE_COLS = [
  'Project Type', 'Project Name', 'Scope Summary', 'Trend Towards Achieving Scope',
  'Project Manager', 'Update/Notes', 'Start Date', 'End Date', 'Project Location'
];

function parseFacilitySheet(sheetData) {
  const cols = sheetData.columns || [];
  // Map title → column id, preserving only the columns we care about (+ Status if present)
  const wanted = [...FACILITY_BASE_COLS];
  if (cols.some(c => c.title === 'Status')) wanted.push('Status');

  const colIdByTitle = {};
  wanted.forEach(t => {
    const col = cols.find(c => c.title === t);
    if (col) colIdByTitle[t] = col.id;
  });
  // Only keep titles that actually exist on this sheet
  const columns = wanted.filter(t => colIdByTitle[t] != null);

  const rows = (sheetData.rows || []).map(row => {
    const values = {};
    let hasAny = false;
    columns.forEach(title => {
      const cell = (row.cells || []).find(c => c.columnId == colIdByTitle[title]);
      const v = cell?.displayValue ?? cell?.value ?? '';
      const s = (v === null || v === undefined) ? '' : String(v);
      values[title] = s;
      if (s.trim()) hasAny = true;
    });
    return { rowId: String(row.id), values, hasAny };
  }).filter(r => r.hasAny); // drop the empty placeholder rows in the Completed sheet

  return { columns, rows };
}

// ── Facility write-back: column map + value coercion ──────────────────────────
// To write cells we need each column's id AND type (Status/Location/Type are
// PICKLIST, Project Manager is CONTACT, Start/End are DATE). We cache the column
// metadata per sheet for a few minutes so edits don't re-fetch columns every time.
const _facilityColCache = {};   // sheetId → { at, cols: [{id,title,type}] }
const FACILITY_COL_TTL = 5 * 60 * 1000;

async function getFacilityColumns(sheetId) {
  const hit = _facilityColCache[sheetId];
  if (hit && (Date.now() - hit.at) < FACILITY_COL_TTL) return hit.cols;
  const r = await fetch(`${SS_BASE}/sheets/${sheetId}/columns?level=2&include=objectValue`, { headers: ssHeaders() });
  if (!r.ok) throw new Error(`columns fetch ${r.status}`);
  const data = await r.json();
  const cols = (data.data || data.columns || []).map(c => ({ id: c.id, title: c.title, type: c.type }));
  _facilityColCache[sheetId] = { at: Date.now(), cols };
  return cols;
}

// Build a Smartsheet cell object for a title/value pair, honoring column type.
// Uses strict:false so lenient values (e.g. "TBD" in a DATE cell, or a Status
// not in the picklist) are coerced/stored rather than 400-ing the whole write.
function buildFacilityCell(col, rawVal) {
  const v = (rawVal == null) ? '' : String(rawVal).trim();
  const cell = { columnId: col.id, strict: false };
  if (v === '') { cell.value = ''; return cell; }        // clear the cell

  if (col.type === 'CONTACT_LIST' || col.type === 'CONTACT' || col.type === 'MULTI_CONTACT_LIST') {
    // Names may not resolve to a user; send as value and let Smartsheet keep the
    // text. If it looks like an email, also hint objectValue for a clean contact.
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
      cell.objectValue = { objectType: 'CONTACT', email: v };
      cell.value = v;
    } else {
      cell.value = v;
    }
    return cell;
  }
  if (col.type === 'DATE' || col.type === 'ABSTRACT_DATETIME' || col.type === 'DATETIME') {
    // Accept ISO date; anything non-date (e.g. "TBD") goes in with strict:false.
    cell.value = v;
    return cell;
  }
  // TEXT_NUMBER, PICKLIST, MULTI_PICKLIST, etc.
  cell.value = v;
  return cell;
}

function facilitySheetFor(which) {
  if (which === 'completed') return FACILITY_COMPLETED_SHEET;
  if (which === 'cancelled') return FACILITY_CANCELLED_SHEET;
  return FACILITY_ACTIVE_SHEET;
}

// POST /api/facility/update  { sheetSection?, sheetId?, rowId, values:{title:val,...} }
// Updates one existing row's cells. Returns the refreshed {rowId, values}.
app.post('/api/facility/update', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured.' });
  try {
    const { rowId, values } = req.body || {};
    const sheetId = req.body.sheetId || facilitySheetFor(req.body.sheetSection);
    if (!rowId || !values || typeof values !== 'object') {
      return res.status(400).json({ error: 'rowId and values{} are required.' });
    }
    if (!FACILITY_WRITABLE_SHEETS.has(String(sheetId))) {
      return res.status(403).json({ error: 'sheetId not permitted.' });
    }
    const cols = await getFacilityColumns(sheetId);
    const colByTitle = {};
    cols.forEach(c => { colByTitle[c.title] = c; });

    const cells = [];
    for (const [title, val] of Object.entries(values)) {
      const col = colByTitle[title];
      if (!col) continue;                       // ignore unknown columns
      if (title === 'Primary') continue;        // never touch the primary/system col here
      cells.push(buildFacilityCell(col, val));
    }
    if (!cells.length) return res.status(400).json({ error: 'No writable columns matched.' });

    const body = [{ id: Number(rowId), cells }];
    const r = await fetch(`${SS_BASE}/sheets/${sheetId}/rows`, {
      method: 'PUT', headers: ssHeaders(), body: JSON.stringify(body)
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({ error: `Smartsheet update failed (${r.status})`, detail: out?.message || out });
    }
    res.json({ ok: true, rowId: String(rowId), result: out?.result || out, savedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Facility update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/facility/add  { sheetSection?, sheetId?, values:{title:val,...} }
// Inserts a new row at the bottom. Returns the new real rowId + stored values.
app.post('/api/facility/add', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured.' });
  try {
    const values = req.body?.values || {};
    const sheetId = req.body.sheetId || facilitySheetFor(req.body.sheetSection);
    if (!FACILITY_WRITABLE_SHEETS.has(String(sheetId))) {
      return res.status(403).json({ error: 'sheetId not permitted.' });
    }
    const cols = await getFacilityColumns(sheetId);
    const colByTitle = {};
    cols.forEach(c => { colByTitle[c.title] = c; });

    const cells = [];
    for (const [title, val] of Object.entries(values)) {
      const col = colByTitle[title];
      if (!col || title === 'Primary') continue;
      const v = (val == null) ? '' : String(val).trim();
      if (v === '') continue;                   // don't send empty cells on insert
      cells.push(buildFacilityCell(col, val));
    }
    // A Smartsheet row must have at least one cell; if the PM added a truly blank
    // row and immediately saved, seed the primary/Project Name so the row persists.
    if (!cells.length) {
      const nameCol = colByTitle['Project Name'] || colByTitle['Primary'] || cols[0];
      if (nameCol) cells.push({ columnId: nameCol.id, value: '(new project)', strict: false });
    }

    const body = { toBottom: true, cells };
    const r = await fetch(`${SS_BASE}/sheets/${sheetId}/rows`, {
      method: 'POST', headers: ssHeaders(), body: JSON.stringify(body)
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({ error: `Smartsheet add failed (${r.status})`, detail: out?.message || out });
    }
    const newRow = out?.result || {};
    res.json({ ok: true, rowId: String(newRow.id || ''), result: newRow, savedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Facility add error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/facility/delete  { sheetSection?, sheetId?, rowId }
app.post('/api/facility/delete', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured.' });
  try {
    const { rowId } = req.body || {};
    const sheetId = req.body.sheetId || facilitySheetFor(req.body.sheetSection);
    if (!rowId) return res.status(400).json({ error: 'rowId required.' });
    if (!FACILITY_WRITABLE_SHEETS.has(String(sheetId))) {
      return res.status(403).json({ error: 'sheetId not permitted.' });
    }
    const r = await fetch(`${SS_BASE}/sheets/${sheetId}/rows?ids=${encodeURIComponent(rowId)}`, {
      method: 'DELETE', headers: ssHeaders()
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: `Smartsheet delete failed (${r.status})`, detail: out?.message || out });
    res.json({ ok: true, rowId: String(rowId), savedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Facility delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PMOE Load - Update (Project Updates table on the Overview page) ────────────
// GET /api/pmoe-load — returns the rows of sheet 2870073055203204 as
// { columns:[...], rows:[{values:{col:val}}] } for a faithful table render.
const PMOE_LOAD_SHEET = '2870073055203204';
app.get('/api/pmoe-load', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) {
    return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured.' });
  }
  try {
    const r = await fetch(`${SS_BASE}/sheets/${PMOE_LOAD_SHEET}?pageSize=500`, { headers: ssHeaders() });
    if (r.status === 401) return res.status(401).json({ error: 'Smartsheet token invalid.' });
    if (!r.ok) return res.status(502).json({ error: `Smartsheet error: ${r.status}` });
    const data = await r.json();

    const cols = (data.columns || []).map(c => ({ id: c.id, title: c.title }));
    const columns = cols.map(c => c.title);
    const rows = (data.rows || []).map(row => {
      const values = {};
      let hasAny = false;
      cols.forEach(c => {
        const cell = (row.cells || []).find(x => x.columnId == c.id);
        let v = cell?.displayValue ?? cell?.value ?? '';
        v = (v === null || v === undefined) ? '' : String(v);
        // Multi-contact "Name <email>" → just the name(s) for display
        if (/@/.test(v) && /</.test(v)) {
          v = v.split(',').map(part => part.replace(/<[^>]*>/g, '').trim()).filter(Boolean).join(', ');
        }
        values[c.title] = v;
        if (v.trim()) hasAny = true;
      });
      return { rowId: String(row.id), values, hasAny };
    }).filter(r => r.hasAny);

    res.json({ fetchedAt: new Date().toISOString(), sheetId: PMOE_LOAD_SHEET, columns, rows });
  } catch (err) {
    console.error('PMOE Load error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/facility', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) {
    return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured.' });
  }
  try {
    const [activeRes, completedRes, cancelledRes] = await Promise.all([
      fetch(`${SS_BASE}/sheets/${FACILITY_ACTIVE_SHEET}?pageSize=500`,    { headers: ssHeaders() }),
      fetch(`${SS_BASE}/sheets/${FACILITY_COMPLETED_SHEET}?pageSize=500`, { headers: ssHeaders() }),
      fetch(`${SS_BASE}/sheets/${FACILITY_CANCELLED_SHEET}?pageSize=500`, { headers: ssHeaders() })
    ]);

    if (activeRes.status === 401 || completedRes.status === 401 || cancelledRes.status === 401) {
      return res.status(401).json({ error: 'Smartsheet token invalid. Update SMARTSHEET_TOKEN in Render.' });
    }
    if (!activeRes.ok)    return res.status(502).json({ error: `Smartsheet error (active): ${activeRes.status}` });
    if (!completedRes.ok) return res.status(502).json({ error: `Smartsheet error (completed): ${completedRes.status}` });
    // Cancelled sheet is non-fatal: if it fails, continue with an empty set.
    let cancelledData = { columns: [], rows: [] };
    if (cancelledRes.ok) cancelledData = await cancelledRes.json();
    else console.warn('Facility cancelled sheet fetch failed:', cancelledRes.status);

    const [activeData, completedData] = await Promise.all([activeRes.json(), completedRes.json()]);

    const active         = parseFacilitySheet(activeData);
    const completed      = parseFacilitySheet(completedData);
    const cancelledSheet = parseFacilitySheet(cancelledData);

    // Bucket active-sheet rows by Status for the Projects page
    const statusOf = r => (r.values['Status'] || '').toLowerCase().trim();
    const onhold    = active.rows.filter(r => statusOf(r) === 'on hold');
    // Cancelled = the dedicated Cancelled sheet PLUS any active-sheet rows flagged cancelled.
    const cancelledFromActive = active.rows.filter(r => statusOf(r) === 'cancelled' || statusOf(r) === 'canceled');
    const cancelled = [...cancelledSheet.rows, ...cancelledFromActive];
    const activeOnly = active.rows.filter(r => {
      const s = statusOf(r);
      return s !== 'on hold' && s !== 'cancelled' && s !== 'canceled';
    });

    res.json({
      fetchedAt: new Date().toISOString(),
      active:    { columns: active.columns,    rows: active.rows,    sheetId: FACILITY_ACTIVE_SHEET },
      completed: { columns: completed.columns, rows: completed.rows, sheetId: FACILITY_COMPLETED_SHEET },
      cancelled: { columns: cancelledSheet.columns, rows: cancelledSheet.rows, sheetId: FACILITY_CANCELLED_SHEET },
      buckets:   { active: activeOnly, onhold, cancelled, completed: completed.rows },
      meta: {
        activeRows:    active.rows.length,
        completedRows: completed.rows.length,
        onHoldRows:    onhold.length,
        cancelledRows: cancelled.length
      }
    });
  } catch (err) {
    console.error('Facility endpoint error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SL: Women & Children ──────────────────────────────────────────────────────
// Read-only live view of the "Women & Children" sheet, mirroring the Facility PM
// setup. Sheet columns: Project Type, Project Name, Scope Summary, Project Manager,
// Trend Towards Achieving Scope, Update/Notes, Status. (No dates/location here.)
const WC_SHEET = '1534157585862532';
const WC_BASE_COLS = [
  'Project Type', 'Project Name', 'Scope Summary', 'Trend Towards Achieving Scope',
  'Project Manager', 'Update/Notes'
];

// Parse a sheet against an arbitrary wanted-column list (+ Status if present).
function parseSheetCols(sheetData, baseCols) {
  const cols = sheetData.columns || [];
  const wanted = [...baseCols];
  if (cols.some(c => c.title === 'Status')) wanted.push('Status');
  const colIdByTitle = {};
  wanted.forEach(t => { const col = cols.find(c => c.title === t); if (col) colIdByTitle[t] = col.id; });
  const columns = wanted.filter(t => colIdByTitle[t] != null);
  const rows = (sheetData.rows || []).map(row => {
    const values = {}; let hasAny = false;
    columns.forEach(title => {
      const cell = (row.cells || []).find(c => c.columnId == colIdByTitle[title]);
      const v = cell?.displayValue ?? cell?.value ?? '';
      const s = (v === null || v === undefined) ? '' : String(v);
      values[title] = s;
      if (s.trim()) hasAny = true;
    });
    return { rowId: String(row.id), values, hasAny };
  }).filter(r => r.hasAny);
  return { columns, rows };
}

app.get('/api/women-children', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) {
    return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured.' });
  }
  try {
    const r = await fetch(`${SS_BASE}/sheets/${WC_SHEET}?pageSize=500`, { headers: ssHeaders() });
    if (r.status === 401) return res.status(401).json({ error: 'Smartsheet token invalid. Update SMARTSHEET_TOKEN in Render.' });
    if (!r.ok) return res.status(502).json({ error: `Smartsheet error (women-children): ${r.status}` });
    const data = await r.json();
    const active = parseSheetCols(data, WC_BASE_COLS);
    const statusOf = row => (row.values['Status'] || '').toLowerCase().trim();
    res.json({
      fetchedAt: new Date().toISOString(),
      active: { columns: active.columns, rows: active.rows, sheetId: WC_SHEET },
      meta: {
        activeRows:    active.rows.length,
        onHoldRows:    active.rows.filter(r => statusOf(r) === 'on hold').length,
        completedRows: active.rows.filter(r => statusOf(r) === 'completed').length,
        inProgressRows:active.rows.filter(r => statusOf(r) === 'in progress').length
      }
    });
  } catch (err) {
    console.error('Women & Children endpoint error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Legal & Risk Management worklist ──────────────────────────────────────────
// Live-reads the Legal team's "Current Worklist" source sheet (the same sheet
// backing the Legal app's report 3595186276880260 "Active Assignments - Legal").
// We read the SOURCE SHEET (not the report) because the report omits the
// Risk Flag column, which the Legal Portfolio Overview needs for its
// "Assignments Needing Attention" metric. Read-only mirror — no write-back.
const LEGAL_SHEET = process.env.LEGAL_SHEET || '4690720530059140';
const LEGAL_COLS = [
  'Request ID#', 'Priority', 'Category', 'Title', 'Contract Number',
  'Vendor', 'User Department or Representative', 'Status', 'Risk Flag',
  'Notes', 'Next Steps', 'Start Date', 'End Date'
];

app.get('/api/legal', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) {
    return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured.' });
  }
  try {
    const r = await fetch(`${SS_BASE}/sheets/${LEGAL_SHEET}?pageSize=500`, { headers: ssHeaders() });
    if (r.status === 401) return res.status(401).json({ error: 'Smartsheet token invalid. Update SMARTSHEET_TOKEN in Render.' });
    if (!r.ok) return res.status(502).json({ error: `Smartsheet error (legal): ${r.status}` });
    const data = await r.json();

    // Build column map from the sheet, preserving LEGAL_COLS order.
    const cols = data.columns || [];
    const colIdByTitle = {};
    LEGAL_COLS.forEach(t => { const c = cols.find(x => x.title === t); if (c) colIdByTitle[t] = c.id; });
    const columns = LEGAL_COLS.filter(t => colIdByTitle[t] != null);

    const rows = (data.rows || []).map(row => {
      const values = {};
      columns.forEach(title => {
        const cell = (row.cells || []).find(c => c.columnId == colIdByTitle[title]);
        const v = cell?.displayValue ?? cell?.value ?? '';
        values[title] = (v === null || v === undefined) ? '' : String(v);
      });
      // Skip completely empty rows (no Request ID# and no Title).
      if (!values['Request ID#'] && !values['Title']) return null;
      return { rowId: String(row.id), values };
    }).filter(Boolean);

    const statusOf = r2 => (r2.values['Status']    || '').toLowerCase().trim();
    const riskOf   = r2 => (r2.values['Risk Flag'] || '').toLowerCase().trim();
    const isAttention = r2 => riskOf(r2) === 'at risk' || riskOf(r2) === 'off track';

    // Category distribution (mirrors the Legal Worklist "All Categories" grouping).
    const catCounts = {};
    rows.forEach(r2 => {
      const c = (r2.values['Category'] || '').trim() || 'Uncategorized';
      catCounts[c] = (catCounts[c] || 0) + 1;
    });

    res.json({
      fetchedAt: new Date().toISOString(),
      active: { columns, rows, sheetId: LEGAL_SHEET },
      meta: {
        totalRows:       rows.length,
        activeRows:      rows.filter(r2 => statusOf(r2) === 'in progress').length,
        completedRows:   rows.filter(r2 => statusOf(r2) === 'completed').length,
        notStartedRows:  rows.filter(r2 => statusOf(r2) === 'not started').length,
        onHoldRows:      rows.filter(r2 => statusOf(r2) === 'hold' || statusOf(r2) === 'on hold').length,
        attentionRows:   rows.filter(isAttention).length,
        categories:      catCounts
      }
    });
  } catch (err) {
    console.error('Legal endpoint error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Generic sheet reader helpers (ARPA Sustainability / BH Grants) ────────────
// Tolerant of numeric strings like "2026.0" / "-839921.0"; skips blank rows.
function cellNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? null : n;
}
async function readSheetByTitle(sheetId) {
  const r = await fetch(`${SS_BASE}/sheets/${sheetId}?pageSize=500`, { headers: ssHeaders() });
  if (!r.ok) { const e = new Error(`Smartsheet ${r.status}`); e.status = r.status; throw e; }
  const data = await r.json();
  const cols = data.columns || [];
  const rows = (data.rows || []).map(row => {
    const o = {};
    cols.forEach(c => {
      const cell = (row.cells || []).find(x => x.columnId == c.id);
      const v = cell ? (cell.value !== undefined && cell.value !== null ? cell.value : cell.displayValue) : null;
      o[c.title] = (v === undefined) ? null : v;
    });
    return o;
  });
  return { name: data.name, permalink: data.permalink, modifiedAt: data.modifiedAt, columns: cols.map(c => c.title), rows };
}
const colKey = (row, ...wants) => {
  const keys = Object.keys(row);
  for (const w of wants) {
    const k = keys.find(x => x.toLowerCase().replace(/\s+/g, ' ').includes(w.toLowerCase()));
    if (k) return k;
  }
  return null;
};

// ── ARPA Program Sustainability (sheet 5023621736255364) ──────────────────────
const ARPA_SHEET = process.env.ARPA_SHEET || '5023621736255364';
app.get('/api/arpa-sustainability', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured.' });
  try {
    const sh = await readSheetByTitle(ARPA_SHEET);
    const rows = sh.rows.map(r0 => {
      const g = (...w) => { const k = colKey(r0, ...w); return k ? r0[k] : null; };
      const program = g('program');
      if (program == null || String(program).trim() === '') return null;
      const fy = cellNum(g('fiscal year'));
      return {
        program: String(program).trim(),
        fiscalYear: fy != null ? Math.round(fy) : null,
        projectedCpt: g('projected billable cpt') ,
        actualCpt: g('actual billed cpt'),
        projectedUos: cellNum(g('projected billed unit')),
        actualUos: cellNum(g('actual billed unit')),
        projectedNet: cellNum(g('projected net')),
        actualNet: cellNum(g('actual net')),
        notes: g('notes')
      };
    }).filter(Boolean);
    const sum = k => rows.reduce((a, r0) => a + (r0[k] || 0), 0);
    const totals = {
      programs: rows.length,
      projectedUos: sum('projectedUos'), actualUos: sum('actualUos'),
      projectedNet: sum('projectedNet'), actualNet: sum('actualNet')
    };
    totals.netVariance = totals.actualNet - totals.projectedNet;
    totals.uosVariance = totals.actualUos - totals.projectedUos;
    res.json({ fetchedAt: new Date().toISOString(), sheetId: ARPA_SHEET, name: sh.name, permalink: sh.permalink, modifiedAt: sh.modifiedAt, rows, totals });
  } catch (err) {
    console.error('ARPA endpoint error:', err.message);
    res.status(err.status === 401 ? 401 : 500).json({ error: err.message });
  }
});

// ── Behavioral Health Grants (sheet 7277869144428420) ─────────────────────────
const BHGRANTS_SHEET = process.env.BHGRANTS_SHEET || '7277869144428420';
app.get('/api/bh-grants', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured.' });
  try {
    const sh = await readSheetByTitle(BHGRANTS_SHEET);
    const rows = sh.rows.map(r0 => {
      const g = (...w) => { const k = colKey(r0, ...w); return k ? r0[k] : null; };
      const grant = g('bh grant', 'grant');
      if (grant == null || String(grant).trim() === '') return null;
      return {
        grant: String(grant).trim(),
        amount: cellNum(g('grant amount', 'amount')),
        fundingType: g('funding type') ? String(g('funding type')).trim() : '',
        site: g('site deployment', 'site') ? String(g('site deployment', 'site')).trim() : ''
      };
    }).filter(Boolean);
    const byType = {};
    rows.forEach(r0 => { const t = r0.fundingType || 'Unspecified'; byType[t] = (byType[t] || 0) + (r0.amount || 0); });
    const totals = { grants: rows.length, totalAmount: rows.reduce((a, r0) => a + (r0.amount || 0), 0), byType };
    res.json({ fetchedAt: new Date().toISOString(), sheetId: BHGRANTS_SHEET, name: sh.name, permalink: sh.permalink, modifiedAt: sh.modifiedAt, rows, totals });
  } catch (err) {
    console.error('BH Grants endpoint error:', err.message);
    res.status(err.status === 401 ? 401 : 500).json({ error: err.message });
  }
});

// ── TPRA (Third Party Risk Assessment) — read-only mirror of a report ─────────
// Reads report 3947407636123524 and returns its columns/rows generically so the
// Portfolio Overview can display them the same way as Legal & Risk Mx.
const TPRA_REPORT = process.env.TPRA_REPORT || '3947407636123524';

app.get('/api/tpra', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) {
    return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured.' });
  }
  try {
    const r = await fetch(`${SS_BASE}/reports/${TPRA_REPORT}?pageSize=1000`, { headers: ssHeaders() });
    if (r.status === 401) return res.status(401).json({ error: 'Smartsheet token invalid. Update SMARTSHEET_TOKEN in Render.' });
    if (!r.ok) return res.status(502).json({ error: `Smartsheet error (tpra): ${r.status}` });
    const data = await r.json();

    // Report column metadata: each column has an id and a virtualColumnId.
    // Cells reference columns by virtualColumnId (report) and/or columnId.
    // The REST API returns camelCase; be defensive and accept snake_case too.
    const rawCols = data.columns || [];
    const cols = rawCols.map(c => ({
      vid:   c.virtualColumnId ?? c.virtual_column_id ?? c.virtualId ?? c.virtual_id,
      cid:   c.id,
      title: c.title
    }));
    const columns = cols.map(c => c.title);

    // Build lookup: for each cell we try virtual id first, then column id.
    const rows = (data.rows || []).map(row => {
      const cells = row.cells || [];
      const values = {};
      cols.forEach((c, i) => {
        // Match by virtual column id, then column id, then positional index fallback.
        let cell = cells.find(x => {
          const xv = x.virtualColumnId ?? x.virtual_column_id;
          const xc = x.columnId ?? x.column_id;
          return (c.vid != null && xv == c.vid) || (c.cid != null && xc == c.cid);
        });
        if (!cell && cells.length === cols.length) cell = cells[i]; // positional fallback
        const v = cell ? (cell.displayValue ?? cell.display_value ?? cell.value ?? '') : '';
        values[c.title] = (v === null || v === undefined) ? '' : String(v);
      });
      // A real TPRA assessment must have a Vendor Name. Rows without one are
      // spacer/placeholder rows in the source sheet and are excluded from the
      // worklist and all metrics (this matches the authoritative sheet count).
      return { rowId: String(row.id), values };
    }).filter(Boolean);

    const vendorCol = columns.find(t => /vendor\s*name/i.test(t)) || columns.find(t => /vendor/i.test(t));
    const withVendor = vendorCol
      ? rows.filter(r => (r.values[vendorCol] || '').trim() !== '')
      : rows;

    // Metrics tuned to the real TPRA Status values. Status is a picklist with
    // many values (Complete, In Progress, Pending, Vendor Declined, blank, #NO MATCH…),
    // so In Progress must be an EXACT match — not "everything that isn't Complete".
    const statusCol = columns.find(t => /^status$/i.test(t)) || columns.find(t => /status/i.test(t)) || null;
    const recCol    = columns.find(t => /recommendation/i.test(t) && !/notes/i.test(t)) || null;
    const val = (r2, col) => col ? (r2.values[col] || '').toLowerCase().trim() : '';
    const meta = {
      totalRows:      withVendor.length,
      statusColumn:   statusCol,
      recColumn:      recCol,
      completedRows:  withVendor.filter(r2 => val(r2, statusCol) === 'complete').length,
      inProgressRows: withVendor.filter(r2 => val(r2, statusCol) === 'in progress').length
    };

    res.json({
      fetchedAt: new Date().toISOString(),
      active: { columns, rows: withVendor, reportId: TPRA_REPORT },
      meta
    });
  } catch (err) {
    console.error('TPRA endpoint error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Work Connections — read-only mirror of a coordination sheet ───────────────
// Reads sheet 4926902442610564 and returns its columns/rows generically. This is
// the cross-group work-coordination view (avoid duplication across teams).
const WORKCONN_SHEET = process.env.WORKCONN_SHEET || '4926902442610564';

app.get('/api/work-connections', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) {
    return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured.' });
  }
  try {
    const r = await fetch(`${SS_BASE}/sheets/${WORKCONN_SHEET}?pageSize=500`, { headers: ssHeaders() });
    if (r.status === 401) return res.status(401).json({ error: 'Smartsheet token invalid. Update SMARTSHEET_TOKEN in Render.' });
    if (!r.ok) return res.status(502).json({ error: `Smartsheet error (work-connections): ${r.status}` });
    const data = await r.json();

    const cols = (data.columns || []).map(c => ({ id: c.id, title: c.title }));
    const columns = cols.map(c => c.title);

    const rows = (data.rows || []).map(row => {
      const values = {};
      cols.forEach(c => {
        const cell = (row.cells || []).find(x => x.columnId == c.id);
        const v = cell?.displayValue ?? cell?.value ?? '';
        values[c.title] = (v === null || v === undefined) ? '' : String(v);
      });
      if (columns.every(t => !values[t])) return null;
      return { rowId: String(row.id), values };
    }).filter(Boolean);

    // Roll-ups: try to surface a "group/team" distribution and a status count.
    const groupCol  = columns.find(t => /group|team|department|owner|function/i.test(t)) || null;
    const statusCol = columns.find(t => /status/i.test(t)) || null;
    const groupCounts = {};
    if (groupCol) rows.forEach(r2 => {
      const g = (r2.values[groupCol] || '').trim() || 'Unassigned';
      groupCounts[g] = (groupCounts[g] || 0) + 1;
    });
    const sOf = r2 => statusCol ? (r2.values[statusCol] || '').toLowerCase().trim() : '';

    res.json({
      fetchedAt: new Date().toISOString(),
      active: { columns, rows, sheetId: WORKCONN_SHEET },
      meta: {
        totalRows:      rows.length,
        groupColumn:    groupCol,
        statusColumn:   statusCol,
        groups:         Object.keys(groupCounts).length,
        activeRows:     rows.filter(r2 => /in progress|active|ongoing/.test(sOf(r2))).length,
        completedRows:  rows.filter(r2 => /complete|done|closed/.test(sOf(r2))).length,
        groupCounts
      }
    });
  } catch (err) {
    console.error('Work Connections endpoint error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Project Charters (auto-synced from PM Process Compliance Audit attachments) ──
// Each project row on the compliance sheet carries its charter as a row attachment.
// This block:
//   • lists every attachment on the sheet and picks, per project row, the newest
//     charter (name contains "charter"; closure reports / change requests are ignored;
//     if the row's "Project Charter - Final Version" box is ticked but nothing is
//     named "charter", the newest plain .docx/.pdf is used and flagged `inferred`),
//   • downloads + parses each picked file once (keyed by attachment id, so a newly
//     uploaded version — which gets a new id — is re-parsed automatically),
//   • re-checks the sheet every CHARTER_REFRESH_MS and on every /api/charters call, so a
//     new Active project row or a new attachment appears with no code change or deploy.
// A new project is picked up as soon as its row exists; its card then shows the file
// name immediately and the parsed Purpose/Objectives once the (few-second) parse finishes.
const { extractCharter, kindOf } = require('./charter-parser');

const CHARTER_REFRESH_MS = 10 * 60 * 1000;   // background re-check of the compliance sheet
const CHARTER_INDEX_TTL  = 60 * 1000;        // /api/charters re-lists attachments at most this often
const CHARTER_MAX_BYTES  = 20 * 1024 * 1024;
const CHARTER_RETRY_MS   = 15 * 60 * 1000;   // retry transient download failures after this

const _charterParsed = new Map();            // attachmentId → { at, result, retryAfter? }
let _charterIndex    = { at: 0, byProject: {}, missing: [], ids: new Set(), rows: 0, attachments: 0 };
let _charterIndexing = null;
let _charterJob      = null;
let _charterError    = null;

// A closure/closeout *report* or change request is not a charter. Match the phrase, not the
// bare word: "Project Charter - Provident ICU and CTSC Closure.docx" IS a charter.
const NOT_CHARTER_NAME   = /clos(?:ure|eout)[\s_.-]*report|close-?out[\s_.-]*(?:doc|summary)|change[\s_.-]*(?:request|log)/i;
const NOT_CHARTER_INFER  = /clos(?:ure|eout)|change|key points|org(anization)?[\s_-]*chart|plan|report|steering|minutes|agenda|meeting|presentation|dashboard|metrics|budget|revenue/i;

// Choose the charter attachment for one project row.
function pickCharter(atts, checked) {
  const rowAtts = atts.filter(a => a.parentType === 'ROW');
  let pool = rowAtts.filter(a => /charter/i.test(a.name || '') && !NOT_CHARTER_NAME.test(a.name || ''));
  let inferred = false;
  if (!pool.length && checked) {
    pool = rowAtts.filter(a => a.attachmentType === 'FILE' && /\.(docx|pdf)$/i.test(a.name || '') && !NOT_CHARTER_INFER.test(a.name || ''));
    inferred = pool.length > 0;
  }
  if (!pool.length) return null;
  const rank = a => (a.attachmentType === 'FILE' && kindOf(a.name, a.mimeType)) ? 0 : (a.attachmentType === 'FILE' ? 1 : 2);
  pool.sort((x, y) => rank(x) - rank(y) || String(y.createdAt || '').localeCompare(String(x.createdAt || '')));
  return { att: pool[0], versions: pool.length, inferred };
}

async function buildCharterIndex() {
  if (_charterIndexing) return _charterIndexing;
  _charterIndexing = (async () => {
    try {
      const [sheet, attRes] = await Promise.all([
        getComplianceSheet(30 * 1000),
        ssFetch(`${SS_BASE}/sheets/${COMPLIANCE_SHEET}/attachments?includeAll=true`)
      ]);
      if (!attRes.ok) throw new Error(`Compliance attachments ${attRes.status}`);
      const atts = (await attRes.json()).data || [];

      const cols = sheet.columns || [];
      const colId = t => cols.find(c => c.title === t)?.id;
      const projCol = colId('Project'), statCol = colId('Status'), charterCol = colId('Project Charter - Final Version');

      const byRow = {};
      for (const a of atts) (byRow[String(a.parentId)] = byRow[String(a.parentId)] || []).push(a);

      const byProject = {};
      const missing = [];
      let rows = 0;
      for (const row of (sheet.rows || [])) {
        const cell = id => (row.cells || []).find(c => c.columnId == id);
        const raw = (cell(projCol)?.displayValue || '').trim();
        if (!raw) continue;
        rows++;
        const project = normProjectName(raw);
        const status  = cell(statCol)?.displayValue || '';
        const checked = cell(charterCol)?.value === true;
        // "NA" in the charter column = charter not applicable (e.g. grants) → never "missing"
        const notApplicable = /^na$/i.test(String(cell(charterCol)?.displayValue ?? cell(charterCol)?.value ?? '').trim());
        const pick = pickCharter(byRow[String(row.id)] || [], checked);
        if (!pick) {
          if (/^(active|on hold)$/i.test(status) && !notApplicable) missing.push({ project, status, charterChecked: checked });
          continue;
        }
        const a = pick.att;
        const isFile = a.attachmentType === 'FILE';
        byProject[project] = {
          project, status, rowId: String(row.id),
          attachmentId: String(a.id), fileName: a.name || '', kind: isFile ? 'file' : 'link',
          mimeType: a.mimeType || '', sizeKb: a.sizeInKb || 0,
          attachedAt: a.createdAt || '', attachedBy: a.createdBy?.name || a.createdBy?.email || '',
          versions: pick.versions, inferred: pick.inferred, charterChecked: checked,
          url: isFile ? `/api/charter-file/${a.id}` : (a.url || ''),
          supported: isFile && !!kindOf(a.name, a.mimeType)
        };
      }
      _charterIndex = {
        at: Date.now(), byProject, missing, rows, attachments: atts.length,
        ids: new Set(Object.values(byProject).filter(e => e.kind === 'file').map(e => e.attachmentId))
      };
      _charterError = null;
      return _charterIndex;
    } catch (e) {
      _charterError = e.message;
      throw e;
    } finally {
      _charterIndexing = null;
    }
  })();
  return _charterIndexing;
}

const STATUS_ORDER = { active: 0, 'on hold': 1 };
function charterTodo() {
  const now = Date.now();
  return Object.values(_charterIndex.byProject)
    .filter(e => e.supported)
    .filter(e => {
      const p = _charterParsed.get(e.attachmentId);
      return !p || (p.retryAfter && now >= p.retryAfter);
    })
    .sort((a, b) =>
      (STATUS_ORDER[(a.status || '').toLowerCase()] ?? 2) - (STATUS_ORDER[(b.status || '').toLowerCase()] ?? 2)
      || String(b.attachedAt).localeCompare(String(a.attachedAt)));
}

async function parseOneCharter(e) {
  try {
    const dr = await ssFetch(`${SS_BASE}/sheets/${COMPLIANCE_SHEET}/attachments/${e.attachmentId}`);
    if (!dr.ok) throw new Error(`attachment lookup ${dr.status}`);
    const d = await dr.json();
    if (!d.url) throw new Error('no download url');
    // Pre-signed S3 URL — must NOT carry the Smartsheet Authorization header.
    const fr = await fetch(d.url);
    if (!fr.ok) throw new Error(`download ${fr.status}`);
    const len = Number(fr.headers.get('content-length') || 0);
    if (len > CHARTER_MAX_BYTES) { _charterParsed.set(e.attachmentId, { at: Date.now(), result: { parsed: false, reason: 'file too large' } }); return; }
    const buf = Buffer.from(await fr.arrayBuffer());
    const result = await extractCharter(buf, e.fileName, e.mimeType);
    _charterParsed.set(e.attachmentId, { at: Date.now(), result });
    console.log(`[Charters] ${e.project}: "${e.fileName}" → ${result.parsed ? (result.approximate ? 'parsed (approximate)' : 'parsed') : 'not parsed: ' + result.reason}`);
  } catch (err) {
    console.warn(`[Charters] ${e.project}: "${e.fileName}" failed: ${err.message}`);
    _charterParsed.set(e.attachmentId, { at: Date.now(), result: { parsed: false, reason: err.message }, retryAfter: Date.now() + CHARTER_RETRY_MS });
  }
}

// Refresh the index (unless fresh) and kick off parsing of anything new. waitMs lets a
// request wait briefly for the parse job so the first load usually returns full content.
async function ensureCharters({ waitMs = 0, force = false } = {}) {
  if (force || Date.now() - _charterIndex.at > CHARTER_INDEX_TTL) {
    try { await buildCharterIndex(); }
    catch (e) { if (!_charterIndex.at) throw e; console.warn('[Charters] index refresh failed, serving last good index:', e.message); }
  }
  const todo = charterTodo();
  if (todo.length && !_charterJob) {
    _charterJob = pooled(todo, 3, parseOneCharter).finally(() => { _charterJob = null; });
  }
  if (_charterJob && waitMs > 0) await Promise.race([_charterJob, sleep(waitMs)]);
}

function charterSnapshot(debug) {
  const charters = {};
  let pending = 0;
  for (const [project, e] of Object.entries(_charterIndex.byProject)) {
    const p = _charterParsed.get(e.attachmentId);
    const r = p ? p.result : null;
    if (e.supported && !p) pending++;
    const f = (r && r.fields) || {};
    charters[project] = {
      project, status: e.status, fileName: e.fileName, kind: e.kind, url: e.url,
      attachmentId: e.attachmentId, sizeKb: e.sizeKb, attachedAt: e.attachedAt, attachedBy: e.attachedBy,
      versions: e.versions, inferred: e.inferred, charterChecked: e.charterChecked,
      parsed: !!(r && r.parsed), approximate: !!(r && r.approximate),
      parseNote: r && !r.parsed ? r.reason : (!e.supported ? (e.kind === 'link' ? 'linked charter (open in Smartsheet)' : 'unsupported file type') : ''),
      purpose: f.purpose || '', objectives: f.objectives || '', scope: f.scope || '',
      deliverables: f.deliverables || '', timeline: f.timeline || ''
    };
    if (debug && r) { charters[project].outline = r.outline || []; charters[project].labels = r.labels || []; }
  }
  return {
    fetchedAt: new Date().toISOString(),
    indexedAt: _charterIndex.at ? new Date(_charterIndex.at).toISOString() : null,
    complianceRows: _charterIndex.rows, attachmentsScanned: _charterIndex.attachments,
    count: Object.keys(charters).length,
    parsedCount: Object.values(charters).filter(c => c.parsed).length,
    pending, error: _charterError,
    missing: _charterIndex.missing,       // Active / On Hold projects with no charter file attached
    charters
  };
}

app.get('/api/charters', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured.' });
  try {
    const wait = Math.min(Math.max(Number(req.query.wait) || 20, 0), 50) * 1000;
    await ensureCharters({ waitMs: wait, force: req.query.refresh === '1' });
    res.json(charterSnapshot(req.query.debug === '1'));
  } catch (err) {
    console.error('Charters error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// Force an immediate re-scan (e.g. right after uploading a charter) — same as ?refresh=1.
app.post('/api/charters/refresh', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured.' });
  try {
    await ensureCharters({ waitMs: 25000, force: true });
    const s = charterSnapshot(false);
    res.json({ refreshed: true, count: s.count, parsedCount: s.parsedCount, pending: s.pending, missing: s.missing });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// Opens the actual charter file: looks up a fresh pre-signed URL (they expire in ~60 s)
// and redirects to it. Only attachment ids currently chosen as a project's charter are
// served — this is not a general attachment proxy.
app.get('/api/charter-file/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^\d+$/.test(id)) return res.status(400).send('bad id');
  try {
    if (!_charterIndex.at) await ensureCharters({});
    if (!_charterIndex.ids.has(id)) return res.status(404).send('Not a known charter attachment');
    const r = await ssFetch(`${SS_BASE}/sheets/${COMPLIANCE_SHEET}/attachments/${id}`);
    if (!r.ok) return res.status(502).send(`Smartsheet ${r.status}`);
    const d = await r.json();
    if (!d.url) return res.status(404).send('No download URL');
    res.redirect(302, d.url);
  } catch (err) { res.status(502).send(err.message); }
});

app.listen(PORT, () => {
  console.log(`PMOE API listening on port ${PORT}`);
  console.log(`Smartsheet token:  ${process.env.SMARTSHEET_TOKEN  ? 'SET ✓' : 'NOT SET ✗'}`);
  console.log(`Anthropic API key: ${process.env.ANTHROPIC_API_KEY ? 'SET ✓' : 'NOT SET ✗'}`);
  console.log(`Cody API key:      ${process.env.CODY_API_KEY      ? 'SET ✓' : 'NOT SET ✗'}`);
  console.log(`Cody Bot ID:       ${process.env.CODY_BOT_ID       ? 'SET ✓' : 'NOT SET ✗'}`);

  // Pre-warm the risk/issue sheet discovery cache so the first /api/data
  // request doesn't have to wait for the search to complete.
  if (process.env.SMARTSHEET_TOKEN) {
    discoverRiskSheets()
      .then(s => console.log(`[Startup] Risk/issue sheet cache warmed: ${s.length} sheets`))
      .catch(e => console.warn('[Startup] Risk cache warm failed:', e.message));

    // Charters: index + parse at startup, then re-check the compliance sheet on a timer so
    // a new project row or newly attached charter is picked up even with nobody on the app.
    ensureCharters({ force: true })
      .then(() => console.log(`[Startup] Charter index: ${Object.keys(_charterIndex.byProject).length} charters`))
      .catch(e => console.warn('[Startup] Charter sync failed:', e.message));
    setInterval(() => {
      ensureCharters({ force: true }).catch(e => console.warn('[Charters] background sync failed:', e.message));
      discoverRiskSheets(true).catch(() => {});
    }, CHARTER_REFRESH_MS);
  }
});
