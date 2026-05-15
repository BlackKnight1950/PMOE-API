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
 *   GET  /api/health        — health check (no auth needed)
 *   GET  /api/data          — returns live project + risk + compliance data
 *   POST /api/ai            — proxy for Claude Key Insights (body: { prompt })
 *   POST /api/cody/message  — proxy for Cody chatbot (body: { content, conversation_id? })
 *   POST /api/cody/conversation — create a new Cody conversation (body: { name })
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

// Risk & Issue log sheet IDs — one pair per active project in PMO Workspace
// Risk logs: Status options = Active | Inactive | Resolved
// Issue logs: Status options = New | In-Progress | On-Hold | Addressed/Closed
const RISK_ISSUE_SHEETS = [
  { id: '3689972654624644', project: 'CCH-Press Ganey Consumerism', type: 'risk'  },
  { id: '8193572281995140', project: 'CCH-Press Ganey Consumerism', type: 'issue' },
  { id: '7875273287487364', project: 'Lab Automation Upgrade',      type: 'risk'  },
  { id: '2165427800067972', project: 'Lab Automation Upgrade',      type: 'issue' },
  { id: '3128683794485124', project: 'RxLink',                      type: 'risk'  },
  { id: '483624964018052',  project: 'RxLink',                      type: 'issue' },
];

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
    cody_configured:       !!(process.env.CODY_API_KEY && process.env.CODY_BOT_ID)
  });
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

async function askClaude(userMessage, dashboardContext, conversationHistory) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const systemPrompt = `You are Ask Cody, the PMOE Virtual Assistant for Cook County Health's Project Management & Operational Excellence (PMOE) department. You help users understand and navigate the PMOE Command Center dashboard.

You have access to the following live dashboard data:
${dashboardContext}

Guidelines:
- Be concise, warm, and professional.
- When answering about projects, reference specific details from the dashboard data above.
- For navigation questions, guide users to the relevant dashboard tab.
- If asked about a specific project, pull its PM, status, and latest update from the data.
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
    const claudeText = await askClaude(content, dashboard_context || '(no dashboard data provided)', history);
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

// ── Main data endpoint ────────────────────────────────────────────────────────
app.get('/api/data', async (req, res) => {
  if (!process.env.SMARTSHEET_TOKEN) {
    return res.status(500).json({
      error: 'SMARTSHEET_TOKEN not configured. Set it in Render environment variables.'
    });
  }

  try {
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
      const project = cell(projectVid)?.displayValue || '';
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

      return (sheetData.rows || []).map(row => {
        const cell = id => (row.cells || []).find(c => c.columnId == id);
        const desc = cell(descId)?.displayValue;
        if (!desc) return null;

        // Filter out resolved/closed items
        const statusVal = (cell(statusId)?.displayValue || '').toLowerCase().trim();
        if (logType === 'risk'  && RISK_RESOLVED_VALUES.some(v => statusVal.includes(v)))  return null;
        if (logType === 'issue' && ISSUE_CLOSED_VALUES.some(v => statusVal.includes(v)))    return null;

        return {
          project:     projectName,
          logType:     logType,  // 'risk' or 'issue'
          highRisk:    cell(highId)?.value === true,
          category:    cell(catId)?.displayValue   || '',
          description: desc,
          chance:      cell(chanceId)?.displayValue || '',
          impact:      cell(impactId)?.displayValue || '',
          actionPlan:  cell(planId)?.displayValue   || '',
          status:      cell(statusId)?.displayValue || ''
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
      const name = cell(projId)?.displayValue || '';
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

    const projects = (data.rows || []).map(row => {
      const cell = id => (row.cells || []).find(c => c.columnId == id);
      const name = cell(initId)?.displayValue;
      if (!name) return null;
      const status = cell(statusId)?.displayValue || '';
      // Only active projects (In Progress or On Hold)
      if (!['In Progress','On Hold'].includes(status)) return null;
      // Skip sub-deliverable rows (no sponsor/phase = child row)
      const phase = cell(phaseId)?.displayValue || '';
      if (!phase) return null;
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


app.listen(PORT, () => {
  console.log(`PMOE API listening on port ${PORT}`);
  console.log(`Smartsheet token:  ${process.env.SMARTSHEET_TOKEN  ? 'SET ✓' : 'NOT SET ✗'}`);
  console.log(`Anthropic API key: ${process.env.ANTHROPIC_API_KEY ? 'SET ✓' : 'NOT SET ✗'}`);
  console.log(`Cody API key:      ${process.env.CODY_API_KEY      ? 'SET ✓' : 'NOT SET ✗'}`);
  console.log(`Cody Bot ID:       ${process.env.CODY_BOT_ID       ? 'SET ✓' : 'NOT SET ✗'}`);
});
