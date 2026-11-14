/**
 * Tiny JSON-file store. Node runs request handlers on a single thread and every
 * mutation below is synchronous, so number allocation can never be duplicated.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_DB = {
  settings: {
    complexe: '',
    numeroFormat: '{n}',
    classementFormat: '{n}',
    referenceFormat: '{code}-{n}',
    padding: 3,
    nextNumero: 1,
    nextClassement: 1,
    logo: null, // { file, mime, width, height }
  },
  classes: [{ id: 'gen', code: 'GEN', label: 'Général', next: 1 }],
  persons: [],
  vus: [
    { id: 'v1', text: 'Vu la note …' },
    { id: 'v2', text: 'Vu la décision …' },
    { id: 'v3', text: 'Vu la loi …' },
    { id: 'v4', text: 'Vu les orientations …' },
  ],
  designations: ['Président', 'Membre', 'Secrétaire', 'Rapporteur'],
  decisions: [],
};

let db = null;

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db = { ...structuredClone(DEFAULT_DB), ...saved, settings: { ...DEFAULT_DB.settings, ...saved.settings } };
  } else {
    db = structuredClone(DEFAULT_DB);
    save();
  }
  return db;
}

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

const get = () => db || load();
const newId = () => crypto.randomUUID();

/** "{code}-{n}" + n=7, padding=3 -> "GEN-007". Tokens: {n} {yyyy} {yy} {code} */
function formatNumber(format, n, padding, extra = {}) {
  const now = new Date();
  return String(format || '{n}')
    .replace(/\{n\}/g, String(n).padStart(Number(padding) || 0, '0'))
    .replace(/\{yyyy\}/g, String(now.getFullYear()))
    .replace(/\{yy\}/g, String(now.getFullYear()).slice(-2))
    .replace(/\{code\}/g, extra.code || '');
}

function previewNumbers(classId) {
  const { settings, classes } = get();
  const cls = classes.find((c) => c.id === classId);
  return {
    numero: formatNumber(settings.numeroFormat, settings.nextNumero, settings.padding),
    classement: formatNumber(settings.classementFormat, settings.nextClassement, settings.padding),
    reference: cls ? formatNumber(settings.referenceFormat, cls.next, settings.padding, { code: cls.code }) : '',
  };
}

function allocateReference(classId) {
  const { settings, classes } = get();
  const cls = classes.find((c) => c.id === classId);
  if (!cls) return '';
  const ref = formatNumber(settings.referenceFormat, cls.next, settings.padding, { code: cls.code });
  cls.next += 1;
  return ref;
}

/** Assigns N°, classement and référence, then advances the counters. */
function allocateNumbers(classId) {
  const s = get().settings;
  const out = {
    numero: formatNumber(s.numeroFormat, s.nextNumero, s.padding),
    classement: formatNumber(s.classementFormat, s.nextClassement, s.padding),
    reference: allocateReference(classId),
  };
  s.nextNumero += 1;
  s.nextClassement += 1;
  return out;
}

module.exports = { load, save, get, newId, previewNumbers, allocateNumbers, allocateReference, DATA_DIR };
