'use strict';

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  PageBreak,
  Header,
  Footer,
  PageNumber,
  ShadingType,
  convertInchesToTwip
} = require('docx');

const { HEX, FONT, formatNumber, formatMoney, formatDate, paletteFor, letterheadLines } = require('./brand');
const { assertDocumentOpens } = require('./validate');
const { familyLabel, moduleLabel } = require('../../config/cloudFamilies');

/**
 * Statement of work, rendered from a stored quote.
 *
 * THE RULE: this file renders `quote.estimate` and computes nothing of its own. Every
 * figure here was produced by `utils/sowEstimation.js` and has already passed
 * `reconciliationProblems()`. A formatter that re-derives a percentage or re-rounds a cost
 * is how a document ends up contradicting the web page it came from.
 *
 * Sums that appear as totals are summations of the very rows printed above them, so the
 * reader can add the column up and get the same answer.
 */

const CELL_MARGIN = { top: 80, bottom: 80, left: 120, right: 120 };

function text(value, options = {}) {
  return new TextRun({ text: String(value ?? ''), font: FONT, ...options });
}

function para(value, options = {}) {
  const { spacing, alignment, ...runOptions } = options;
  return new Paragraph({
    alignment,
    spacing: spacing || { after: 120 },
    children: [text(value, runOptions)]
  });
}

/**
 * @param {object} brand a palette from `paletteFor()`. Defaults to the Hub's own, so a
 *   company with no template renders exactly as before.
 */
function heading(value, level = HeadingLevel.HEADING_1, brand = HEX) {
  return new Paragraph({
    heading: level,
    spacing: { before: 320, after: 160 },
    children: [text(value, { bold: true, color: brand.navy, size: level === HeadingLevel.HEADING_1 ? 30 : 24 })]
  });
}

function cell(value, { bold = false, align = AlignmentType.LEFT, shade = null, color = HEX.ink, width = null } = {}) {
  return new TableCell({
    margins: CELL_MARGIN,
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    shading: shade ? { type: ShadingType.CLEAR, fill: shade } : undefined,
    children: [
      new Paragraph({
        alignment: align,
        spacing: { after: 0 },
        children: [text(value, { bold, color, size: 20 })]
      })
    ]
  });
}

function table(headers, rows, { widths = null, footer = null, brand = HEX } = {}) {
  const borders = {
    top: { style: BorderStyle.SINGLE, size: 2, color: HEX.rule },
    bottom: { style: BorderStyle.SINGLE, size: 2, color: HEX.rule },
    left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: HEX.rule },
    insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }
  };

  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h, i) =>
      cell(h.label, {
        bold: true,
        color: 'FFFFFF',
        shade: brand.navy,
        align: h.align || AlignmentType.LEFT,
        width: widths ? widths[i] : null
      })
    )
  });

  const bodyRows = rows.map(
    (row) =>
      new TableRow({
        children: row.map((value, i) =>
          cell(value, { align: headers[i].align || AlignmentType.LEFT, width: widths ? widths[i] : null })
        )
      })
  );

  const footerRows = footer
    ? [
        new TableRow({
          children: footer.map((value, i) =>
            cell(value, {
              bold: true,
              shade: HEX.wash,
              align: headers[i].align || AlignmentType.LEFT,
              width: widths ? widths[i] : null
            })
          )
        })
      ]
    : [];

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders,
    rows: [headerRow, ...bodyRows, ...footerRows]
  });
}

const RIGHT = AlignmentType.RIGHT;

/** Cover block. Deliberately plain: a cover that overstates is the first thing a client discounts. */
function coverSection(quote, estimate, brand, branding) {
  /*
   * The letterhead sits ABOVE the title, where a reader looks for who sent a document.
   * Every line is plain text the company typed; nothing here is markup, and nothing is
   * derived from anywhere a client could influence.
   */
  const letterhead = letterheadLines(branding);

  return [
    ...(letterhead.length
      ? [
          new Paragraph({
            spacing: { before: 400, after: 0 },
            children: [text(letterhead[0], { bold: true, size: 22, color: brand.navy })]
          }),
          ...letterhead.slice(1).map((line) =>
            new Paragraph({ spacing: { after: 0 }, children: [text(line, { size: 18, color: HEX.inkMuted })] })
          )
        ]
      : []),

    new Paragraph({ spacing: { before: letterhead.length ? 700 : 1200, after: 0 }, children: [text('Statement of Work', { bold: true, size: 56, color: brand.navy })] }),
    new Paragraph({ spacing: { after: 480 }, children: [text(quote.project_name, { size: 32, color: brand.blue })] }),

    table(
      [{ label: 'Prepared for' }, { label: '' }],
      [
        ['Client', quote.client_company],
        ['Contact', quote.client_name || '—'],
        ['Reference', quote.reference],
        ['Date', formatDate(quote.created_at)],
        ['Estimate basis', `catalogue ${quote.catalogue_version}`]
      ],
      { widths: [30, 70], brand }
    ),

    new Paragraph({ spacing: { before: 480 }, children: [text('Summary', { bold: true, size: 24, color: brand.navy })] }),
    table(
      [{ label: 'Measure' }, { label: 'Value', align: RIGHT }],
      [
        ['Total effort', `${formatNumber(estimate.totalManDays)} man-days`],
        ['Indicative duration', `${estimate.projectDurationWeeks} weeks (about ${estimate.projectDurationMonths} months)`],
        ['Implementation', formatMoney(estimate.implementationBudget, estimate.currency)],
        ...(estimate.supportBudget > 0
          ? [[`Hypercare (${estimate.options.supportDurationDays} days)`, formatMoney(estimate.supportBudget, estimate.currency)]]
          : []),
        ['Blended day rate', formatMoney(estimate.averageDailyRate, estimate.currency)]
      ],
      { widths: [55, 45], brand, footer: ['Total', formatMoney(estimate.totalBudget, estimate.currency)] }
    ),

    new Paragraph({ children: [new PageBreak()] })
  ];
}

/**
 * An accepted narrative section, rendered where one exists.
 *
 * `quote.narrative` is populated by `services/quotePackage.js` from the drafts the AUTHOR
 * accepted — never from a model response directly. If nothing was accepted, the section is
 * simply absent: the document has always read correctly without it, and an empty heading
 * would be worse than no heading.
 *
 * The text is rendered as PLAIN paragraphs. No markdown interpretation, no rich text: what
 * the author accepted is what appears, character for character.
 */
function narrativeSection(quote, sectionKey, headingText, brand) {
  const narrative = (quote.narrative || {})[sectionKey];
  const body = narrative && String(narrative.body || '').trim();
  if (!body) return [];

  return [
    heading(headingText, HeadingLevel.HEADING_2, brand),
    ...body
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean)
      .map((block) => para(block, { size: 22 }))
  ];
}

function scopeSection(quote, estimate, brand) {
  const children = [heading('1. Scope', HeadingLevel.HEADING_1, brand)];

  if (quote.project_summary) {
    children.push(para(String(quote.project_summary).replace(/<[^>]*>/g, '').trim(), { size: 22 }));
  }

  children.push(para('The following clouds and modules are in scope.', { size: 22, color: HEX.inkMuted }));

  children.push(
    table(
      [{ label: 'Cloud' }, { label: 'Modules in scope' }, { label: 'Effort', align: RIGHT }],
      estimate.familyBreakdown.map((family) => {
        const modules = estimate.moduleBreakdown
          .filter((m) => m.family === family.id)
          .map((m) => moduleLabel(m.id));
        return [
          familyLabel(family.id),
          modules.length ? modules.join(', ') : 'Platform setup only',
          `${formatNumber(family.effectiveDays)} d`
        ];
      }),
      { widths: [25, 55, 20], brand }
    )
  );

  children.push(
    para(
      'Where modules are listed, the effort shown is the greater of the platform setup for that ' +
        'cloud and the sum of its modules — never both.',
      { size: 18, color: HEX.inkMuted }
    )
  );

  if (estimate.isvBreakdown.length) {
    children.push(heading('1.1 Add-on products', HeadingLevel.HEADING_2, brand));
    children.push(
      table(
        [{ label: 'Product' }, { label: 'Category' }, { label: 'Effort', align: RIGHT }],
        estimate.isvBreakdown.map((isv) => [isv.name, isv.category, `${formatNumber(isv.days)} d`]),
        { widths: [55, 25, 20], brand }
      )
    );
  }

  if (estimate.multipliers.integrations.count > 0) {
    children.push(heading('1.2 Integrations', HeadingLevel.HEADING_2, brand));
    children.push(
      para(
        `${estimate.multipliers.integrations.count} integration(s) at ${estimate.multipliers.integrations.complexity} ` +
          `complexity, allowed ${estimate.multipliers.integrations.daysEach} days each.`,
        { size: 22 }
      )
    );
  }

  if (estimate.unmapped.days > 0) {
    children.push(heading('1.3 Scope described in free text', HeadingLevel.HEADING_2, brand));
    children.push(
      para(
        `${estimate.unmapped.modules + estimate.unmapped.isvs + estimate.unmapped.integrations} item(s) were ` +
          `described but not matched to a catalogue entry. They carry an allowance of ` +
          `${formatNumber(estimate.unmapped.days)} days in this estimate and should be specified before sign-off.`,
        { size: 22 }
      )
    );
  }

  return children;
}

function approachSection(estimate, brand) {
  const phases = estimate.phaseBreakdown.filter((p) => p.days > 0);

  return [
    heading('2. Approach', HeadingLevel.HEADING_1, brand),
    para('Delivery runs in the phases below. Phases are largely sequential; the team works in parallel within each.', {
      size: 22,
      color: HEX.inkMuted
    }),
    table(
      [{ label: 'Phase' }, { label: 'What happens' }, { label: 'Share', align: RIGHT }, { label: 'Days', align: RIGHT }],
      phases.map((p) => [p.name, p.description, `${p.percentage}%`, formatNumber(p.days)]),
      {
        widths: [22, 53, 10, 15],
        brand,
        footer: ['Total', '', '100%', formatNumber(phases.reduce((sum, p) => sum + p.days, 0))]
      }
    ),

    heading('2.1 Timeline', HeadingLevel.HEADING_2, brand),
    table(
      [{ label: 'Phase' }, { label: 'Weeks', align: RIGHT }, { label: 'Duration', align: RIGHT }, { label: 'Milestone' }],
      estimate.timeline.map((t) => [t.phase, `${t.startWeek}–${t.endWeek}`, `${t.durationWeeks} wk`, t.milestone]),
      {
        widths: [30, 15, 15, 40],
        brand,
        footer: ['Total', '', `${estimate.projectDurationWeeks} wk`, '']
      }
    )
  ];
}

function commercialsSection(estimate, brand) {
  const rows = estimate.resourceAllocation.map((r) => [
    r.name,
    `${r.percentage}%`,
    formatNumber(r.days),
    formatNumber(r.dailyRate),
    formatNumber(r.totalCost)
  ]);

  const children = [
    heading('3. Team and commercials', HeadingLevel.HEADING_1, brand),
    table(
      [
        { label: 'Role' },
        { label: 'Share', align: RIGHT },
        { label: 'Days', align: RIGHT },
        { label: `Day rate (${estimate.currency})`, align: RIGHT },
        { label: `Cost (${estimate.currency})`, align: RIGHT }
      ],
      rows,
      {
        widths: [34, 12, 12, 20, 22],
        brand,
        footer: [
          'Implementation',
          '100%',
          formatNumber(estimate.resourceAllocation.reduce((s, r) => s + r.days, 0)),
          '',
          formatNumber(estimate.implementationBudget)
        ]
      }
    ),
    para('Each cost is the role’s days multiplied by its day rate, so the column adds up to the total exactly.', {
      size: 18,
      color: HEX.inkMuted
    })
  ];

  if (estimate.supportBudget > 0) {
    children.push(
      para(
        `Hypercare of ${estimate.options.supportDurationDays} calendar days after go-live is quoted separately at ` +
          `${formatMoney(estimate.supportBudget, estimate.currency)}, assuming a reduced team of two.`,
        { size: 22 }
      )
    );
  }

  children.push(
    heading('3.1 How the effort was derived', HeadingLevel.HEADING_2, brand),
    table(
      [{ label: 'Factor' }, { label: 'Applied' }],
      [
        ['Base effort from scope', `${formatNumber(estimate.baseEffort)} days`],
        ['Complexity', `×${estimate.multipliers.complexity.value} — ${estimate.multipliers.complexity.description}`],
        ['Customisation', `×${estimate.multipliers.customization.value} — ${estimate.multipliers.customization.description}`],
        ['User population', `×${estimate.multipliers.users.value} (${formatNumber(estimate.multipliers.users.count)} users)`],
        ['Salesforce orgs', `×${estimate.multipliers.orgs.value} (${estimate.multipliers.orgs.count})`],
        ['Industry', `×${estimate.multipliers.industry.value} — ${estimate.multipliers.industry.name}`],
        ['Company size', `×${estimate.multipliers.companySize.value} — ${estimate.multipliers.companySize.name}`],
        ['Contingency', `${estimate.contingencyPercentage}% — ${formatNumber(estimate.contingencyDays)} days`]
      ],
      { widths: [30, 70], brand, footer: ['Total effort', `${formatNumber(estimate.totalManDays)} days`] }
    )
  );

  return children;
}

/**
 * Assumptions and exclusions.
 *
 * Stated plainly and always present. An estimate without them reads as a fixed price, and
 * the first change request then becomes an argument about what was promised.
 */
function assumptionsSection(estimate, brand, branding) {
  const assumptions = [
    'Figures are an estimate based on the scope stated in section 1, not a fixed price.',
    `A contingency of ${estimate.contingencyPercentage}% is included and is intended to absorb normal discovery findings, not scope additions.`,
    'The client provides timely access to stakeholders, source systems and test data.',
    'One production org and its standard sandbox chain are available for the duration.',
    'Data supplied for migration is in a readable, documented format with an agreed unique key per object.',
    'User acceptance testing is carried out by the client within the window in the timeline.',
    'Effort is quoted in man-days at the day rates in section 3, exclusive of VAT, travel and expenses.'
  ];

  const exclusions = [
    'Salesforce licence and AppExchange subscription costs.',
    'Third-party software, infrastructure and connectivity outside the Salesforce platform.',
    'Cleansing of source data prior to migration.',
    'Work on systems other than those named as integration endpoints.',
    'Ongoing managed service beyond the hypercare window, where one is quoted.'
  ];

  const bullets = (items) =>
    items.map(
      (item) =>
        new Paragraph({
          bullet: { level: 0 },
          spacing: { after: 80 },
          indent: { left: convertInchesToTwip(0.25) },
          children: [text(item, { size: 22 })]
        })
    );

  /*
   * The company's own clauses are APPENDED to the Hub's, never substituted for them.
   * The standard assumptions are what make the estimate mean anything — a company that
   * could replace them could ship a figure with its basis quietly removed.
   */
  const clauses = (branding && branding.clauses) || {};
  const companyAssumptions = (clauses.assumption || []).map((c) => c.body);
  const companyExclusions = (clauses.exclusion || []).map((c) => c.body);
  const companyTerms = (clauses.term || []).map((c) => c.body);

  return [
    heading('4. Assumptions', HeadingLevel.HEADING_1, brand),
    ...bullets([...assumptions, ...companyAssumptions]),
    heading('5. Exclusions', HeadingLevel.HEADING_1, brand),
    ...bullets([...exclusions, ...companyExclusions]),
    ...(companyTerms.length
      ? [heading('6. Terms', HeadingLevel.HEADING_1, brand), ...bullets(companyTerms)]
      : []),
    heading(companyTerms.length ? '7. Validity' : '6. Validity', HeadingLevel.HEADING_1, brand),
    para(
      'This estimate is valid for 30 days from the date on the cover. It was produced from ' +
        `catalogue ${estimate.catalogueVersion || 'as recorded on the cover'}; rates and effort baselines are reviewed periodically.`,
      { size: 22 }
    )
  ];
}

/**
 * Build the SOW.
 *
 * @param {Object} quote the stored row, with `estimate` already parsed
 * @param {Object} options `{ preparedBy }`
 * @returns {Promise<Buffer>} a validated DOCX
 */
async function generateSowDocx(quote, { preparedBy = '', branding = null } = {}) {
  const estimate = quote.estimate;

  /*
   * Resolved ONCE, here, and passed down. A module-level mutable palette would be a race
   * between two documents generating at the same time — there are await points inside
   * this function, so "the current company's colours" is not a thing a module can hold.
   *
   * `paletteFor` accepts only the two accent keys and ignores everything else, so a
   * malformed or over-reaching branding row cannot change body text or rules.
   */
  const brand = paletteFor(branding);

  const doc = new Document({
    creator: preparedBy || 'Salesforce Hub',
    title: `Statement of Work — ${quote.project_name}`,
    description: `Prepared for ${quote.client_company}`,
    styles: {
      default: {
        document: { run: { font: FONT, size: 22, color: HEX.ink } }
      }
    },
    sections: [
      {
        properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  text(
                    [(branding && branding.letterhead && branding.letterhead.footer_note) || null,
                      `${quote.client_company} · ${quote.reference}`]
                      .filter(Boolean)
                      .join('  ·  '),
                    { size: 16, color: HEX.inkMuted }
                  )
                ]
              })
            ]
          })
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  text('Page ', { size: 16, color: HEX.inkMuted }),
                  new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: HEX.inkMuted }),
                  text(' of ', { size: 16, color: HEX.inkMuted }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONT, size: 16, color: HEX.inkMuted })
                ]
              })
            ]
          })
        },
        children: [
          ...coverSection(quote, estimate, brand, branding),
          // The summary sits before the scope tables, where an executive reads it first.
          ...narrativeSection(quote, 'executive_summary', 'Executive summary', brand),
          ...scopeSection(quote, estimate, brand),
          ...approachSection(estimate, brand),
          // Narrative goes AFTER the figures it describes, never before: the tables are
          // the statement, the prose is the explanation of it.
          ...narrativeSection(quote, 'approach', 'How we will run it', brand),
          ...commercialsSection(estimate, brand),
          ...assumptionsSection({ ...estimate, catalogueVersion: quote.catalogue_version }, brand, branding),
          ...narrativeSection(quote, 'assumptions', 'Assumptions specific to this engagement', brand),
          ...narrativeSection(quote, 'risks', 'What could move this estimate', brand)
        ]
      }
    ]
  });

  const buffer = await Packer.toBuffer(doc);

  // Open it before anyone else has to. A corrupt document reaching a client is the one
  // failure this whole feature cannot recover from.
  assertDocumentOpens(buffer, 'docx', 'statement of work');

  return buffer;
}

module.exports = { generateSowDocx };
