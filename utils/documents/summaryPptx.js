'use strict';

const PptxGenJS = require('pptxgenjs');

const { HEX, FONT, formatNumber, formatMoney, formatDate, paletteFor } = require('./brand');
const { assertDocumentOpens, escapeXml } = require('./validate');
const { familyLabel, moduleLabel } = require('./../../config/cloudFamilies');

/**
 * Client-facing summary deck, rendered from a stored quote.
 *
 * Same rule as the other two generators: it formats `quote.estimate` and derives nothing.
 * A deck that rounds differently from the SOW is the version a client will quote back at
 * you in a meeting.
 *
 * Deliberately restrained: seven slides, one message each. A deck that repeats the whole
 * workbook is not read.
 */

const LAYOUT = { name: 'HUB16x9', width: 13.333, height: 7.5 };
const MARGIN = 0.6;
const CONTENT_WIDTH = LAYOUT.width - MARGIN * 2;

function addSlide(pptx, title, subtitle, brand) {
  const slide = pptx.addSlide();
  slide.background = { color: 'FFFFFF' };

  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: LAYOUT.width, h: 0.12, fill: { color: HEX.cyan } });

  slide.addText(title, {
    x: MARGIN,
    y: 0.45,
    w: CONTENT_WIDTH,
    h: 0.6,
    fontFace: FONT,
    fontSize: 26,
    bold: true,
    color: brand.navy
  });

  if (subtitle) {
    slide.addText(subtitle, {
      x: MARGIN,
      y: 1.02,
      w: CONTENT_WIDTH,
      h: 0.35,
      fontFace: FONT,
      fontSize: 13,
      color: HEX.inkMuted
    });
  }

  return slide;
}

function tile(slide, { x, y, w, h, value, label, brand }) {
  slide.addShape('rect', { x, y, w, h, fill: { color: HEX.wash }, line: { color: HEX.rule, width: 0.75 } });
  slide.addText(String(value), {
    x: x + 0.15,
    y: y + 0.18,
    w: w - 0.3,
    h: 0.6,
    fontFace: FONT,
    fontSize: 30,
    bold: true,
    color: brand.navy
  });
  slide.addText(label, {
    x: x + 0.15,
    y: y + 0.82,
    w: w - 0.3,
    h: 0.4,
    fontFace: FONT,
    fontSize: 11,
    color: HEX.inkMuted
  });
}

/** A table styled once, so every table in the deck matches. */
function styledTable(slide, headers, rows, options = {}) {
  const brand = options.brand || HEX;
  const head = headers.map((h) => ({
    text: h.label,
    options: { bold: true, color: 'FFFFFF', fill: { color: brand.navy }, align: h.align || 'left' }
  }));

  const body = rows.map((row) =>
    row.map((value, i) => ({
      text: String(value ?? ''),
      options: { align: headers[i].align || 'left', color: HEX.ink }
    }))
  );

  slide.addTable([head, ...body], {
    x: MARGIN,
    y: options.y || 1.6,
    w: CONTENT_WIDTH,
    colW: options.colW,
    fontFace: FONT,
    fontSize: options.fontSize || 12,
    border: { type: 'solid', pt: 0.5, color: HEX.rule },
    rowH: options.rowH || 0.32,
    valign: 'middle',
    autoPage: false
  });
}

/**
 * The opening slide, on the brand colour.
 *
 * The company's legal name replaces the Hub's where one is configured — this is the deck
 * a consultancy presents, and its own name belongs on the cover. Plain text, escaped by
 * pptxgenjs, and nothing here is derived from anything a client can influence.
 */
function titleSlide(pptx, quote, estimate, brand, branding) {
  const slide = pptx.addSlide();
  slide.background = { color: brand.navy };

  const legalName = (branding && branding.letterhead && branding.letterhead.legal_name) || null;
  if (legalName) {
    slide.addText(legalName, {
      x: MARGIN, y: 1.55, w: CONTENT_WIDTH, h: 0.4, fontFace: FONT, fontSize: 14, bold: true, color: 'FFFFFF'
    });
  }

  slide.addText('Statement of Work', { x: MARGIN, y: 2.2, w: CONTENT_WIDTH, h: 0.7, fontFace: FONT, fontSize: 36, bold: true, color: 'FFFFFF' });
  /*
   * White, not cyan.
   *
   * The background is now whatever the company chose, and a colour only reaches this
   * function after passing a 4.5:1 check against WHITE — which is precisely the ratio for
   * white text ON that colour. So white is guaranteed readable on any permitted brand;
   * cyan is guaranteed nothing, and would vanish against a brand near it. The accent bar
   * below stays cyan because it is decoration, not text.
   */
  slide.addText(quote.project_name, { x: MARGIN, y: 2.95, w: CONTENT_WIDTH, h: 0.6, fontFace: FONT, fontSize: 22, color: 'FFFFFF' });
  slide.addText(
    `Prepared for ${quote.client_company}${quote.client_name ? ` · ${quote.client_name}` : ''}`,
    { x: MARGIN, y: 3.7, w: CONTENT_WIDTH, h: 0.4, fontFace: FONT, fontSize: 14, color: 'FFFFFF' }
  );
  slide.addText(`${quote.reference} · ${formatDate(quote.created_at)}`, {
    x: MARGIN,
    y: 4.1,
    w: CONTENT_WIDTH,
    h: 0.4,
    fontFace: FONT,
    fontSize: 12,
    color: HEX.rule
  });

  slide.addShape('rect', { x: MARGIN, y: 5.1, w: 2.2, h: 0.06, fill: { color: HEX.cyan } });
  slide.addText(
    `${formatNumber(estimate.totalManDays)} man-days · ${estimate.projectDurationWeeks} weeks · ${formatMoney(estimate.totalBudget, estimate.currency)}`,
    { x: MARGIN, y: 5.35, w: CONTENT_WIDTH, h: 0.4, fontFace: FONT, fontSize: 14, color: 'FFFFFF' }
  );
}

function summarySlide(pptx, estimate, brand) {
  const slide = addSlide(pptx, 'At a glance', 'Effort, duration and cost for the scope agreed', brand);

  const tileWidth = (CONTENT_WIDTH - 0.45) / 4;
  const tiles = [
    { value: formatNumber(estimate.totalManDays), label: 'Man-days' },
    { value: `${estimate.projectDurationWeeks} wk`, label: `About ${estimate.projectDurationMonths} months` },
    { value: formatNumber(estimate.implementationBudget), label: `Implementation (${estimate.currency})` },
    { value: formatNumber(estimate.averageDailyRate), label: `Blended day rate (${estimate.currency})` }
  ];

  tiles.forEach((t, i) => {
    tile(slide, { x: MARGIN + i * (tileWidth + 0.15), y: 1.7, w: tileWidth, h: 1.35, brand, ...t });
  });

  const rows = [
    ['Base effort from the agreed scope', `${formatNumber(estimate.baseEffort)} days`],
    [`Contingency at ${estimate.contingencyPercentage}%`, `${formatNumber(estimate.contingencyDays)} days`],
    ['Total effort', `${formatNumber(estimate.totalManDays)} days`],
    [`Implementation (${estimate.currency})`, formatNumber(estimate.implementationBudget)]
  ];

  if (estimate.supportBudget > 0) {
    rows.push([`Hypercare, ${estimate.options.supportDurationDays} days (${estimate.currency})`, formatNumber(estimate.supportBudget)]);
  }
  rows.push([`Total (${estimate.currency})`, formatNumber(estimate.totalBudget)]);

  styledTable(slide, [{ label: 'Basis' }, { label: 'Value', align: 'right' }], rows, {
    brand,
    y: 3.35,
    colW: [CONTENT_WIDTH * 0.7, CONTENT_WIDTH * 0.3]
  });
}

function scopeSlide(pptx, estimate, brand) {
  const slide = addSlide(pptx, 'Scope', 'What is being implemented', brand);

  const rows = estimate.familyBreakdown.map((family) => {
    const modules = estimate.moduleBreakdown.filter((m) => m.family === family.id).map((m) => moduleLabel(m.id));
    return [familyLabel(family.id), modules.length ? modules.join(', ') : 'Platform setup only', `${family.effectiveDays} d`];
  });

  for (const isv of estimate.isvBreakdown) rows.push(['Add-on', isv.name, `${isv.days} d`]);

  if (estimate.multipliers.integrations.count > 0) {
    const { count, complexity, daysEach } = estimate.multipliers.integrations;
    rows.push(['Integrations', `${count} × ${complexity}`, `${count * daysEach} d`]);
  }

  if (estimate.unmapped.days > 0) {
    rows.push(['To be specified', 'Described in free text, allowance only', `${estimate.unmapped.days} d`]);
  }

  styledTable(slide, [{ label: 'Cloud' }, { label: 'Included' }, { label: 'Effort', align: 'right' }], rows, {
    brand,
    colW: [CONTENT_WIDTH * 0.24, CONTENT_WIDTH * 0.61, CONTENT_WIDTH * 0.15],
    fontSize: 11
  });
}

/** Phases as proportional bars: the shape of the project in one look. */
function approachSlide(pptx, estimate, brand) {
  const slide = addSlide(pptx, 'Approach', 'Phases run largely in sequence; the team works in parallel within each', brand);

  const phases = estimate.phaseBreakdown.filter((p) => p.days > 0);
  const maxDays = Math.max(...phases.map((p) => p.days));
  const rowHeight = Math.min(0.52, 4.6 / phases.length);
  const barArea = CONTENT_WIDTH - 4.6;

  phases.forEach((phase, i) => {
    const y = 1.75 + i * rowHeight;

    slide.addText(phase.name, { x: MARGIN, y, w: 2.9, h: rowHeight, fontFace: FONT, fontSize: 11, color: HEX.ink, valign: 'middle' });

    slide.addShape('rect', {
      x: MARGIN + 3.0,
      y: y + rowHeight * 0.22,
      w: Math.max(0.06, (phase.days / maxDays) * barArea),
      h: rowHeight * 0.5,
      fill: { color: i % 2 === 0 ? brand.blue : HEX.cyan }
    });

    slide.addText(`${formatNumber(phase.days)} d · ${phase.percentage}%`, {
      x: LAYOUT.width - MARGIN - 1.5,
      y,
      w: 1.5,
      h: rowHeight,
      fontFace: FONT,
      fontSize: 10,
      color: HEX.inkMuted,
      align: 'right',
      valign: 'middle'
    });
  });

  slide.addText(
    `Total ${formatNumber(estimate.totalManDays)} man-days. Phase days sum exactly to this figure.`,
    { x: MARGIN, y: 6.6, w: CONTENT_WIDTH, h: 0.4, fontFace: FONT, fontSize: 10, color: HEX.inkMuted }
  );
}

/** The same timeline the SOW and the workbook print, drawn as a Gantt. */
function timelineSlide(pptx, estimate, brand) {
  const slide = addSlide(pptx, 'Timeline', `${estimate.projectDurationWeeks} weeks from kick-off to hypercare exit`, brand);

  const totalWeeks = estimate.projectDurationWeeks;
  const rowHeight = Math.min(0.5, 4.4 / Math.max(1, estimate.timeline.length));
  const trackX = MARGIN + 3.0;
  const trackWidth = CONTENT_WIDTH - 3.0;

  estimate.timeline.forEach((slot, i) => {
    const y = 1.8 + i * rowHeight;

    slide.addText(slot.phase, { x: MARGIN, y, w: 2.9, h: rowHeight, fontFace: FONT, fontSize: 10, color: HEX.ink, valign: 'middle' });

    slide.addShape('rect', {
      x: trackX + ((slot.startWeek - 1) / totalWeeks) * trackWidth,
      y: y + rowHeight * 0.22,
      w: Math.max(0.08, (slot.durationWeeks / totalWeeks) * trackWidth),
      h: rowHeight * 0.5,
      fill: { color: brand.blue },
      line: { color: brand.navy, width: 0.5 }
    });
  });

  const lastY = 1.8 + estimate.timeline.length * rowHeight + 0.15;
  slide.addText(
    estimate.timeline.map((t) => `W${t.startWeek}–${t.endWeek} ${t.milestone}`).join('   ·   '),
    { x: MARGIN, y: lastY, w: CONTENT_WIDTH, h: 0.8, fontFace: FONT, fontSize: 9, color: HEX.inkMuted }
  );
}

function commercialsSlide(pptx, estimate, brand) {
  const slide = addSlide(pptx, 'Team and commercials', `All figures in ${estimate.currency}, exclusive of VAT and expenses`, brand);

  const rows = estimate.resourceAllocation.map((r) => [
    r.name,
    `${r.percentage}%`,
    formatNumber(r.days),
    formatNumber(r.dailyRate),
    formatNumber(r.totalCost)
  ]);

  rows.push([
    'Implementation',
    '100%',
    formatNumber(estimate.resourceAllocation.reduce((s, r) => s + r.days, 0)),
    '',
    formatNumber(estimate.implementationBudget)
  ]);

  if (estimate.supportBudget > 0) {
    rows.push([`Hypercare (${estimate.options.supportDurationDays} days)`, '', '', '', formatNumber(estimate.supportBudget)]);
  }
  rows.push(['Total', '', '', '', formatNumber(estimate.totalBudget)]);

  styledTable(
    slide,
    [
      { label: 'Role' },
      { label: 'Share', align: 'right' },
      { label: 'Days', align: 'right' },
      { label: 'Day rate', align: 'right' },
      { label: 'Cost', align: 'right' }
    ],
    rows,
    { colW: [CONTENT_WIDTH * 0.36, CONTENT_WIDTH * 0.12, CONTENT_WIDTH * 0.12, CONTENT_WIDTH * 0.18, CONTENT_WIDTH * 0.22], fontSize: 11, brand }
  );
}

function nextStepsSlide(pptx, quote, estimate, brand) {
  const slide = addSlide(pptx, 'Assumptions and next steps', 'What this estimate rests on', brand);

  const assumptions = [
    `An estimate, not a fixed price. Contingency of ${estimate.contingencyPercentage}% covers normal discovery findings, not scope additions.`,
    'Timely access to stakeholders, source systems and test data.',
    'One production org and its standard sandbox chain for the duration.',
    'UAT carried out by the client within the window shown in the timeline.',
    'Excludes Salesforce licences, AppExchange subscriptions and source-data cleansing.'
  ];

  if (estimate.unmapped.days > 0) {
    assumptions.push(
      `${estimate.unmapped.modules + estimate.unmapped.isvs + estimate.unmapped.integrations} item(s) described in free text carry an allowance of ${estimate.unmapped.days} days and must be specified before sign-off.`
    );
  }

  slide.addText(
    assumptions.map((a) => ({ text: a, options: { bullet: true, breakLine: true } })),
    { x: MARGIN, y: 1.7, w: CONTENT_WIDTH, h: 3.2, fontFace: FONT, fontSize: 13, color: HEX.ink, lineSpacingMultiple: 1.2 }
  );

  slide.addShape('rect', { x: MARGIN, y: 5.2, w: CONTENT_WIDTH, h: 1.4, fill: { color: HEX.wash }, line: { color: HEX.rule, width: 0.75 } });
  slide.addText('Next steps', { x: MARGIN + 0.25, y: 5.35, w: CONTENT_WIDTH - 0.5, h: 0.3, fontFace: FONT, fontSize: 13, bold: true, color: brand.navy });
  slide.addText(
    `Confirm the scope in section 1, then we schedule discovery. This estimate (${quote.reference}) is valid for 30 days from ${formatDate(quote.created_at)}.`,
    { x: MARGIN + 0.25, y: 5.7, w: CONTENT_WIDTH - 0.5, h: 0.7, fontFace: FONT, fontSize: 12, color: HEX.ink }
  );
}

/**
 * @param {Object} quote stored row with `estimate` parsed
 * @returns {Promise<Buffer>} a validated PPTX
 */
async function generateSummaryPptx(quote, { preparedBy = '', branding = null } = {}) {
  // Resolved once per deck, threaded down. See the note in sowDocx on why this cannot be
  // a module-level value.
  const brand = paletteFor(branding);
  const estimate = quote.estimate;

  const pptx = new PptxGenJS();
  pptx.defineLayout(LAYOUT);
  pptx.layout = LAYOUT.name;
  /*
   * The company's own legal name where it configured one: this is their deck, presented
   * under their name, and the Hub is the tool that built it rather than the sender.
   *
   * ESCAPED, and this is a real bug rather than a precaution. `pptxgenjs` escapes slide
   * body text but writes `author` and `company` straight into `docProps/app.xml`. A
   * company called "Smith & Jones Ltd" — about as ordinary as a name gets — produced a
   * package whose app.xml would not parse, and `assertDocumentOpens` refused to serve it.
   * The feature would have been broken for a large share of its users.
   *
   * A test reads app.xml back and asserts the name appears escaped exactly once, so a
   * future version of the library that starts escaping this field is caught too: a
   * double-escaped name is still valid XML and a parse check alone would miss it.
   */
  const author = (branding && branding.letterhead && branding.letterhead.legal_name) || preparedBy || 'Salesforce Hub';
  pptx.author = escapeXml(author);
  pptx.company = escapeXml(author);
  pptx.title = `Statement of Work — ${quote.project_name}`;
  pptx.subject = `Prepared for ${quote.client_company}`;

  titleSlide(pptx, quote, estimate, brand, branding);
  summarySlide(pptx, estimate, brand);
  scopeSlide(pptx, estimate, brand);
  approachSlide(pptx, estimate, brand);
  timelineSlide(pptx, estimate, brand);
  commercialsSlide(pptx, estimate, brand);
  nextStepsSlide(pptx, quote, estimate, brand);

  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  assertDocumentOpens(buffer, 'pptx', 'summary deck');

  return buffer;
}

module.exports = { generateSummaryPptx };
