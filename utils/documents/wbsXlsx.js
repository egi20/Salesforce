'use strict';

const ExcelJS = require('exceljs');

const { HEX, argb, formatDate, paletteFor } = require('./brand');
const { assertDocumentOpens } = require('./validate');
const { familyLabel, moduleLabel } = require('../../config/cloudFamilies');

/**
 * Work-breakdown workbook, rendered from a stored quote.
 *
 * Same rule as the SOW: every number comes from `quote.estimate`, which has already passed
 * reconciliation. Where a total appears it is an Excel SUM over the very cells above it, so
 * a reader who changes a cell sees the total move — and a reader who does not change
 * anything sees the same figure the document and the web page show.
 */

/** Built per document rather than module-level: two workbooks can generate at once. */
function headerFill(brand) {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(brand.navy) } };
}
const SUBHEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(HEX.wash) } };
const GANTT_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(HEX.cyan) } };
const THIN_BORDER = { style: 'thin', color: { argb: argb(HEX.rule) } };

function styleHeaderRow(row, brand) {
  row.eachCell((cellRef) => {
    cellRef.fill = headerFill(brand);
    cellRef.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cellRef.alignment = { vertical: 'middle', wrapText: true };
    cellRef.border = { bottom: THIN_BORDER };
  });
  row.height = 22;
}

function styleTotalRow(row) {
  row.eachCell((cellRef) => {
    cellRef.fill = SUBHEADER_FILL;
    cellRef.font = { bold: true };
    cellRef.border = { top: THIN_BORDER, bottom: THIN_BORDER };
  });
}

function addTitle(sheet, title, subtitle, brand) {
  sheet.mergeCells('A1:D1', brand);
  sheet.getCell('A1').value = title;
  sheet.getCell('A1').font = { bold: true, size: 16, color: { argb: argb(brand.navy) } };
  sheet.getCell('A2').value = subtitle;
  sheet.getCell('A2').font = { size: 10, color: { argb: argb(HEX.inkMuted) } };
  sheet.getRow(1).height = 24;
}

function summarySheet(workbook, quote, estimate, brand) {
  const sheet = workbook.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  sheet.columns = [{ width: 34 }, { width: 30 }, { width: 18 }, { width: 18 }];

  addTitle(sheet, quote.project_name, `${quote.client_company} · ${quote.reference} · ${formatDate(quote.created_at)}`, brand);

  sheet.addRow([]);
  const facts = [
    ['Client', quote.client_company],
    ['Contact', quote.client_name || '—'],
    ['Industry', quote.client_industry || 'Not specified'],
    ['Company size', quote.company_size || 'Not specified'],
    ['Estimate basis', `catalogue ${quote.catalogue_version}`],
    [],
    ['Total effort (man-days)', estimate.totalManDays],
    ['  of which base effort', estimate.baseEffort],
    [`  of which contingency (${estimate.contingencyPercentage}%)`, estimate.contingencyDays],
    ['Duration (weeks)', estimate.projectDurationWeeks],
    ['Blended day rate', estimate.averageDailyRate],
    [`Implementation (${estimate.currency})`, estimate.implementationBudget],
    [`Hypercare (${estimate.currency})`, estimate.supportBudget],
    [`Total (${estimate.currency})`, estimate.totalBudget]
  ];

  for (const fact of facts) {
    const row = sheet.addRow(fact);
    if (!fact.length) continue;
    row.getCell(1).font = { bold: String(fact[0]).startsWith(' ') === false };
    if (typeof fact[1] === 'number') row.getCell(2).numFmt = '#,##0';
  }

  sheet.getRow(sheet.rowCount).font = { bold: true, size: 12 };

  sheet.addRow([]);
  sheet.addRow(['These figures are the estimate as issued. This workbook does not recalculate them.']).font = {
    italic: true,
    size: 9,
    color: { argb: argb(HEX.inkMuted) }
  };

  return sheet;
}

/**
 * Phase breakdown with an inline Gantt.
 *
 * The week columns are filled from the SAME timeline the SOW prints, so the two cannot
 * disagree about when a phase runs.
 */
function wbsSheet(workbook, quote, estimate, brand) {
  const sheet = workbook.addWorksheet('WBS', { views: [{ state: 'frozen', xSplit: 1, ySplit: 4 }, ] });
  const totalWeeks = estimate.projectDurationWeeks;

  addTitle(sheet, 'Work breakdown', `${estimate.totalManDays} man-days over ${totalWeeks} weeks`, brand);
  sheet.addRow([]);

  const headers = ['Phase', 'Deliverable / milestone', 'Share', 'Days', 'Start wk', 'End wk'];
  const weekHeaders = Array.from({ length: totalWeeks }, (unused, i) => `W${i + 1}`);
  const headerRow = sheet.addRow([...headers, ...weekHeaders]);
  styleHeaderRow(headerRow, brand);

  sheet.getColumn(1).width = 26;
  sheet.getColumn(2).width = 34;
  sheet.getColumn(3).width = 8;
  sheet.getColumn(4).width = 8;
  sheet.getColumn(5).width = 9;
  sheet.getColumn(6).width = 9;
  for (let i = 0; i < totalWeeks; i += 1) sheet.getColumn(headers.length + 1 + i).width = 4;

  const firstDataRow = sheet.rowCount + 1;

  for (const phase of estimate.phaseBreakdown) {
    const slot = estimate.timeline.find((t) => t.phaseId === phase.id);
    const row = sheet.addRow([
      phase.name,
      slot ? slot.milestone : 'Not in scope',
      phase.percentage / 100,
      phase.days,
      slot ? slot.startWeek : null,
      slot ? slot.endWeek : null
    ]);

    row.getCell(3).numFmt = '0%';
    row.getCell(4).numFmt = '#,##0';
    if (phase.days === 0) {
      row.font = { color: { argb: argb(HEX.inkMuted) }, italic: true };
    }

    if (slot) {
      for (let week = slot.startWeek; week <= slot.endWeek; week += 1) {
        const cellRef = row.getCell(headers.length + week);
        cellRef.fill = GANTT_FILL;
        cellRef.border = { top: THIN_BORDER, bottom: THIN_BORDER };
      }
    }
  }

  const lastDataRow = sheet.rowCount;
  const totalRow = sheet.addRow([
    'Total',
    '',
    { formula: `SUM(C${firstDataRow}:C${lastDataRow})` },
    { formula: `SUM(D${firstDataRow}:D${lastDataRow})` },
    '',
    totalWeeks
  ]);
  totalRow.getCell(3).numFmt = '0%';
  totalRow.getCell(4).numFmt = '#,##0';
  styleTotalRow(totalRow);

  sheet.addRow([]);
  sheet.addRow([
    'Phases run sequentially: the calendar span is the sum of the phase durations, not the effort divided by the team.'
  ]).font = { italic: true, size: 9, color: { argb: argb(HEX.inkMuted) } };

  return sheet;
}

function scopeSheet(workbook, estimate, brand) {
  const sheet = workbook.addWorksheet('Scope');
  addTitle(sheet, 'Scope', 'Clouds, modules and add-ons priced in this estimate', brand);
  sheet.addRow([]);

  const headerRow = sheet.addRow(['Cloud', 'Module', 'Days', 'Basis']);
  styleHeaderRow(headerRow, brand);
  sheet.getColumn(1).width = 26;
  sheet.getColumn(2).width = 38;
  sheet.getColumn(3).width = 10;
  sheet.getColumn(4).width = 46;

  const firstRow = sheet.rowCount + 1;

  for (const family of estimate.familyBreakdown) {
    const modules = estimate.moduleBreakdown.filter((m) => m.family === family.id);

    if (modules.length === 0) {
      const row = sheet.addRow([familyLabel(family.id), 'Platform setup only', family.effectiveDays, 'Cloud foundation']);
      row.getCell(3).numFmt = '#,##0';
      continue;
    }

    modules.forEach((module, index) => {
      const row = sheet.addRow([
        index === 0 ? familyLabel(family.id) : '',
        moduleLabel(module.id),
        module.days,
        index === 0
          ? `Cloud charged at max(setup ${family.foundationDays}d, modules ${family.moduleDays}d) = ${family.effectiveDays}d`
          : ''
      ]);
      row.getCell(3).numFmt = '#,##0';
    });
  }

  for (const isv of estimate.isvBreakdown) {
    const row = sheet.addRow(['Add-on', isv.name, isv.days, isv.category]);
    row.getCell(3).numFmt = '#,##0';
  }

  if (estimate.multipliers.integrations.count > 0) {
    const { count, daysEach, complexity } = estimate.multipliers.integrations;
    const row = sheet.addRow(['Integrations', `${count} × ${complexity}`, count * daysEach, `${daysEach} days each`]);
    row.getCell(3).numFmt = '#,##0';
  }

  if (estimate.unmapped.days > 0) {
    const row = sheet.addRow([
      'Unmapped',
      'Described in free text',
      estimate.unmapped.days,
      'Allowance only — specify before sign-off'
    ]);
    row.getCell(3).numFmt = '#,##0';
    row.font = { italic: true };
  }

  const lastRow = sheet.rowCount;
  const totalRow = sheet.addRow(['', 'Scope before multipliers', { formula: `SUM(C${firstRow}:C${lastRow})` }, '']);
  totalRow.getCell(3).numFmt = '#,##0';
  styleTotalRow(totalRow);

  sheet.addRow([]);
  const multiplierHeader = sheet.addRow(['Multiplier', 'Applied', 'Factor', 'Note']);
  styleHeaderRow(multiplierHeader, brand);

  const m = estimate.multipliers;
  const multiplierRows = [
    ['Complexity', m.complexity.description, m.complexity.value],
    ['Customisation', m.customization.description, m.customization.value],
    ['Users', `${m.users.count} users`, m.users.value],
    ['Orgs', `${m.orgs.count} org(s)`, m.orgs.value],
    ['Industry', m.industry.name, m.industry.value],
    ['Company size', m.companySize.name, m.companySize.value]
  ];
  for (const row of multiplierRows) sheet.addRow(row).getCell(3).numFmt = '0.00';

  sheet.addRow(['Base effort', 'After multipliers and additions', estimate.baseEffort]).getCell(3).numFmt = '#,##0';
  sheet.addRow(['Contingency', `${estimate.contingencyPercentage}%`, estimate.contingencyDays]).getCell(3).numFmt = '#,##0';
  styleTotalRow(sheet.addRow(['Total effort', '', estimate.totalManDays]));
  sheet.getRow(sheet.rowCount).getCell(3).numFmt = '#,##0';

  return sheet;
}

function teamSheet(workbook, estimate, brand) {
  const sheet = workbook.addWorksheet('Team & cost');
  addTitle(sheet, 'Team and cost', `All figures in ${estimate.currency}`, brand);
  sheet.addRow([]);

  const headerRow = sheet.addRow(['Role', 'Share', 'Days', 'Day rate', 'Cost']);
  styleHeaderRow(headerRow, brand);
  sheet.getColumn(1).width = 34;
  sheet.getColumn(2).width = 10;
  sheet.getColumn(3).width = 10;
  sheet.getColumn(4).width = 12;
  sheet.getColumn(5).width = 16;

  const firstRow = sheet.rowCount + 1;

  for (const resource of estimate.resourceAllocation) {
    const row = sheet.addRow([resource.name, resource.percentage / 100, resource.days, resource.dailyRate, null]);
    // Cost is a live formula so the workbook is usable as a what-if model, and it
    // evaluates to exactly the cost the SOW prints.
    row.getCell(5).value = { formula: `C${row.number}*D${row.number}`, result: resource.totalCost };
    row.getCell(2).numFmt = '0%';
    row.getCell(3).numFmt = '#,##0';
    row.getCell(4).numFmt = '#,##0';
    row.getCell(5).numFmt = '#,##0';
  }

  const lastRow = sheet.rowCount;
  const totalRow = sheet.addRow([
    'Implementation',
    { formula: `SUM(B${firstRow}:B${lastRow})` },
    { formula: `SUM(C${firstRow}:C${lastRow})` },
    '',
    { formula: `SUM(E${firstRow}:E${lastRow})`, result: estimate.implementationBudget }
  ]);
  totalRow.getCell(2).numFmt = '0%';
  totalRow.getCell(3).numFmt = '#,##0';
  totalRow.getCell(5).numFmt = '#,##0';
  styleTotalRow(totalRow);

  if (estimate.supportBudget > 0) {
    const supportRow = sheet.addRow([
      `Hypercare (${estimate.options.supportDurationDays} days, reduced team)`,
      '',
      '',
      '',
      estimate.supportBudget
    ]);
    supportRow.getCell(5).numFmt = '#,##0';
  }

  const grandTotal = sheet.addRow(['Total', '', '', '', estimate.totalBudget]);
  grandTotal.getCell(5).numFmt = '#,##0';
  styleTotalRow(grandTotal);
  grandTotal.font = { bold: true, size: 12 };

  return sheet;
}

/**
 * @param {Object} quote stored row with `estimate` parsed
 * @returns {Promise<Buffer>} a validated XLSX
 */
async function generateWbsXlsx(quote, { preparedBy = '', branding = null } = {}) {
  // Resolved once per workbook. See the note in sowDocx: a module-level palette would be
  // a race between two documents generating at the same time.
  const brand = paletteFor(branding);
  const estimate = quote.estimate;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = preparedBy || 'Salesforce Hub';
  workbook.created = new Date(quote.created_at || Date.now());
  workbook.title = `Work breakdown — ${quote.project_name}`;

  summarySheet(workbook, quote, estimate, brand);
  wbsSheet(workbook, quote, estimate, brand);
  scopeSheet(workbook, estimate, brand);
  teamSheet(workbook, estimate, brand);

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  assertDocumentOpens(buffer, 'xlsx', 'work breakdown');

  return buffer;
}

module.exports = { generateWbsXlsx };
