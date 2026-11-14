#!/usr/bin/env node
/**
 * Builds templates/decision-template.docx from the original Word mock-up
 * (templates/source/DECISION-maquette.docx).
 *
 * It keeps the original page setup, styles, header table and footer, and replaces
 * the explanatory placeholder text with docxtemplater tags:
 *
 *   Header : {logo} {numero} {objet} {classement} {reference}  + "Page X / Y"
 *   Body   : {complexe}, loop {#vus}{text}{/vus},
 *            loop {#articles} Article {num} : {first}  {#rest}{.}{/rest} (one paragraph per line)
 *                  {#hasMembers} table rows {#members}{nom} | {fonction} | {designation}{/members} {/hasMembers}
 *            {/articles}
 *
 * Run once with `npm run build:template`. The generated template can afterwards be
 * edited by hand in Word (fonts, footer, spacing…) as long as the tags are kept.
 */
const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'templates/source/DECISION-maquette.docx');
const OUT = path.join(ROOT, 'templates/decision-template.docx');

const zip = new PizZip(fs.readFileSync(SRC));

function mustReplace(xml, search, replacement, label) {
  if (typeof search === 'string' ? !xml.includes(search) : !search.test(xml)) {
    throw new Error(`Template build: pattern not found (${label})`);
  }
  return xml.replace(search, replacement);
}

/* ------------------------------------------------------------------ header */
let hdr = zip.file('word/header1.xml').asText();

// 1. Logo cell: drop the empty spacer paragraphs and keep a single centred {logo} paragraph.
{
  const start = hdr.indexOf('<w:tc>');
  const end = hdr.indexOf('</w:tc>', start) + '</w:tc>'.length;
  const cell = hdr.slice(start, end);
  const tcPr = cell.match(/<w:tcPr>.*?<\/w:tcPr>/)[0].replace('</w:tcPr>', '<w:vAlign w:val="center"/></w:tcPr>');
  const newCell =
    '<w:tc>' + tcPr +
    '<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>' +
    '<w:r><w:rPr><w:noProof/></w:rPr><w:t>{logo}</w:t></w:r></w:p></w:tc>';
  hdr = hdr.slice(0, start) + newCell + hdr.slice(end);
}

// 2. Decision number
hdr = mustReplace(hdr, '<w:t>DECISION N° 000</w:t>', '<w:t>DECISION N° {numero}</w:t>', 'numero');
hdr = mustReplace(hdr, /<w:r [^>]*><w:rPr>(?:(?!<\/w:r>).)*?<w:t xml:space="preserve"> \(increment from a certain number automatically\)<\/w:t><\/w:r>/, '', 'numero hint');

// 3. Objet
hdr = mustReplace(hdr, /<w:t xml:space="preserve">OBJET(\s|\u00a0)*:(\s|\u00a0)*objet\s*<\/w:t>/, '<w:t xml:space="preserve">OBJET\u00a0: {objet}</w:t>', 'objet');

// 4. Classement
hdr = mustReplace(hdr, '<w:t>increment automatically</w:t>', '<w:t>{classement}</w:t>', 'classement');

// 5. Référence
hdr = mustReplace(hdr, '<w:t>increment</w:t>', '<w:t xml:space="preserve"> {reference}</w:t>', 'reference');
hdr = mustReplace(hdr, /<w:r [^>]*><w:rPr>(?:(?!<\/w:r>).)*?<w:t xml:space="preserve"> automatically relied to specific classes<\/w:t><\/w:r>/, '', 'reference hint');

// Justified alignment spreads short values oddly in the narrow right column.
hdr = hdr.replace(/<w:jc w:val="both"\/>/g, '<w:jc w:val="left"/>');

// 6. "Page : X /" -> "Page : X / Y"
{
  const rPr = '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="24"/></w:rPr>';
  const numPages =
    `<w:r>${rPr}<w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r>${rPr}<w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r>` +
    `<w:r>${rPr}<w:fldChar w:fldCharType="separate"/></w:r>` +
    `<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:noProof/><w:sz w:val="24"/></w:rPr><w:t>1</w:t></w:r>` +
    `<w:r>${rPr}<w:fldChar w:fldCharType="end"/></w:r>`;
  hdr = mustReplace(hdr, '<w:t xml:space="preserve"> / </w:t></w:r>', '<w:t xml:space="preserve"> / </w:t></w:r>' + numPages, 'numpages');
}
zip.file('word/header1.xml', hdr);

/* -------------------------------------------------------------------- body */
let doc = zip.file('word/document.xml').asText();
const bodyStart = doc.indexOf('<w:body>') + '<w:body>'.length;
const sectStart = doc.indexOf('<w:sectPr');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const run = (text, rPr = '') =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const p = (runs, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs}</w:p>`;
const tagP = (tag) => p(run(tag));
const JUSTIFY = '<w:jc w:val="both"/>';

// Committee members: borderless 3-column table, indented like the mock-up.
const TBL_IND = 709;
const COLS = [3300, 3600, 2029]; // sums to 8929 = 9638 (text width) - indent
const cellP = (runs) => p(runs, '<w:spacing w:after="60" w:line="240" w:lineRule="auto"/>');
const cell = (w, runs) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>${cellP(runs)}</w:tc>`;
const membersTable =
  '<w:tbl><w:tblPr>' +
  `<w:tblW w:w="${COLS.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblInd w:w="${TBL_IND}" w:type="dxa"/>` +
  '<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>' +
  '<w:tblLayout w:type="fixed"/><w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/>' +
  '</w:tblPr><w:tblGrid>' + COLS.map((w) => `<w:gridCol w:w="${w}"/>`).join('') + '</w:tblGrid>' +
  '<w:tr>' +
  cell(COLS[0], run('{#members}') + run('{nom}', '<w:b/>')) +
  cell(COLS[1], run('{fonction}')) +
  cell(COLS[2], run('{designation}{/members}', '<w:i/>')) +
  '</w:tr></w:tbl>';

const body = [
  p(run('Le Directeur du Complexe, {complexe}')),
  tagP('{#vus}'),
  p(run('{text}'), '<w:pStyle w:val="Paragraphedeliste"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="36"/></w:numPr>' + JUSTIFY),
  tagP('{/vus}'),
  p(''),
  p(run('DECIDE', '<w:b/><w:sz w:val="32"/><w:szCs w:val="32"/>'), '<w:spacing w:before="240" w:after="360"/><w:jc w:val="center"/>'),
  tagP('{#articles}'),
  p(run('Article {num} :', '<w:b/><w:u w:val="single"/>') + run(' {first}'), JUSTIFY),
  tagP('{#rest}'),
  p(run('{.}'), JUSTIFY),
  tagP('{/rest}'),
  tagP('{#hasMembers}'),
  membersTable,
  p('', '<w:spacing w:after="120" w:line="240" w:lineRule="auto"/><w:rPr><w:sz w:val="8"/></w:rPr>'),
  tagP('{/hasMembers}'),
  tagP('{/articles}'),
  p(''),
  p(run('Le Directeur du Complexe, {complexe}', '<w:b/>'), '<w:spacing w:before="240"/><w:ind w:left="5103"/><w:jc w:val="center"/>'),
].join('');

doc = doc.slice(0, bodyStart) + body + doc.slice(sectStart);
zip.file('word/document.xml', doc);

fs.writeFileSync(OUT, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log('Template written to', path.relative(ROOT, OUT));
