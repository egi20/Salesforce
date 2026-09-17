'use strict';

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
  ShadingType,
  convertInchesToTwip
} = require('docx');

const { HEX, FONT, formatDate } = require('./brand');
const { assertDocumentOpens } = require('./validate');
const { invoiceLabel, reconciliationProblems } = require('../../config/finance');

/**
 * The invoice document.
 *
 * THIS IS GENERATED, NEVER FILLED FROM AN UPLOAD, and that is the whole difference from
 * the reference implementation. There, `POST /invoices/template` takes a .docx an
 * administrator uploads, writes it to disk, and later fills and serves it. Credit where it
 * is due — it checks that the file actually CONTAINS the placeholder tags first, which is
 * a genuinely good guard: without it a finished invoice with static numbers would be
 * accepted and its old numbers would pass straight through on every download. But the
 * shape is still one this codebase refuses everywhere else (see Company document
 * branding): durable bytes never live on the host disk, a .docx can carry macros and
 * remote template references, and serving a file we did not build breaks "open it before
 * anyone else has to" in the most complete way available.
 *
 * So the layout lives here, in code, under version control, where a change has an author
 * and a diff.
 *
 * TWO RULES, the same two every generator here follows:
 *
 * 1. RENDER, NEVER RECOMPUTE. Every figure comes from the stored invoice and its stored
 *    lines. `reconciliationProblems` is re-run first and THROWS on a mismatch, because a
 *    document whose total disagrees with its lines is the one artefact that must never
 *    leave the building.
 * 2. OPEN IT BEFORE ANYONE ELSE HAS TO. `assertDocumentOpens` unzips the package and
 *    strictly parses every XML part before it is returned.
 */

const CELL_BORDER = { style: BorderStyle.SINGLE, size: 2, color: HEX.rule };

function money(minor, currency) {
  const negative = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const whole = Math.floor(abs / 100).toLocaleString('en-GB');
  const cents = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${cents} ${currency}`;
}

/** Thousandths back to a readable quantity: 7500 -> "7.5", 1000 -> "1". */
function quantity(milli) {
  const value = milli / 1000;
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function percent(bps) {
  const value = bps / 100;
  return `${Number.isInteger(value) ? value : value.toFixed(2)}%`;
}

function line(text, { bold = false, size = 20, color = HEX.ink, align, spacing } = {}) {
  return new Paragraph({
    alignment: align,
    spacing,
    children: [new TextRun({ text: String(text ?? ''), bold, size, color, font: FONT })]
  });
}

function cell(children, { width, align, shaded = false, columnSpan } = {}) {
  return new TableCell({
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    columnSpan,
    shading: shaded ? { type: ShadingType.CLEAR, fill: HEX.wash } : undefined,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    borders: { top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER },
    children: Array.isArray(children) ? children : [children],
    ...(align ? {} : {})
  });
}

/**
 * The seller's own details.
 *
 * Passed in rather than read from config, because whoever is invoicing may not be the Hub
 * — and an invoice with the wrong legal entity on it is worse than no invoice.
 */
function sellerBlock(seller) {
  const rows = [line(seller.name || 'Your company', { bold: true, size: 24 })];
  for (const value of [seller.address, seller.taxId ? `VAT / Tax ID: ${seller.taxId}` : null, seller.email, seller.iban ? `IBAN: ${seller.iban}` : null]) {
    if (value) {
      for (const part of String(value).split('\n')) rows.push(line(part, { size: 18, color: HEX.inkMuted }));
    }
  }
  return rows;
}

async function generateInvoiceDocx(invoice, seller = {}) {
  /*
   * Checked BEFORE a single paragraph is built. `routes/quotes.js` does the same with an
   * estimate: this combination can only mean a bug, and the one place it must never reach
   * is a file somebody sends a customer.
   */
  const problems = reconciliationProblems({
    ...invoice,
    lines: (invoice.lines || []).map((l) => ({
      quantityMilli: l.quantity_milli,
      unitPriceMinor: l.unit_price_minor,
      vatBps: l.vat_bps
    }))
  });
  if (problems.length) {
    const err = new Error(`This invoice does not reconcile and was not produced: ${problems.join(' ')}`);
    err.code = 'INVOICE_DOES_NOT_RECONCILE';
    throw err;
  }

  if (!invoice.invoice_seq) {
    const err = new Error('A draft has no number yet. Issue it first.');
    err.code = 'NOT_ISSUED';
    throw err;
  }

  const currency = invoice.currency || 'EUR';
  const label = invoiceLabel(invoice.invoice_year, invoice.invoice_seq);

  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      cell(line('Description', { bold: true, size: 18 }), { width: 46, shaded: true }),
      cell(line('Qty', { bold: true, size: 18 }), { width: 10, shaded: true }),
      cell(line('Unit price', { bold: true, size: 18 }), { width: 16, shaded: true }),
      cell(line('VAT', { bold: true, size: 18 }), { width: 10, shaded: true }),
      cell(line('Net', { bold: true, size: 18 }), { width: 18, shaded: true })
    ]
  });

  const lineRows = invoice.lines.map(
    (l) =>
      new TableRow({
        children: [
          cell([line(l.description, { size: 18 }), ...(l.unit ? [line(l.unit, { size: 16, color: HEX.inkMuted })] : [])]),
          cell(line(quantity(l.quantity_milli), { size: 18 })),
          cell(line(money(l.unit_price_minor, currency), { size: 18 })),
          cell(line(percent(l.vat_bps), { size: 18 })),
          cell(line(money(l.net_minor, currency), { size: 18 }))
        ]
      })
  );

  const totalRow = (label_, value, bold = false) =>
    new TableRow({
      children: [
        cell(line(label_, { bold, size: 18, align: AlignmentType.RIGHT }), { columnSpan: 4, shaded: bold }),
        cell(line(value, { bold, size: 18 }), { shaded: bold })
      ]
    });

  const doc = new Document({
    creator: seller.name || 'Salesforce Hub',
    title: `Invoice ${label}`,
    description: `Invoice ${label} for ${invoice.bill_to_name || invoice.client_name || ''}`,
    styles: { default: { document: { run: { font: FONT, size: 20, color: HEX.ink } } } },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(0.8),
              bottom: convertInchesToTwip(0.8),
              left: convertInchesToTwip(0.8),
              right: convertInchesToTwip(0.8)
            }
          }
        },
        children: [
          line('INVOICE', { bold: true, size: 40, color: HEX.navy }),
          line(label, { bold: true, size: 28, color: HEX.blue, spacing: { after: 240 } }),

          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: {
              top: { style: BorderStyle.NONE },
              bottom: { style: BorderStyle.NONE },
              left: { style: BorderStyle.NONE },
              right: { style: BorderStyle.NONE },
              insideHorizontal: { style: BorderStyle.NONE },
              insideVertical: { style: BorderStyle.NONE }
            },
            rows: [
              new TableRow({
                children: [
                  new TableCell({
                    width: { size: 50, type: WidthType.PERCENTAGE },
                    borders: {
                      top: { style: BorderStyle.NONE },
                      bottom: { style: BorderStyle.NONE },
                      left: { style: BorderStyle.NONE },
                      right: { style: BorderStyle.NONE }
                    },
                    children: [line('From', { bold: true, size: 16, color: HEX.inkMuted }), ...sellerBlock(seller)]
                  }),
                  new TableCell({
                    width: { size: 50, type: WidthType.PERCENTAGE },
                    borders: {
                      top: { style: BorderStyle.NONE },
                      bottom: { style: BorderStyle.NONE },
                      left: { style: BorderStyle.NONE },
                      right: { style: BorderStyle.NONE }
                    },
                    children: [
                      line('Bill to', { bold: true, size: 16, color: HEX.inkMuted }),
                      /*
                       * The customer's details AS THEY WERE at issue, copied onto the
                       * invoice rather than joined from the client row. A customer moving
                       * office next year must not rewrite an invoice already sent and filed.
                       */
                      line(invoice.bill_to_name || invoice.client_name || '', { bold: true, size: 22 }),
                      ...String(invoice.bill_to_address || '')
                        .split('\n')
                        .filter(Boolean)
                        .map((part) => line(part, { size: 18, color: HEX.inkMuted })),
                      ...(invoice.bill_to_tax_id
                        ? [line(`VAT / Tax ID: ${invoice.bill_to_tax_id}`, { size: 18, color: HEX.inkMuted })]
                        : [])
                    ]
                  })
                ]
              })
            ]
          }),

          line('', { spacing: { after: 200 } }),
          line(`Issued  ${formatDate(invoice.issue_date)}`, { size: 18 }),
          ...(invoice.due_date ? [line(`Due  ${formatDate(invoice.due_date)}`, { size: 18 })] : []),
          ...(invoice.reference ? [line(`Reference  ${invoice.reference}`, { size: 18 })] : []),
          line('', { spacing: { after: 200 } }),

          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              headerRow,
              ...lineRows,
              totalRow('Net', money(invoice.net_minor, currency)),
              totalRow('VAT', money(invoice.vat_minor, currency)),
              totalRow('Total', money(invoice.gross_minor, currency), true)
            ]
          }),

          ...(invoice.notes
            ? [
                line('', { spacing: { after: 240 } }),
                line('Notes', { bold: true, size: 18, color: HEX.inkMuted }),
                ...String(invoice.notes).split('\n').filter(Boolean).map((part) => line(part, { size: 18 }))
              ]
            : []),

          ...(invoice.status === 'cancelled'
            ? [
                line('', { spacing: { after: 240 } }),
                line('CANCELLED', { bold: true, size: 24, color: HEX.warn }),
                line(invoice.cancel_reason || '', { size: 18, color: HEX.inkMuted })
              ]
            : [])
        ]
      }
    ]
  });

  const buffer = await Packer.toBuffer(doc);
  assertDocumentOpens(buffer, 'docx', 'invoice');
  return buffer;
}

/**
 * The download filename.
 *
 * `invoice-7-2026.docx` — the slash in the printed label is a path separator, and it lands
 * in a `Content-Disposition` header. Nothing else from the invoice goes in the name: a
 * customer's name in a filename is a customer's name in whatever log records the download.
 */
function filenameFor(invoice) {
  return `invoice-${invoice.invoice_seq}-${invoice.invoice_year}.docx`;
}

module.exports = { generateInvoiceDocx, filenameFor, money, quantity, percent };
