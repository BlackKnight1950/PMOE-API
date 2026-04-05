/**
 * PMOE Command Center — Smartsheet Live Data API
 * Hosted on Render.com (free tier)
 *
 * Set ONE environment variable in Render dashboard:
 *   SMARTSHEET_TOKEN = your Smartsheet API token
 *
 * Endpoints:
 *   GET /api/data    — returns live project + risk + compliance data
 *   GET /api/health  — health check (no auth needed)
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
const RISK_SHEET_PG    = '3689972654624644';  // CCH-Press Ganey Risks Log
const RISK_SHEET_LAB   = '7875273287487364';  // Lab Automation Risks Log
const COMPLIANCE_SHEET = '2177565233991556';  // PM Process Compliance Audit

function headers() {
  return {
    'Authorization': `Bearer ${process.env.SMARTSHEET_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

// ── Health check — no token needed ───────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    token_configured: !!process.env.SMARTSHEET_TOKEN
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
    const [reportRes, pgRiskRes, labRiskRes, complianceRes] = await Promise.all([
      fetch(`${SS_BASE}/reports/${REPORT_ID}?pageSize=100`, { headers: headers() }),
      fetch(`${SS_BASE}/sheets/${RISK_SHEET_PG}?pageSize=100`,   { headers: headers() }),
      fetch(`${SS_BASE}/sheets/${RISK_SHEET_LAB}?pageSize=100`,  { headers: headers() }),
      fetch(`${SS_BASE}/sheets/${COMPLIANCE_SHEET}?pageSize=200`,{ headers: headers() })
    ]);

    if (reportRes.status === 401) {
      return res.status(401).json({ error: 'Smartsheet token invalid. Update SMARTSHEET_TOKEN in Render.' });
    }
    if (!reportRes.ok) {
      return res.status(502).json({ error: `Smartsheet error: ${reportRes.status}` });
    }

    const [reportData, pgData, labData, compData] = await Promise.all([
      reportRes.json(),
      pgRiskRes.json(),
      labRiskRes.json(),
      complianceRes.json()
    ]);

    // ── Parse PMOE Load-Update report ─────────────────────────────────────
    const cols        = reportData.columns || [];
    const projectVid  = cols.find(c => c.title === 'Projects')?.virtualId;
    const delivVid    = cols.find(c => c.title === 'Deliverable')?.virtualId;
    const statusVid   = cols.find(c => c.title === 'Status')?.virtualId;
    const assignedVid = cols.find(c => c.title === 'Assigned To')?.virtualId;
    const riskVid     = cols.find(c => c.title === 'Risk or Issue')?.virtualId;
    const impactVid   = cols.find(c => c.title === 'Impact/Notes')?.virtualId;

    const projectMap = {};
    (reportData.rows || []).forEach(row => {
      const cell    = vid => (row.cells || []).find(c => c.virtualColumnId == vid);
      const project = cell(projectVid)?.displayValue || '';
      const deliv   = cell(delivVid)?.displayValue   || '';
      const status  = cell(statusVid)?.displayValue  || '';
      const pm      = cell(assignedVid)?.displayValue || '';
      const risk    = cell(riskVid)?.displayValue    || '';
      const impact  = cell(impactVid)?.displayValue  || '';
      const date    = (row.modifiedAt || '').split('T')[0];

      if (!project) return;

      if (!projectMap[project]) {
        projectMap[project] = { project, pm, lastUpdated: date, deliverables: [] };
      }
      if (deliv || status) {
        projectMap[project].deliverables.push({
          name: deliv, status, risk: risk || '', impact: impact || ''
        });
      }
      if (pm && !projectMap[project].pm)              projectMap[project].pm = pm;
      if (date > (projectMap[project].lastUpdated || '')) projectMap[project].lastUpdated = date;
    });

    const pmoeLoadData = Object.values(projectMap);

    // ── Parse risk log sheets ─────────────────────────────────────────────
    function parseRisks(sheetData, projectName) {
      const c        = sheetData.columns || [];
      const highId   = c.find(x => x.title === 'High Risk')?.id;
      const catId    = c.find(x => x.title === 'Category')?.id;
      const descId   = c.find(x => x.title === 'Description')?.id;
      const chanceId = c.find(x => x.title === 'Chance of Occuring')?.id;
      const impactId = c.find(x => x.title === 'Impact')?.id;
      const planId   = c.find(x => x.title === 'Action Plan')?.id;

      return (sheetData.rows || []).map(row => {
        const cell = id => (row.cells || []).find(c => c.columnId == id);
        const desc = cell(descId)?.displayValue;
        if (!desc) return null;
        return {
          project:     projectName,
          highRisk:    cell(highId)?.value === true,
          category:    cell(catId)?.displayValue   || '',
          description: desc,
          chance:      cell(chanceId)?.displayValue || '',
          impact:      cell(impactId)?.displayValue || '',
          actionPlan:  cell(planId)?.displayValue   || ''
        };
      }).filter(Boolean);
    }

    const risksData = [
      ...parseRisks(pgData,  'CCH-Press Ganey Consumerism'),
      ...parseRisks(labData, 'Lab Automation Upgrade')
    ];

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
      if (cell.displayValue === 'NA') return false;
      return !!cell.value;
    };

    const complianceParsed = (compData.rows || []).map(row => {
      const cell = id => (row.cells || []).find(c => c.columnId == id);
      const name = cell(projId)?.displayValue || '';
      if (!name) return null;
      return {
        project:  name,
        pm:       cell(pmId)?.displayValue  || '',
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

app.listen(PORT, () => {
  console.log(`PMOE API listening on port ${PORT}`);
  console.log(`Smartsheet token: ${process.env.SMARTSHEET_TOKEN ? 'SET ✓' : 'NOT SET ✗'}`);
});
