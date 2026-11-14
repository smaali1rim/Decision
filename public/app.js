/* Décisions — interface (vanilla JS, no build step). */
'use strict';

/* ================================================================ helpers */
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

/** h('div', {class:'x', onclick: fn}, child, 'text', [children]) — never uses innerHTML. */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

let toastTimer;
function toast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 2800);
}
const fail = (e) => toast(e.message || String(e), true);

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 2 + 'px';
}
function textarea(props) {
  const el = h('textarea', { rows: 1, ...props });
  el.addEventListener('input', () => autosize(el));
  requestAnimationFrame(() => autosize(el));
  return el;
}
function move(arr, i, d) {
  const j = i + d;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('fr-FR') : '');
const byName = (a, b) => a.nom.localeCompare(b.nom, 'fr');

const storage = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

/* ================================================================== state */
let S = null; // { settings, classes, persons, vus, designations }
let view = 'editor';
let draft = null;
let nextNumbers = null;
const app = document.getElementById('app');

async function refreshState() {
  S = await api('GET', '/api/state');
}

const emptyMember = () => ({ personId: '', nom: '', fonction: '', designation: '', free: false });

function newDraft() {
  return {
    id: null,
    numero: '', classement: '', reference: '',
    objet: '',
    complexe: S.settings.complexe || '',
    classId: S.classes[0]?.id || '',
    vus: [],
    articles: [
      { type: 'texte', text: '' },
      { type: 'texte', text: '' },
      { type: 'comite', text: 'Le comité est composé de :', members: [emptyMember(), emptyMember(), emptyMember()] },
    ],
  };
}

function draftFromDecision(d, keepId) {
  return {
    id: keepId ? d.id : null,
    numero: keepId ? d.numero : '', classement: keepId ? d.classement : '', reference: keepId ? d.reference : '',
    objet: d.objet, complexe: d.complexe, classId: d.classId,
    vus: d.vus.map((text) => ({ text, libId: S.vus.find((v) => v.text === text)?.id || null })),
    articles: d.articles.map((a) => ({
      type: a.type,
      text: a.text,
      members: (a.members || []).map((m) => ({ ...m, free: !m.personId && !!m.nom })),
    })),
  };
}

const saveDraftLocal = () => storage.set('decision-draft', draft);

function draftPayload() {
  return {
    objet: draft.objet,
    complexe: draft.complexe,
    classId: draft.classId,
    vus: draft.vus.map((v) => v.text),
    articles: draft.articles.map((a) => ({
      type: a.type,
      text: a.text,
      members: a.type === 'comite' ? a.members.map(({ personId, nom, fonction, designation }) => ({ personId, nom, fonction, designation })) : [],
    })),
  };
}

/* ============================================================ navigation */
function setView(v) {
  view = v;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  render();
  window.scrollTo(0, 0);
}
document.getElementById('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) setView(b.dataset.view);
});

function render() {
  app.replaceChildren();
  ({ editor: renderEditor, registry: renderRegistry, persons: renderPersons, vus: renderVus, settings: renderSettings })[view]();
}

/* ================================================================ editor */
async function loadNextNumbers() {
  if (draft.id) return;
  try {
    nextNumbers = await api('GET', '/api/next-numbers?classId=' + encodeURIComponent(draft.classId || ''));
    renderPreview();
    const el = document.getElementById('numbers');
    if (el) el.replaceWith(numbersBlock());
  } catch (e) { fail(e); }
}

function numbersBlock() {
  const isDraft = !draft.id;
  const n = isDraft ? nextNumbers || {} : draft;
  const pill = (label, value) => h('span', { class: 'pill' + (isDraft ? ' draft' : '') }, `${label} ${value || '—'}`);
  return h('div', { class: 'numbers', id: 'numbers' },
    pill('N°', n.numero), pill('Classement', n.classement), pill('Réf.', n.reference),
    isDraft ? h('span', { class: 'muted', style: 'font-size:12.5px;align-self:center' }, 'attribués à l’enregistrement') : null);
}

function renderEditor() {
  const form = h('div', { class: 'editor-form' },
    h('div', { class: 'page-title' },
      h('h1', {}, draft.id ? `Décision N° ${draft.numero}` : 'Nouvelle décision'),
      draft.id ? h('button', { class: 'btn', onclick: startNew }, '+ Nouvelle décision') : null),
    headerCard(), vusCard(), articlesCard(), actionsBar());
  const preview = h('div', { class: 'preview-pane' },
    h('div', { class: 'preview-label' }, h('span', {}, 'Aperçu'), h('span', {}, 'A4')),
    h('div', { class: 'preview-scroll' }, h('div', { id: 'preview' })));
  app.append(h('div', { class: 'editor' }, form, preview));
  renderPreview();
  if (!draft.id && !nextNumbers) loadNextNumbers();
}

function onField(key) {
  return (e) => { draft[key] = e.target.value; saveDraftLocal(); renderPreview(); };
}

function headerCard() {
  return h('section', { class: 'card' },
    h('h2', {}, 'En-tête'),
    h('p', { class: 'hint' }, 'Le N°, le classement et la référence sont générés automatiquement.'),
    numbersBlock(),
    h('label', { class: 'field' }, h('span', {}, 'Objet *'),
      textarea({ value: draft.objet, placeholder: 'Ex. : Constitution du comité d’inventaire', oninput: onField('objet') })),
    h('div', { class: 'grid-2' },
      h('label', { class: 'field' }, h('span', {}, 'Classe (référence)'),
        h('select', {
          onchange: (e) => { draft.classId = e.target.value; saveDraftLocal(); loadNextNumbers(); renderPreview(); },
        },
          h('option', { value: '' }, '— Aucune —'),
          S.classes.map((c) => h('option', { value: c.id, selected: c.id === draft.classId }, `${c.code} — ${c.label}`)))),
      h('label', { class: 'field' }, h('span', {}, 'Le Directeur du Complexe, …'),
        h('input', { value: draft.complexe, placeholder: 'Champ 1', oninput: onField('complexe') }))));
}

function vusCard() {
  const selectedIds = new Set(draft.vus.map((v) => v.libId).filter(Boolean));
  const toggle = (v) => {
    const i = draft.vus.findIndex((x) => x.libId === v.id);
    if (i >= 0) draft.vus.splice(i, 1);
    else draft.vus.push({ text: v.text, libId: v.id });
    saveDraftLocal();
    render();
  };
  let filter = '';
  const chips = h('div', { class: 'vu-library' });
  const drawChips = () => {
    chips.replaceChildren(...S.vus
      .filter((v) => !filter || v.text.toLowerCase().includes(filter))
      .map((v) => h('button', { class: 'chip' + (selectedIds.has(v.id) ? ' on' : ''), title: v.text, onclick: () => toggle(v) },
        (selectedIds.has(v.id) ? '✓ ' : '+ ') + v.text)));
    if (!chips.children.length) chips.append(h('span', { class: 'muted' }, S.vus.length ? 'Aucun résultat' : 'Bibliothèque vide — ajoutez des « Vu » dans l’onglet Vus.'));
  };
  drawChips();

  const list = h('div', { class: 'row-list' }, draft.vus.map((v, i) =>
    h('div', { class: 'row-item' },
      textarea({ value: v.text, oninput: (e) => { v.text = e.target.value; saveDraftLocal(); renderPreview(); } }),
      h('div', { class: 'row-tools' },
        !v.libId ? h('button', { class: 'icon-btn', title: 'Enregistrer dans la bibliothèque', onclick: () => saveVuToLibrary(v) }, '☆') : null,
        h('button', { class: 'icon-btn', title: 'Monter', onclick: () => { move(draft.vus, i, -1); saveDraftLocal(); render(); } }, '↑'),
        h('button', { class: 'icon-btn', title: 'Descendre', onclick: () => { move(draft.vus, i, 1); saveDraftLocal(); render(); } }, '↓'),
        h('button', { class: 'icon-btn danger', title: 'Retirer', onclick: () => { draft.vus.splice(i, 1); saveDraftLocal(); render(); } }, '✕')))));

  return h('section', { class: 'card' },
    h('h2', {}, 'Vus'),
    h('p', { class: 'hint' }, 'Cliquez pour ajouter/retirer. Le texte reste modifiable pour cette décision.'),
    S.vus.length > 8 ? h('input', { placeholder: 'Filtrer les vus…', style: 'margin-bottom:8px', oninput: (e) => { filter = e.target.value.toLowerCase(); drawChips(); } }) : null,
    chips,
    list,
    h('div', { class: 'add-row' },
      h('button', { class: 'btn small', onclick: () => { draft.vus.push({ text: 'Vu ', libId: null }); saveDraftLocal(); render(); } }, '+ Vu personnalisé')));
}

async function saveVuToLibrary(v) {
  try {
    const item = await api('POST', '/api/vus', { text: v.text });
    S.vus.push(item);
    v.libId = item.id;
    saveDraftLocal();
    toast('Ajouté à la bibliothèque');
    render();
  } catch (e) { fail(e); }
}

function articlesCard() {
  const changed = () => { saveDraftLocal(); render(); };
  return h('section', { class: 'card' },
    h('h2', {}, 'DÉCIDE — Articles'),
    h('p', { class: 'hint' }, 'Les articles sont numérotés automatiquement. Un article « Comité » ajoute une liste de membres.'),
    h('datalist', { id: 'designations-dl' }, S.designations.map((d) => h('option', { value: d }))),
    h('div', { class: 'row-list' }, draft.articles.map((a, i) =>
      h('div', { class: 'article' },
        h('div', { class: 'article-head' },
          h('strong', {}, `Article ${i + 1}`),
          h('select', {
            onchange: (e) => {
              a.type = e.target.value;
              if (a.type === 'comite') {
                a.members = a.members?.length ? a.members : [emptyMember()];
                if (!a.text.trim()) a.text = 'Le comité est composé de :';
              }
              changed();
            },
          },
            h('option', { value: 'texte', selected: a.type === 'texte' }, 'Texte'),
            h('option', { value: 'comite', selected: a.type === 'comite' }, 'Comité / membres')),
          h('div', { class: 'row-tools' },
            h('button', { class: 'icon-btn', title: 'Monter', onclick: () => { move(draft.articles, i, -1); changed(); } }, '↑'),
            h('button', { class: 'icon-btn', title: 'Descendre', onclick: () => { move(draft.articles, i, 1); changed(); } }, '↓'),
            h('button', { class: 'icon-btn danger', title: 'Supprimer', onclick: () => { draft.articles.splice(i, 1); changed(); } }, '✕'))),
        textarea({
          value: a.text,
          placeholder: a.type === 'comite' ? 'Le comité est composé de :' : 'Texte de l’article…',
          oninput: (e) => { a.text = e.target.value; saveDraftLocal(); renderPreview(); },
        }),
        a.type === 'comite' ? membersEditor(a) : null))),
    h('div', { class: 'add-row' },
      h('button', { class: 'btn small', onclick: () => { draft.articles.push({ type: 'texte', text: '' }); changed(); } }, '+ Article'),
      h('button', { class: 'btn small', onclick: () => { draft.articles.push({ type: 'comite', text: 'Le comité est composé de :', members: [emptyMember()] }); changed(); } }, '+ Article comité')));
}

function membersEditor(a) {
  a.members = a.members || [];
  const persons = [...S.persons].sort(byName);
  const upd = () => { saveDraftLocal(); renderPreview(); };
  return h('div', { class: 'members' },
    h('div', { class: 'members-head' }, h('span', {}, 'Personne'), h('span', {}, 'Fonction'), h('span', {}, 'Désignation'), h('span', {})),
    a.members.map((m, i) =>
      h('div', { class: 'member' },
        h('div', { class: 'stack' },
          h('select', {
            onchange: (e) => {
              const val = e.target.value;
              if (val === '__free') { m.personId = ''; m.free = true; }
              else {
                const p = S.persons.find((x) => x.id === val);
                m.personId = p ? p.id : '';
                m.free = false;
                m.nom = p ? p.nom : '';
                m.fonction = p ? p.fonction : '';
              }
              saveDraftLocal();
              render();
            },
          },
            h('option', { value: '' }, '— Choisir —'),
            persons.map((p) => h('option', { value: p.id, selected: p.id === m.personId }, p.nom)),
            h('option', { value: '__free', selected: m.free }, '✎ Saisie libre…')),
          m.free ? h('input', { value: m.nom, placeholder: 'Nom et prénom', oninput: (e) => { m.nom = e.target.value; upd(); } }) : null),
        h('input', { value: m.fonction, placeholder: 'Fonction', oninput: (e) => { m.fonction = e.target.value; upd(); } }),
        h('input', { value: m.designation, list: 'designations-dl', placeholder: 'Président, Membre…', oninput: (e) => { m.designation = e.target.value; upd(); } }),
        h('button', { class: 'icon-btn danger', title: 'Retirer', onclick: () => { a.members.splice(i, 1); saveDraftLocal(); render(); } }, '✕'))),
    h('div', {},
      h('button', { class: 'btn small ghost', onclick: () => { a.members.push(emptyMember()); saveDraftLocal(); render(); } }, '+ Membre')));
}

function actionsBar() {
  return h('div', { class: 'sticky-actions' },
    h('button', { class: 'btn primary', onclick: () => saveDecision(true) }, draft.id ? 'Enregistrer et télécharger .docx' : 'Générer la décision (.docx)'),
    draft.id ? h('button', { class: 'btn', onclick: () => saveDecision(false) }, 'Enregistrer') : null,
    h('span', { class: 'spacer' }),
    draft.id ? h('button', { class: 'btn ghost', onclick: duplicateDraft }, 'Dupliquer') : null,
    h('button', { class: 'btn ghost', onclick: () => window.print(), title: 'Imprimer l’aperçu' }, 'Imprimer'),
    !draft.id ? h('button', { class: 'btn ghost', onclick: () => { if (confirm('Effacer le formulaire ?')) startNew(); } }, 'Effacer') : null);
}

function downloadDocx(id) {
  const a = h('a', { href: `/api/decisions/${id}/docx`, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

async function saveDecision(download) {
  if (!draft.objet.trim()) { toast('Veuillez saisir l’objet de la décision.', true); return; }
  try {
    const d = draft.id
      ? await api('PUT', `/api/decisions/${draft.id}`, draftPayload())
      : await api('POST', '/api/decisions', draftPayload());
    const wasNew = !draft.id;
    draft = draftFromDecision(d, true);
    saveDraftLocal();
    await refreshState();
    nextNumbers = null;
    render();
    toast(wasNew ? `Décision N° ${d.numero} créée` : 'Décision enregistrée');
    if (download) downloadDocx(d.id);
  } catch (e) { fail(e); }
}

function startNew() {
  draft = newDraft();
  nextNumbers = null;
  saveDraftLocal();
  setView('editor');
}

function duplicateDraft() {
  draft = { ...structuredClone(draft), id: null, numero: '', classement: '', reference: '' };
  nextNumbers = null;
  saveDraftLocal();
  toast('Copie créée — de nouveaux numéros seront attribués');
  setView('editor');
}

/* ---------------------------------------------------------------- preview */
function renderPreview() {
  const root = document.getElementById('preview');
  if (!root) return;
  const n = draft.id ? draft : nextNumbers || {};
  const ph = (v, label) => (v && String(v).trim() ? v : h('span', { class: 'placeholder' }, label));
  const logo = S.settings.logo
    ? h('img', { src: `/api/logo?v=${S.settings.logo.v || ''}`, alt: 'Logo' })
    : h('span', { class: 'ph' }, 'Logo');

  const articles = draft.articles.map((a, i) => {
    const lines = a.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const out = [h('p', {}, h('span', { class: 'doc-art-label' }, `Article ${i + 1} :`), ' ', ph(lines[0], '…'))];
    lines.slice(1).forEach((l) => out.push(h('p', {}, l)));
    const members = (a.members || []).filter((m) => m.nom || m.fonction || m.designation);
    if (a.type === 'comite' && members.length) {
      out.push(h('table', { class: 'doc-members' }, h('tbody', {}, members.map((m) =>
        h('tr', {}, h('td', {}, m.nom), h('td', {}, m.fonction), h('td', {}, m.designation))))));
    }
    return out;
  });

  root.replaceChildren(h('div', { class: 'paper' },
    h('div', { class: 'doc-header' },
      h('div', { class: 'doc-logo' }, logo),
      h('div', { class: 'doc-title' },
        h('div', {}, 'DECISION N° ', ph(n.numero, '…')),
        h('div', {}, 'OBJET : ', ph(draft.objet, 'objet'))),
      h('div', { class: 'doc-meta' },
        h('div', {}, 'Classement : ', n.classement || ''),
        h('div', {}, 'Référence : ', n.reference || ''),
        h('div', {}, h('b', {}, 'Page : 1 / 1')))),
    h('div', { class: 'doc-body' },
      h('p', {}, 'Le Directeur du Complexe, ', ph(draft.complexe, 'champ 1')),
      draft.vus.length ? h('ul', { class: 'doc-vus' }, draft.vus.filter((v) => v.text.trim()).map((v) => h('li', {}, v.text))) : h('p', { class: 'placeholder' }, '(aucun vu)'),
      h('p', { class: 'doc-decide' }, 'DECIDE'),
      articles,
      h('p', { class: 'doc-sign' }, 'Le Directeur du Complexe, ', ph(draft.complexe, 'champ 1'))),
    h('div', { class: 'doc-footer' },
      h('div', {}, 'Le présent document est la propriété exclusive du Complexe'),
      h('div', {}, 'Il ne peut être diffusé en externe sans l’autorisation écrite du Directeur'))));
}

/* =============================================================== registry */
async function renderRegistry() {
  app.append(h('div', { class: 'page-title' }, h('h1', {}, 'Registre des décisions'),
    h('button', { class: 'btn primary', onclick: startNew }, '+ Nouvelle décision')));
  const card = h('section', { class: 'card' }, h('p', { class: 'muted' }, 'Chargement…'));
  app.append(card);
  let list;
  try { list = await api('GET', '/api/decisions'); } catch (e) { return fail(e); }
  const tbody = h('tbody');
  const draw = (q) => {
    const rows = list.filter((d) => !q || [d.numero, d.objet, d.reference, d.classement].join(' ').toLowerCase().includes(q));
    tbody.replaceChildren(...(rows.length ? rows.map((d) => h('tr', {},
      h('td', { class: 'nowrap' }, h('strong', {}, d.numero)),
      h('td', {}, d.objet),
      h('td', { class: 'nowrap' }, d.classement),
      h('td', { class: 'nowrap' }, d.reference),
      h('td', { class: 'nowrap' }, fmtDate(d.createdAt)),
      h('td', { class: 'nowrap' }, h('div', { class: 'actions' },
        h('button', { class: 'btn small', onclick: () => openDecision(d.id, true) }, 'Ouvrir'),
        h('button', { class: 'btn small', onclick: () => downloadDocx(d.id) }, '.docx'),
        h('button', { class: 'btn small ghost', onclick: () => openDecision(d.id, false) }, 'Dupliquer'),
        h('button', { class: 'icon-btn danger', title: 'Supprimer', onclick: () => deleteDecision(d) }, '✕')))))
      : [h('tr', {}, h('td', { colspan: 6, class: 'empty' }, list.length ? 'Aucun résultat.' : 'Aucune décision pour le moment.'))]));
  };
  draw('');
  card.replaceChildren(
    h('div', { class: 'toolbar' }, h('input', { placeholder: 'Rechercher (N°, objet, référence…)', oninput: (e) => draw(e.target.value.toLowerCase()) })),
    h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, ['N°', 'Objet', 'Classement', 'Référence', 'Date', ''].map((t) => h('th', {}, t)))), tbody)));
}

async function openDecision(id, edit) {
  try {
    const d = await api('GET', `/api/decisions/${id}`);
    draft = draftFromDecision(d, edit);
    nextNumbers = null;
    saveDraftLocal();
    setView('editor');
  } catch (e) { fail(e); }
}

async function deleteDecision(d) {
  if (!confirm(`Supprimer définitivement la décision N° ${d.numero} ?\nSon numéro ne sera pas réattribué.`)) return;
  try {
    await api('DELETE', `/api/decisions/${d.id}`);
    if (draft.id === d.id) { draft = newDraft(); saveDraftLocal(); }
    toast('Décision supprimée');
    render();
  } catch (e) { fail(e); }
}

/* ================================================================ persons */
function renderPersons() {
  const nom = h('input', { placeholder: 'Nom et prénom' });
  const fonction = h('input', { placeholder: 'Fonction' });
  const add = async () => {
    if (!nom.value.trim()) return toast('Le nom est obligatoire', true);
    try {
      S.persons.push(await api('POST', '/api/persons', { nom: nom.value, fonction: fonction.value }));
      toast('Personne ajoutée');
      render();
    } catch (e) { fail(e); }
  };
  const bulk = textarea({ placeholder: 'Une personne par ligne :  Nom ; Fonction', style: 'min-height:80px' });
  const importBulk = async () => {
    const lines = bulk.value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    try {
      for (const l of lines) {
        const [n, ...f] = l.split(/[;\t]/);
        S.persons.push(await api('POST', '/api/persons', { nom: n.trim(), fonction: f.join(' ').trim() }));
      }
      toast(`${lines.length} personne(s) importée(s)`);
      render();
    } catch (e) { fail(e); }
  };

  app.append(
    h('div', { class: 'page-title' }, h('h1', {}, 'Personnes')),
    h('section', { class: 'card' },
      h('h2', {}, 'Ajouter une personne'),
      h('p', { class: 'hint' }, 'Les personnes enregistrées apparaissent dans la liste déroulante des articles « Comité », avec leur fonction remplie automatiquement.'),
      h('div', { class: 'grid-2' }, nom, fonction),
      h('div', { class: 'add-row' }, h('button', { class: 'btn primary', onclick: add }, 'Ajouter')),
      h('details', { style: 'margin-top:14px' }, h('summary', { class: 'muted', style: 'cursor:pointer' }, 'Importer une liste (copier-coller depuis Excel)'),
        h('div', { style: 'margin-top:8px' }, bulk, h('div', { class: 'add-row' }, h('button', { class: 'btn', onclick: importBulk }, 'Importer'))))),
    h('section', { class: 'card' },
      h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Nom'), h('th', {}, 'Fonction'), h('th', {}))),
        h('tbody', {}, S.persons.length ? [...S.persons].sort(byName).map((p) => h('tr', {},
          h('td', {}, inlineInput(p, 'nom', 'persons')),
          h('td', {}, inlineInput(p, 'fonction', 'persons')),
          h('td', { class: 'nowrap', style: 'width:1%' }, h('button', { class: 'icon-btn danger', title: 'Supprimer', onclick: () => removeItem('persons', p, p.nom) }, '✕'))))
          : h('tr', {}, h('td', { colspan: 3, class: 'empty' }, 'Aucune personne enregistrée.')))))));
}

/** Input that saves the field on change. */
function inlineInput(item, key, resource, type) {
  return h('input', {
    value: item[key], type: type || 'text',
    onchange: async (e) => {
      try {
        Object.assign(item, await api('PUT', `/api/${resource}/${item.id}`, { ...item, [key]: e.target.value }));
        toast('Enregistré');
      } catch (err) { fail(err); }
    },
  });
}

async function removeItem(resource, item, label) {
  if (!confirm(`Supprimer « ${label} » ?`)) return;
  try {
    await api('DELETE', `/api/${resource}/${item.id}`);
    S[resource] = S[resource].filter((x) => x.id !== item.id);
    toast('Supprimé');
    render();
  } catch (e) { fail(e); }
}

/* ==================================================================== vus */
function renderVus() {
  const input = textarea({ placeholder: 'Ex. : Vu la loi n° 90-11 du 21 avril 1990 relative aux relations de travail ;' });
  const add = async () => {
    if (!input.value.trim()) return;
    try {
      S.vus.push(await api('POST', '/api/vus', { text: input.value }));
      toast('Vu ajouté');
      render();
    } catch (e) { fail(e); }
  };
  app.append(
    h('div', { class: 'page-title' }, h('h1', {}, 'Bibliothèque des « Vu »')),
    h('section', { class: 'card' },
      h('h2', {}, 'Ajouter un vu'),
      h('p', { class: 'hint' }, 'Ces textes sont proposés en choix multiple dans chaque nouvelle décision.'),
      input, h('div', { class: 'add-row' }, h('button', { class: 'btn primary', onclick: add }, 'Ajouter'))),
    h('section', { class: 'card' },
      S.vus.length ? h('div', { class: 'row-list' }, S.vus.map((v) => {
        const ta = textarea({ value: v.text });
        ta.addEventListener('change', async () => {
          try { Object.assign(v, await api('PUT', `/api/vus/${v.id}`, { text: ta.value })); toast('Enregistré'); } catch (e) { fail(e); }
        });
        return h('div', { class: 'row-item' }, ta, h('div', { class: 'row-tools' },
          h('button', { class: 'icon-btn danger', title: 'Supprimer', onclick: () => removeItem('vus', v, v.text) }, '✕')));
      })) : h('p', { class: 'empty' }, 'Aucun vu enregistré.')));
}

/* =============================================================== settings */
function renderSettings() {
  const s = S.settings;
  const f = {};
  const field = (key, label, type = 'text', extra = {}) =>
    h('label', { class: 'field' }, h('span', {}, label), (f[key] = h('input', { type, value: s[key], ...extra })));

  const saveSettings = async () => {
    try {
      await api('PUT', '/api/settings', Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])));
      await refreshState();
      nextNumbers = null;
      if (!draft.id && !draft.complexe.trim()) { draft.complexe = S.settings.complexe; saveDraftLocal(); }
      toast('Paramètres enregistrés');
      render();
    } catch (e) { fail(e); }
  };

  // Logo
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg', style: 'display:none' });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return toast('Image trop lourde (5 Mo max)', true);
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = async () => {
        try {
          await api('POST', '/api/logo', { dataUrl: reader.result, width: img.naturalWidth, height: img.naturalHeight });
          await refreshState();
          toast('Logo mis à jour');
          render();
        } catch (e) { fail(e); }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  // Classes
  const cCode = h('input', { placeholder: 'Code (ex. RH)' });
  const cLabel = h('input', { placeholder: 'Libellé (ex. Ressources humaines)' });
  const addClass = async () => {
    if (!cCode.value.trim()) return toast('Le code est obligatoire', true);
    try {
      S.classes.push(await api('POST', '/api/classes', { code: cCode.value, label: cLabel.value, next: 1 }));
      toast('Classe ajoutée');
      render();
    } catch (e) { fail(e); }
  };

  const designations = textarea({ value: S.designations.join('\n'), style: 'min-height:90px' });

  app.append(
    h('div', { class: 'page-title' }, h('h1', {}, 'Paramètres')),
    h('section', { class: 'card' },
      h('h2', {}, 'Signataire'),
      h('p', { class: 'hint' }, 'Valeur par défaut du champ 1 : « Le Directeur du Complexe, … » (modifiable dans chaque décision).'),
      field('complexe', 'Le Directeur du Complexe, …'),
      h('button', { class: 'btn primary', onclick: saveSettings }, 'Enregistrer')),
    h('section', { class: 'card' },
      h('h2', {}, 'Logo'),
      h('p', { class: 'hint' }, 'Affiché dans la case « Logo » de l’en-tête (PNG ou JPEG).'),
      h('div', { class: 'logo-box' },
        h('div', { class: 'logo-frame' }, s.logo ? h('img', { src: `/api/logo?v=${s.logo.v || ''}`, alt: 'Logo' }) : h('span', { class: 'muted' }, 'Aucun')),
        h('div', { class: 'actions' },
          fileInput,
          h('button', { class: 'btn', onclick: () => fileInput.click() }, s.logo ? 'Remplacer…' : 'Choisir une image…'),
          s.logo ? h('button', { class: 'btn danger', onclick: async () => { try { await api('DELETE', '/api/logo'); await refreshState(); render(); } catch (e) { fail(e); } } }, 'Retirer') : null))),
    h('section', { class: 'card' },
      h('h2', {}, 'Numérotation automatique'),
      h('p', { class: 'hint' }, 'Formats : ', h('code', {}, '{n}'), ' numéro, ', h('code', {}, '{yyyy}'), ' année, ', h('code', {}, '{yy}'),
        ' année courte, ', h('code', {}, '{code}'), ' code de la classe. Ex. : ', h('code', {}, '{n}/{yyyy}'), ' → 007/2026.'),
      h('div', { class: 'grid-2' },
        field('nextNumero', 'Prochain N° de décision', 'number', { min: 1 }),
        field('numeroFormat', 'Format du N°'),
        field('nextClassement', 'Prochain N° de classement', 'number', { min: 1 }),
        field('classementFormat', 'Format du classement'),
        field('referenceFormat', 'Format de la référence'),
        field('padding', 'Nombre de chiffres (zéros devant)', 'number', { min: 0, max: 10 })),
      h('button', { class: 'btn primary', onclick: saveSettings }, 'Enregistrer')),
    h('section', { class: 'card' },
      h('h2', {}, 'Classes (référence)'),
      h('p', { class: 'hint' }, 'Chaque classe a son propre compteur de référence.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Code'), h('th', {}, 'Libellé'), h('th', {}, 'Prochain N°'), h('th', {}))),
        h('tbody', {}, S.classes.map((c) => h('tr', {},
          h('td', { style: 'width:22%' }, inlineInput(c, 'code', 'classes')),
          h('td', {}, inlineInput(c, 'label', 'classes')),
          h('td', { style: 'width:18%' }, inlineInput(c, 'next', 'classes', 'number')),
          h('td', { style: 'width:1%' }, h('button', { class: 'icon-btn danger', title: 'Supprimer', onclick: () => removeItem('classes', c, c.code) }, '✕'))))))),
      h('div', { class: 'grid-2', style: 'margin-top:12px' }, cCode, cLabel),
      h('div', { class: 'add-row' }, h('button', { class: 'btn', onclick: addClass }, '+ Ajouter la classe'))),
    h('section', { class: 'card' },
      h('h2', {}, 'Désignations proposées'),
      h('p', { class: 'hint' }, 'Une par ligne. Proposées pour les membres de comité (la saisie libre reste possible).'),
      designations,
      h('div', { class: 'add-row' }, h('button', { class: 'btn primary', onclick: async () => {
        try {
          await api('PUT', '/api/settings', { designations: designations.value.split('\n') });
          await refreshState();
          toast('Désignations enregistrées');
        } catch (e) { fail(e); }
      } }, 'Enregistrer'))));
}

/* =================================================================== boot */
(async function boot() {
  try {
    await refreshState();
  } catch (e) {
    app.append(h('p', { class: 'empty' }, 'Impossible de contacter le serveur.'));
    return;
  }
  const saved = storage.get('decision-draft');
  draft = saved && Array.isArray(saved.articles) ? saved : newDraft();
  render();
})();
