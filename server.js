const express = require('express');
const fs = require('fs');
const path = require('path');
const store = require('./src/store');
const { renderDecision } = require('./src/docx');

const PORT = process.env.PORT || 3000;
const app = express();
store.load();

/* Optional protection: set APP_PASSWORD to require a password (any user name). */
if (process.env.APP_PASSWORD) {
  app.use((req, res, next) => {
    const [type, value] = (req.headers.authorization || '').split(' ');
    const pass = type === 'Basic' && value ? Buffer.from(value, 'base64').toString().split(':').slice(1).join(':') : null;
    if (pass === process.env.APP_PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="Decisions"').status(401).send('Authentification requise');
  });
}

app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const str = (v, max = 5000) => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v, def) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : def);
const notFound = (res) => res.status(404).json({ error: 'Introuvable' });

/* ---------------------------------------------------------------- state */
app.get('/api/state', (req, res) => {
  const db = store.get();
  res.json({
    settings: { ...db.settings, logo: db.settings.logo ? { width: db.settings.logo.width, height: db.settings.logo.height, v: db.settings.logo.v } : null },
    classes: db.classes,
    persons: db.persons,
    vus: db.vus,
    designations: db.designations,
  });
});

app.get('/api/next-numbers', (req, res) => res.json(store.previewNumbers(req.query.classId)));

app.put('/api/settings', (req, res) => {
  const s = store.get().settings;
  const b = req.body || {};
  if ('complexe' in b) s.complexe = str(b.complexe, 300);
  for (const k of ['numeroFormat', 'classementFormat', 'referenceFormat']) if (k in b) s[k] = str(b[k], 100) || '{n}';
  if ('padding' in b) s.padding = Math.min(int(b.padding, 3), 10);
  if ('nextNumero' in b) s.nextNumero = Math.max(int(b.nextNumero, s.nextNumero), 1);
  if ('nextClassement' in b) s.nextClassement = Math.max(int(b.nextClassement, s.nextClassement), 1);
  if (Array.isArray(b.designations)) store.get().designations = b.designations.map((d) => str(d, 100).trim()).filter(Boolean);
  store.save();
  res.json({ ok: true });
});

/* ----------------------------------------------------------------- logo */
app.post('/api/logo', (req, res) => {
  const m = /^data:(image\/(png|jpeg));base64,(.+)$/.exec(req.body?.dataUrl || '');
  if (!m) return res.status(400).json({ error: 'Image PNG ou JPEG attendue' });
  const s = store.get().settings;
  const file = `logo.${m[2] === 'png' ? 'png' : 'jpg'}`;
  for (const f of ['logo.png', 'logo.jpg']) fs.rmSync(path.join(store.DATA_DIR, f), { force: true });
  fs.writeFileSync(path.join(store.DATA_DIR, file), Buffer.from(m[3], 'base64'));
  s.logo = { file, mime: m[1], width: int(req.body.width, 200) || 200, height: int(req.body.height, 200) || 200, v: Date.now() };
  store.save();
  res.json({ ok: true });
});

app.delete('/api/logo', (req, res) => {
  const s = store.get().settings;
  if (s.logo) fs.rmSync(path.join(store.DATA_DIR, s.logo.file), { force: true });
  s.logo = null;
  store.save();
  res.json({ ok: true });
});

app.get('/api/logo', (req, res) => {
  const logo = store.get().settings.logo;
  if (!logo) return notFound(res);
  res.type(logo.mime).sendFile(path.join(store.DATA_DIR, logo.file));
});

function loadLogo() {
  const logo = store.get().settings.logo;
  if (!logo) return null;
  const file = path.join(store.DATA_DIR, logo.file);
  if (!fs.existsSync(file)) return null;
  return { buffer: fs.readFileSync(file), mime: logo.mime, width: logo.width, height: logo.height };
}

/* ------------------------------------------------- simple list resources */
function crud(name, clean) {
  const list = () => store.get()[name];
  app.post(`/api/${name}`, (req, res) => {
    const item = { id: store.newId(), ...clean(req.body || {}, null) };
    list().push(item);
    store.save();
    res.json(item);
  });
  app.put(`/api/${name}/:id`, (req, res) => {
    const item = list().find((x) => x.id === req.params.id);
    if (!item) return notFound(res);
    Object.assign(item, clean(req.body || {}, item));
    store.save();
    res.json(item);
  });
  app.delete(`/api/${name}/:id`, (req, res) => {
    const arr = list();
    const i = arr.findIndex((x) => x.id === req.params.id);
    if (i < 0) return notFound(res);
    arr.splice(i, 1);
    store.save();
    res.json({ ok: true });
  });
}

crud('persons', (b) => ({ nom: str(b.nom, 200).trim(), fonction: str(b.fonction, 300).trim() }));
crud('vus', (b) => ({ text: str(b.text, 2000).trim() }));
crud('classes', (b, existing) => ({
  code: str(b.code, 30).trim(),
  label: str(b.label, 200).trim(),
  next: Math.max(int(b.next, existing ? existing.next : 1), 1),
}));

/* ------------------------------------------------------------ decisions */
function cleanDecision(b) {
  return {
    objet: str(b.objet, 1000),
    complexe: str(b.complexe, 300),
    classId: str(b.classId, 100),
    vus: (Array.isArray(b.vus) ? b.vus : []).map((v) => str(v, 2000)).filter((v) => v.trim()),
    articles: (Array.isArray(b.articles) ? b.articles : []).map((a) => ({
      type: a?.type === 'comite' ? 'comite' : 'texte',
      text: str(a?.text, 20000),
      members:
        a?.type === 'comite' && Array.isArray(a.members)
          ? a.members.map((m) => ({
              personId: str(m?.personId, 100),
              nom: str(m?.nom, 200),
              fonction: str(m?.fonction, 300),
              designation: str(m?.designation, 100),
            }))
          : [],
    })),
  };
}

const summary = (d) => ({
  id: d.id, numero: d.numero, classement: d.classement, reference: d.reference,
  objet: d.objet, classId: d.classId, createdAt: d.createdAt, updatedAt: d.updatedAt,
});

app.get('/api/decisions', (req, res) => res.json(store.get().decisions.map(summary).reverse()));

app.get('/api/decisions/:id', (req, res) => {
  const d = store.get().decisions.find((x) => x.id === req.params.id);
  d ? res.json(d) : notFound(res);
});

app.post('/api/decisions', (req, res) => {
  const data = cleanDecision(req.body || {});
  if (!data.objet.trim()) return res.status(400).json({ error: "L'objet est obligatoire" });
  const now = new Date().toISOString();
  const d = { id: store.newId(), ...store.allocateNumbers(data.classId), ...data, createdAt: now, updatedAt: now };
  store.get().decisions.push(d);
  store.save();
  res.json(d);
});

app.put('/api/decisions/:id', (req, res) => {
  const d = store.get().decisions.find((x) => x.id === req.params.id);
  if (!d) return notFound(res);
  const data = cleanDecision(req.body || {});
  if (!data.objet.trim()) return res.status(400).json({ error: "L'objet est obligatoire" });
  // Changing the class gives the decision a new reference in that class.
  if (data.classId !== d.classId) d.reference = store.allocateReference(data.classId);
  Object.assign(d, data, { updatedAt: new Date().toISOString() });
  store.save();
  res.json(d);
});

app.delete('/api/decisions/:id', (req, res) => {
  const arr = store.get().decisions;
  const i = arr.findIndex((x) => x.id === req.params.id);
  if (i < 0) return notFound(res);
  arr.splice(i, 1);
  store.save();
  res.json({ ok: true });
});

app.get('/api/decisions/:id/docx', (req, res) => {
  const d = store.get().decisions.find((x) => x.id === req.params.id);
  if (!d) return notFound(res);
  try {
    const buf = renderDecision(d, loadLogo());
    const name = `Decision_${String(d.numero).replace(/[^\w.-]+/g, '-')}.docx`;
    res
      .set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      .set('Content-Disposition', `attachment; filename="${name}"`)
      .send(buf);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur lors de la génération du document' });
  }
});

app.listen(PORT, () => console.log(`Décisions : http://localhost:${PORT}`));
