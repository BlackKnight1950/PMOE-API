/**
 * PMOE Command Center — Smartsheet Live Data API
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

let _riskSheetCache   = [...KNOWN_RISK_SHEETS]; // pre-seeded — never empty
let _riskCacheExpiry  = 0;
const RISK_CACHE_TTL  = 6 * 60 * 60 * 1000; // 6 hours

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
  'Justice-Involved Re-Entry (1115 Waiver)': 'Justice-Involved Re-Entry',
};
function normProjectName(raw) {
  if (PROJECT_NAME_MAP[raw]) return PROJECT_NAME_MAP[raw];
  for (const [abbr, full] of Object.entries(PROJECT_NAME_MAP)) {
    if (raw.toLowerCase().startsWith(abbr.toLowerCase())) return full;
  }
  return raw;
}

// Active project folder contexts — used to filter search results to live projects only
const ACTIVE_CONTEXTS = ['planning and execution phase', 'live with punch', 'on hold'];

async function discoverRiskSheets() {
  if (Date.now() < _riskCacheExpiry) return _riskSheetCache;

  const token = process.env.SMARTSHEET_TOKEN;
  if (!token) return _riskSheetCache;

  try {
    // Smartsheet REST Search API — correct field names:
    //   objectId   → sheet ID
    //   objectType → "sheet"
    //   text       → sheet name
    //   contextData → array of breadcrumb strings e.g.
    //     ["Project Management Office > ... > Planning and Execution Phase > ..."]
    const [riskRes, issueRes] = await Promise.all([
      fetch(`${SS_BASE}/search?query=Risk%20Log&scopes=sheetName`, { headers: ssHeaders() }),
      fetch(`${SS_BASE}/search?query=Issue%20Log&scopes=sheetName`, { headers: ssHeaders() })
    ]);

    const [riskData, issueData] = await Promise.all([
      riskRes.ok  ? riskRes.json()  : { results: [] },
      issueRes.ok ? issueRes.json() : { results: [] }
    ]);

    const allResults = [...(riskData.results || []), ...(issueData.results || [])];

    // Build a set of IDs already in KNOWN_RISK_SHEETS so we don't double-add
    const knownIds = new Set(KNOWN_RISK_SHEETS.map(s => s.id));
    const discovered = [];
    const seen = new Set(knownIds);

    for (const result of allResults) {
      // Correct field names from Smartsheet REST Search API
      if (result.objectType !== 'sheet') continue;
      const id = String(result.objectId || '');
      if (!id || seen.has(id)) continue;

      // contextData is an array; join to get full breadcrumb path for filtering
      const contextArr  = Array.isArray(result.contextData) ? result.contextData : [];
      const contextStr  = contextArr.join(' > ').toLowerCase();
      const isActive    = ACTIVE_CONTEXTS.some(c => contextStr.includes(c));
      if (!isActive) continue;

      const sheetName = result.text || '';
      if (sheetName.toLowerCase().includes('template')) continue;

      const parsed = parseRiskSheetName(sheetName);
      if (!parsed) continue;

      seen.add(id);
      discovered.push({ id, project: normProjectName(parsed.project), type: parsed.type });
    }

    const combined = [...KNOWN_RISK_SHEETS, ...discovered];
    console.log(`[Risk Discovery] ${combined.length} sheets (${KNOWN_RISK_SHEETS.length} known + ${discovered.length} newly discovered)`);
    if (discovered.length) discovered.forEach(s => console.log(`  NEW ${s.type} ${s.id} ${s.project}`));

    _riskSheetCache  = combined;
    _riskCacheExpiry = Date.now() + RISK_CACHE_TTL;
    return combined;

  } catch (err) {
    console.warn('[Risk Discovery] Search failed, using known sheets only:', err.message);
    _riskCacheExpiry = Date.now() + RISK_CACHE_TTL; // don't hammer on error
    return _riskSheetCache;
  }
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
    'Precious Avery'
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
    risk_cache_expires:    _riskCacheExpiry ? new Date(_riskCacheExpiry).toISOString() : null
  });
});

// ── Force-refresh risk/issue sheet discovery cache ────────────────────────────
// Call this after adding a new project's risk/issue logs to Smartsheet so the
// app picks them up immediately without waiting for the 6-hour TTL.
app.post('/api/risks/refresh', async (req, res) => {
  _riskCacheExpiry = 0; // invalidate cache
  const sheets = await discoverRiskSheets();
  res.json({ refreshed: true, sheetsFound: sheets.length, sheets });
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

  const systemPrompt = `You are Ask Cody, the PMOE Virtual Assistant for Cook County Health's Project Management & Operational Excellence (PMOE) department. You help users understand and navigate the PMOE Command Center dashboard.

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
    // Discover all active risk/issue log sheets dynamically (cached 6h)
    const RISK_ISSUE_SHEETS = await discoverRiskSheets();

    // Fetch all Smartsheet sources in parallel
    const riskIssuePromises = RISK_ISSUE_SHEETS.map(s =>
      fetch(`${SS_BASE}/sheets/${s.id}?pageSize=200`, { headers: ssHeaders() })
    );

    const [reportRes, complianceRes, ...riskIssueResponses] = await Promise.all([
      fetch(`${SS_BASE}/reports/${REPORT_ID}?pageSize=100`, { headers: ssHeaders() }),
      fetch(`${SS_BASE}/sheets/${COMPLIANCE_SHEET}?pageSize=200`, { headers: ssHeaders() }),
      ...riskIssuePromises
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

    // Parse risk/issue sheets — skip failed fetches gracefully
    const riskIssueData = await Promise.all(
      riskIssueResponses.map(async (r, i) => ({
        meta: RISK_ISSUE_SHEETS[i],
        data: r.ok ? await r.json() : null
      }))
    );

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

    // ── Back-fill PM & sponsor from compliance data when report row is blank ──
    // The PMOE Load-Update report's "Assigned To" cell may be empty for newly added
    // projects (e.g. Provident ICU Closure). Compliance sheet reliably has the PM.
    // We do a second pass after complianceParsed is built (below) to fill gaps.

    // ── Parse risk & issue log sheets ─────────────────────────────────────
    // Risk logs:  Status column options = Active | Inactive | Resolved  → skip Resolved/Inactive
    // Issue logs: Status column options = New | In-Progress | On-Hold | Addressed/Closed → skip Addressed/Closed
    const RISK_RESOLVED_VALUES  = ['resolved', 'inactive'];
    const ISSUE_CLOSED_VALUES   = ['addressed/closed', 'closed', 'resolved'];

    function parseRisks(sheetData, projectName, logType) {
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

    const risksData = riskIssueData.flatMap(({ meta, data }) => {
      if (!data) return [];
      return parseRisks(data, meta.project, meta.type);
    });

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
      goal:         152000000,
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
      monthlyBreakdown, cumulative,
      countyCareMembers, careCoordination, revenueClaims
    });
  } catch (err) {
    console.error('EARN error:', err.message);
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
      const dept  = cell(deptId)?.displayValue  || '';
      const title = cell(titleId)?.displayValue || '';
      const url   = cell(linkId)?.displayValue  || cell(linkId)?.value || '';
      if (!dept || !title) return null;
      return { dept, title, url };
    }).filter(Boolean);

    res.json({ fetchedAt: new Date().toISOString(), requests });
  } catch (err) {
    console.error('Service requests error:', err.message);
    res.status(500).json({ error: err.message });
  }
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
  }
});
