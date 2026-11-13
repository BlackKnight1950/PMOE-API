'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// charter-parser.js
//
// Turns an uploaded Project Charter (.docx or .pdf) into the compact fields the
// PMOE Command Center shows on a project card / modal:
//   purpose, objectives, scope, deliverables, timeline
//
// The parser is deliberately template-agnostic. Charters are built from several
// Word templates (label/value tables, heading + paragraph, "Label: value" lines),
// so instead of hard-coding one layout it:
//   1. converts the document to an ordered list of blocks (headings, paragraphs,
//      list items, tables),
//   2. builds two lookups from those blocks — `fields` (table/inline label → value)
//      and `sections` (heading → body text),
//   3. resolves each wanted field through a list of label synonyms.
// If no purpose can be found the first substantive paragraphs are used and the
// result is flagged `approximate: true` so the UI / debug view can tell.
// ─────────────────────────────────────────────────────────────────────────────

const mammoth = require('mammoth');

const LIMITS = { purpose: 650, objectives: 900, scope: 650, deliverables: 700, timeline: 450 };

// Label synonyms, in priority order. A label matches when the regex tests true on
// the (trimmed, colon-stripped) label text.
const SYNONYMS = {
  purpose: [
    /^(project\s+)?purpose\b/i,
    /^(business\s+)?(need|case|problem)\b|^problem\s+statement/i,
    /^project\s+(description|overview|summary)\b|^executive\s+summary|^(description|overview|background)\b/i
  ],
  objectives: [
    /^(key\s+|project\s+|primary\s+)?objectives?\b/i,
    /^(project\s+)?goals?\b|^desired\s+outcomes?|^success\s+(criteria|measures|metrics)/i
  ],
  scope: [
    /^(project\s+)?scope\b|^in[-\s]scope\b/i
  ],
  deliverables: [
    /^(key\s+|major\s+)?deliverables?\b|^key\s+outputs?\b/i
  ],
  timeline: [
    /^(project\s+)?(timeline|schedule)\b|^(key\s+)?milestones?\b|^target\s+(go[-\s]?live|completion)/i
  ]
};

// ── small text helpers ───────────────────────────────────────────────────────
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', bull: '•' };
function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (ENT[n.toLowerCase()] !== undefined ? ENT[n.toLowerCase()] : m));
}
function stripTags(html) {
  return decode(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div)>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
const oneLine = s => (s || '').replace(/\s+/g, ' ').trim();

// Template placeholder text that was never filled in ("[Enter purpose here]", "TBD", …)
function isPlaceholder(v) {
  const t = oneLine(v);
  if (!t) return true;
  if (/^[\[<(]\s*(insert|enter|click|type|add|describe|provide|list|state|tbd|n\/a|na)\b/i.test(t)) return true;
  if (/^(tbd|n\/?a|none|-+|_+|\.+)$/i.test(t)) return true;
  return false;
}

function truncate(s, max) {
  const t = (s || '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:–-]+$/, '') + '…';
}

// ── HTML (from mammoth) → ordered blocks ─────────────────────────────────────
function htmlToBlocks(html) {
  const blocks = [];
  const re = /<(h[1-6]|p|table|ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase();
    const inner = m[2];
    if (/^h[1-6]$/.test(tag)) {
      const text = oneLine(stripTags(inner));
      if (text) blocks.push({ type: 'h', text });
    } else if (tag === 'p') {
      const text = stripTags(inner);
      if (!text) continue;
      const boldOnly = /^\s*(<(strong|b)>[\s\S]*<\/\2>)\s*$/i.test(inner) && oneLine(text).length <= 90 && !/[.!?]$/.test(oneLine(text));
      blocks.push({ type: 'p', text, boldOnly });
    } else if (tag === 'ul' || tag === 'ol') {
      const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(x => oneLine(stripTags(x[1]))).filter(Boolean);
      items.forEach(t => blocks.push({ type: 'li', text: t }));
    } else if (tag === 'table') {
      const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(r =>
        [...r[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => stripTags(c[1]))
      ).filter(r => r.length);
      if (rows.length) blocks.push({ type: 'table', rows });
    }
  }
  return blocks;
}

// ── blocks → { fields, sections } ────────────────────────────────────────────
function structureFromBlocks(blocks) {
  const fields = [];    // { label, value }
  const sections = [];  // { heading, body[] }
  let cur = { heading: '', body: [] };
  sections.push(cur);
  const startSection = h => { cur = { heading: oneLine(h), body: [] }; sections.push(cur); };
  const addBody = t => { if (t && !isPlaceholder(t)) cur.body.push(t); };

  for (const b of blocks) {
    if (b.type === 'h') { startSection(b.text); continue; }
    if (b.type === 'li') { addBody('• ' + b.text); continue; }
    if (b.type === 'p') {
      if (b.boldOnly) { startSection(b.text.replace(/[:：]\s*$/, '')); continue; }
      // "Purpose: text…" inline label
      const mm = oneLine(b.text).match(/^([A-Za-z][A-Za-z &/'-]{2,40}?)\s*[:：]\s+(\S[\s\S]*)$/);
      if (mm && !/^https?$/i.test(mm[1])) {
        // A "Label: value" line delimits the previous section and opens its own.
        fields.push({ label: mm[1].trim(), value: mm[2].trim() });
        startSection(mm[1].trim());
        addBody(mm[2].trim());
        continue;
      }
      addBody(b.text);
      continue;
    }
    if (b.type === 'table') {
      for (const row of b.rows) {
        const cells = row.map(c => c.trim());
        const nonEmpty = cells.filter(Boolean);
        if (!nonEmpty.length) continue;
        if (nonEmpty.length === 1) {
          const t = oneLine(nonEmpty[0]);
          // a lone short cell is a banner/section header; a long one is body text
          if (t.length <= 70 && !/[.!?]$/.test(t)) startSection(t.replace(/[:：]\s*$/, ''));
          else addBody(nonEmpty[0]);
          continue;
        }
        const label = oneLine(cells[0]).replace(/[:：]\s*$/, '');
        const value = cells.slice(1).filter(Boolean).join('\n');
        if (label && value && label.length <= 90 && label !== oneLine(value) && !isPlaceholder(value)) {
          fields.push({ label, value });
        }
        // Also keep every table row as body text so a data table (e.g. milestones)
        // still contributes to the enclosing section.
        addBody(nonEmpty.map(oneLine).join(' — '));
      }
    }
  }
  return { fields, sections: sections.filter(s => s.heading || s.body.length) };
}

// ── resolve wanted fields ────────────────────────────────────────────────────
function resolveField(name, st) {
  for (const re of SYNONYMS[name]) {
    const f = st.fields.find(x => re.test(oneLine(x.label)) && !isPlaceholder(x.value));
    if (f) return f.value;
    const s = st.sections.find(x => x.heading && re.test(x.heading) && x.body.length);
    if (s) return s.body.join('\n');
  }
  return '';
}

function tidy(text, max) {
  const t = (text || '')
    .split('\n').map(l => oneLine(l)).filter(Boolean)
    .filter(l => !isPlaceholder(l))
    .join('\n');
  return truncate(t, max);
}

function resolveAll(st) {
  const out = {};
  for (const k of Object.keys(SYNONYMS)) out[k] = tidy(resolveField(k, st), LIMITS[k]);
  let approximate = false;
  if (!out.purpose) {
    // Fallback: first substantive paragraph(s) of the document.
    const paras = [];
    for (const s of st.sections) for (const l of s.body) if (!l.startsWith('•') && oneLine(l).length >= 60) paras.push(oneLine(l));
    if (paras.length) { out.purpose = truncate(paras.slice(0, 2).join('\n'), LIMITS.purpose); approximate = true; }
  }
  return { fields: out, approximate };
}

// ── format-specific entry points ─────────────────────────────────────────────
async function parseDocx(buffer) {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const st = structureFromBlocks(htmlToBlocks(html));
  return st;
}

// PDF text extraction flattens table cells ("Project PurposeUpgrade the …"), so
// instead of heading detection we scan for known charter labels at line starts and
// take everything up to the next known label as the value.
const PDF_WANTED = [
  'project purpose', 'purpose', 'business need', 'business case', 'problem statement', 'project description',
  'project overview', 'executive summary', 'background', 'overview', 'description',
  'project objectives', 'key objectives', 'primary objectives', 'objectives', 'objective', 'project goals', 'goals',
  'desired outcomes', 'success criteria', 'success measures', 'success metrics',
  'project scope', 'in scope', 'scope',
  'key deliverables', 'major deliverables', 'deliverables',
  'project timeline', 'timeline', 'project schedule', 'schedule', 'key milestones', 'milestones'
];
const PDF_STOP = [
  'project name', 'project title', 'project sponsor', 'executive sponsor', 'sponsor', 'project manager', 'project lead',
  'stakeholders', 'project team', 'team members', 'budget', 'project budget', 'risks', 'key risks', 'assumptions',
  'constraints', 'dependencies', 'approvals', 'approval', 'signatures', 'out of scope', 'out-of-scope', 'date', 'version',
  'prepared by', 'department', 'charter', 'project charter'
];
const PDF_LABELS = [...PDF_WANTED, ...PDF_STOP].sort((a, b) => b.length - a.length);

function matchPdfLabel(line) {
  const low = line.toLowerCase();
  for (const lab of PDF_LABELS) {
    if (!low.startsWith(lab)) continue;
    const rest = line.slice(lab.length);
    const trimmed = rest.replace(/^[\s:：\-–]+/, '');
    const sepOnly = rest.length > 0 && /^[:：\-–]/.test(rest.trimStart());
    const glued = rest.length > 0 && !/^\s/.test(rest) && !sepOnly;        // "PurposeUpgrade"
    if (trimmed === '' || sepOnly || glued ? /^[A-Z0-9\[(•\-]|^$/.test(trimmed) : /^[A-Z0-9\[(•\-]/.test(trimmed)) {
      return { label: line.slice(0, lab.length), value: trimmed, wanted: PDF_WANTED.includes(lab) };
    }
  }
  return null;
}

async function parsePdf(buffer) {
  // lib/pdf-parse.js avoids the package index's debug-mode self-test read.
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  const { text } = await pdfParse(buffer);
  const lines = (text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const fields = [];
  const sections = [];
  let cur = null;
  const prose = { heading: '', body: [] };
  for (const l of lines) {
    const m = matchPdfLabel(l);
    if (m) {
      cur = { label: m.label, parts: m.value ? [m.value] : [] };
      fields.push(cur);
      continue;
    }
    (cur ? cur.parts : prose.body).push(l);
  }
  const outFields = fields.map(f => ({ label: f.label, value: f.parts.join(' ').replace(/\s+/g, ' ').trim() }))
    .filter(f => f.value && !isPlaceholder(f.value));
  if (prose.body.length) sections.push(prose);
  return { fields: outFields, sections };
}

function kindOf(name, mime) {
  const ext = ((name || '').match(/\.([a-z0-9]+)$/i) || [])[1];
  const e = (ext || '').toLowerCase();
  if (e === 'docx' || /wordprocessingml/.test(mime || '')) return 'docx';
  if (e === 'pdf' || mime === 'application/pdf') return 'pdf';
  return null;
}

// Main entry: returns { parsed, approximate, fields, outline } or { parsed:false, reason }.
async function extractCharter(buffer, name, mime) {
  const kind = kindOf(name, mime);
  if (!kind) return { parsed: false, reason: 'unsupported file type' };
  try {
    const st = kind === 'docx' ? await parseDocx(buffer) : await parsePdf(buffer);
    const { fields, approximate } = resolveAll(st);
    const outline = st.sections.filter(s => s.heading).map(s => s.heading).slice(0, 40);
    const labels = st.fields.map(f => f.label).slice(0, 60);
    const found = Object.values(fields).some(Boolean);
    return { parsed: found, approximate, fields, outline, labels, reason: found ? '' : 'no recognisable charter sections' };
  } catch (err) {
    return { parsed: false, reason: 'parse error: ' + err.message };
  }
}

module.exports = { extractCharter, htmlToBlocks, structureFromBlocks, resolveAll, kindOf };
