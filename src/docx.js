const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

const TEMPLATE = path.join(__dirname, '..', 'templates', 'decision-template.docx');
const LOGO_MARKER = '@@LOGO@@';
const EMU_PER_INCH = 914400;
// Room available in the header's logo cell (1701 dxa wide, ~2255 dxa tall).
const LOGO_MAX_W_IN = 1.0;
const LOGO_MAX_H_IN = 1.35;

/** Data passed to the template for a stored decision. */
function templateData(decision, hasLogo) {
  return {
    logo: hasLogo ? LOGO_MARKER : '',
    numero: decision.numero || '',
    objet: decision.objet || '',
    classement: decision.classement || '',
    reference: decision.reference || '',
    complexe: decision.complexe || '',
    vus: (decision.vus || []).filter((v) => v && v.trim()).map((text) => ({ text: text.trim() })),
    articles: (decision.articles || []).map((a, i) => {
      const members = (a.members || []).filter((m) => m && (m.nom || m.fonction || m.designation));
      const lines = String(a.text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      return {
        num: i + 1,
        first: lines[0] || '',
        rest: lines.slice(1),
        hasMembers: a.type === 'comite' && members.length > 0,
        members: members.map((m) => ({ nom: m.nom || '', fonction: m.fonction || '', designation: m.designation || '' })),
      };
    }),
  };
}

function addContentTypeDefault(zip, ext, mime) {
  const ct = zip.file('[Content_Types].xml').asText();
  if (new RegExp(`<Default Extension="${ext}"`, 'i').test(ct)) return;
  zip.file('[Content_Types].xml', ct.replace(/(<Types[^>]*>)/, `$1<Default Extension="${ext}" ContentType="${mime}"/>`));
}

/** Replace the run holding LOGO_MARKER (in any header) with an inline picture. */
function injectLogo(zip, logo) {
  const ext = logo.mime === 'image/png' ? 'png' : 'jpeg';
  const media = `word/media/logo_decision.${ext}`;
  zip.file(media, logo.buffer);
  addContentTypeDefault(zip, ext, logo.mime);

  const ratio = Math.min(LOGO_MAX_W_IN / (logo.width / 96), LOGO_MAX_H_IN / (logo.height / 96));
  const wIn = (logo.width / 96) * ratio;
  const hIn = (logo.height / 96) * ratio;
  const cx = Math.round(wIn * EMU_PER_INCH);
  const cy = Math.round(hIn * EMU_PER_INCH);

  for (const name of Object.keys(zip.files)) {
    if (!/^word\/header\d*\.xml$/.test(name)) continue;
    let xml = zip.file(name).asText();
    if (!xml.includes(LOGO_MARKER)) continue;

    const relsName = name.replace('word/', 'word/_rels/') + '.rels';
    let rels = zip.file(relsName)
      ? zip.file(relsName).asText()
      : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    const rId = 'rIdDecisionLogo';
    if (!rels.includes(`Id="${rId}"`)) {
      rels = rels.replace(
        '</Relationships>',
        `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo_decision.${ext}"/></Relationships>`
      );
      zip.file(relsName, rels);
    }

    const drawing =
      '<w:r><w:rPr><w:noProof/></w:rPr><w:drawing>' +
      `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
      '<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="9001" name="Logo"/>' +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      `<pic:nvPicPr><pic:cNvPr id="0" name="logo.${ext}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';

    // The marker sits alone in a <w:t> of its run after rendering.
    xml = xml.replace(/<w:r>(?:(?!<w:r>|<\/w:r>).)*?@@LOGO@@(?:(?!<\/w:r>).)*?<\/w:r>/s, drawing);
    xml = xml.replace(/<w:r [^>]*>(?:(?!<w:r[ >]|<\/w:r>).)*?@@LOGO@@(?:(?!<\/w:r>).)*?<\/w:r>/s, drawing);
    zip.file(name, xml);
  }
}

/**
 * @param {object} decision stored decision
 * @param {{buffer:Buffer, mime:string, width:number, height:number}|null} logo
 * @returns {Buffer} .docx file
 */
function renderDecision(decision, logo) {
  const zip = new PizZip(fs.readFileSync(TEMPLATE));
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    nullGetter: () => '',
  });
  doc.render(templateData(decision, !!logo));
  const out = doc.getZip();
  if (logo) injectLogo(out, logo);
  return out.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { renderDecision };
