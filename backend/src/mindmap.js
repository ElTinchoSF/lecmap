// Normalización y prompt del mindmap (formato v2 con secciones multi-layout).
// Extraído de index.js para poder testear la normalización sin arrancar Fastify.

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const strList = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

const ALL_LAYOUTS = ['topics', 'comparison', 'steps', 'timeline', 'glossary', 'cause', 'solution'];

function asBranches(list, depth = 0) {
  if (!Array.isArray(list) || depth > 4) return [];
  return list
    .map((b) => ({
      label: str(b?.label),
      detail: b?.detail ? String(b.detail) : undefined,
      points: strList(b?.points),
      branches: asBranches(b?.branches ?? b?.children, depth + 1),
    }))
    .filter((b) => b.label);
}

function buildTopics(mm, fallbackTitle) {
  if (Array.isArray(mm.topics) && mm.topics.length > 0) {
    const topics = mm.topics
      .map((t, i) => {
        const branches = asBranches(t?.branches);
        const title = str(t?.title ?? t?.label) || branches[0]?.label || `Tema ${i + 1}`;
        return { title, branches };
      })
      .filter((t) => t.branches.length > 0);
    if (topics.length > 0) return topics;
  }

  if (Array.isArray(mm.branches)) {
    const branches = asBranches(mm.branches);
    if (branches.length > 0) return [{ title: fallbackTitle || branches[0].label, branches }];
  }

  if (Array.isArray(mm.nodes) && mm.nodes.length > 0) {
    const nodes = mm.nodes
      .map((n, i) => ({
        id: str(n?.id) || `n${i + 1}`,
        label: str(n?.label),
        detail: n?.detail ? String(n.detail) : undefined,
        parent: n?.parent ? String(n.parent) : null,
      }))
      .filter((n) => n.label);

    const ids = new Set(nodes.map((n) => n.id));
    const childrenOf = new Map();
    for (const n of nodes) {
      const parent = n.parent && ids.has(n.parent) && n.parent !== n.id ? n.parent : null;
      const arr = childrenOf.get(parent) || [];
      arr.push(n);
      childrenOf.set(parent, arr);
    }

    const toBranch = (n) => ({
      label: n.label,
      detail: n.detail,
      points: [],
      branches: (childrenOf.get(n.id) || []).map(toBranch),
    });

    const roots = childrenOf.get(null) || [];
    const rootKids = roots.length === 1 ? childrenOf.get(roots[0].id) || [] : [];
    const baseTitle = fallbackTitle || str(roots[0]?.label) || 'Mapa de ideas';

    if (roots.length === 1 && rootKids.length >= 2) {
      return [{ title: baseTitle, branches: rootKids.map(toBranch) }];
    }
    if (roots.length === 1 && nodes.length > 2) {
      return [{
        title: baseTitle,
        branches: nodes.map((n) => ({ label: n.label, detail: n.detail, points: [], branches: [] })),
      }];
    }
    return [{ title: baseTitle, branches: roots.map(toBranch) }];
  }

  if (mm.root || mm.children) {
    const root = String(mm.root || mm.title || 'Mapa de ideas');
    return [{
      title: root,
      branches: (mm.children || [])
        .map((c) => ({
          label: str(typeof c === 'string' ? c : c?.label),
          detail: typeof c === 'object' && c?.detail ? String(c.detail) : undefined,
          points: [],
          branches: [],
        }))
        .filter((b) => b.label),
    }];
  }
  return [];
}

function emptyData(layout, title) {
  return {
    title: title || 'Mapa de ideas',
    layout,
    topics: [],
    dimensions: [],
    items: [],
    steps: [],
    events: [],
    terms: [],
    causes: [],
    problems: [],
  };
}

function buildComparison(mm, title) {
  const dimensions = strList(mm.dimensions);
  const items = (Array.isArray(mm.items) ? mm.items : [])
    .map((it) => ({
      name: str(it?.name ?? it?.label),
      values: Array.isArray(it?.values) ? it.values.map((v) => String(v)) : [],
    }))
    .filter((it) => it.name);
  return items.length > 0 ? { ...emptyData('comparison', title), dimensions, items } : null;
}

function buildSteps(mm, title) {
  const steps = (Array.isArray(mm.steps) ? mm.steps : [])
    .map((s) => ({
      label: str(s?.label),
      detail: s?.detail ? String(s.detail) : undefined,
      points: strList(s?.points),
    }))
    .filter((s) => s.label);
  return steps.length > 0 ? { ...emptyData('steps', title), steps } : null;
}

function buildTimeline(mm, title) {
  const events = (Array.isArray(mm.events) ? mm.events : [])
    .map((e) => ({
      date: e?.date ? String(e.date) : undefined,
      label: str(e?.label ?? e?.title),
      detail: e?.detail ? String(e.detail) : undefined,
      points: strList(e?.points),
    }))
    .filter((e) => e.label);
  return events.length > 0 ? { ...emptyData('timeline', title), events } : null;
}

function buildGlossary(mm, title) {
  const terms = (Array.isArray(mm.terms) ? mm.terms : [])
    .map((t) => ({
      term: str(t?.term ?? t?.label ?? t?.name),
      definition: str(t?.definition ?? t?.detail),
      points: strList(t?.points),
    }))
    .filter((t) => t.term && t.definition);
  return terms.length > 0 ? { ...emptyData('glossary', title), terms } : null;
}

function buildCause(mm, title) {
  const causes = (Array.isArray(mm.causes) ? mm.causes : [])
    .map((c) => ({
      label: str(c?.label ?? c?.cause),
      detail: c?.detail ? String(c.detail) : undefined,
      effects: strList(c?.effects ?? c?.points),
    }))
    .filter((c) => c.label);
  return causes.length > 0 ? { ...emptyData('cause', title), causes } : null;
}

function buildSolution(mm, title) {
  const problems = (Array.isArray(mm.problems) ? mm.problems : [])
    .map((p) => ({
      label: str(p?.label ?? p?.problem),
      detail: p?.detail ? String(p.detail) : undefined,
      solutions: strList(p?.solutions ?? p?.points),
    }))
    .filter((p) => p.label);
  return problems.length > 0 ? { ...emptyData('solution', title), problems } : null;
}

function layoutBuilders(mm, title) {
  return {
    topics: () => {
      const topics = buildTopics(mm, title);
      return topics.length > 0
        ? { ...emptyData('topics', title || topics[0].title), topics }
        : null;
    },
    comparison: () => buildComparison(mm, title),
    steps: () => buildSteps(mm, title),
    timeline: () => buildTimeline(mm, title),
    glossary: () => buildGlossary(mm, title),
    cause: () => buildCause(mm, title),
    solution: () => buildSolution(mm, title),
  };
}

// Si el layout pedido no trae datos válidos, prueba los demás y cae a topics.
function normalizeLayout(mm, title) {
  const requested = ALL_LAYOUTS.includes(mm.layout) ? mm.layout : 'topics';
  const builders = layoutBuilders(mm, title);
  const order = [requested, ...ALL_LAYOUTS.filter((l) => l !== requested)];
  for (const layout of order) {
    const data = builders[layout]();
    if (data) return data;
  }
  return null;
}

function normalizeSection(s) {
  if (!s || typeof s !== 'object') return null;
  return normalizeLayout(s, str(s.title));
}

// Formato v2: { title, sections: [{ title, layout, ...payload }] } — un layout
// por tema central. Formato viejo (single-layout) sigue soportado para notas
// existentes y para respuestas del modelo que no apliquen v2.
function normalizeMindmap(mm) {
  if (!mm) return null;
  if (Array.isArray(mm.sections)) {
    const title = str(mm.title);
    const sections = mm.sections.map(normalizeSection).filter(Boolean);
    if (sections.length === 0) return null;
    return { title: title || sections[0].title, sections };
  }
  const title = str(mm.title);
  return normalizeLayout(mm, title);
}

function mindmapSystemPrompt(template, targetSentences) {
  return `Eres un experto que convierte transcripciones en mapas de ideas de estudio en español. Template: ${template}. `
    + 'Responde SOLO JSON con esta forma exacta: '
    + '{'
    + '"summary": string, '
    + '"mindmap": {'
    + '"title": string, '
    + '"sections": [{"title": string, '
    + '"layout": "topics"|"comparison"|"steps"|"timeline"|"glossary"|"cause"|"solution", '
    + '"topics": [{"title": string, "branches": [{"label": string, "detail": string, "points": [string], "branches": [{"label": string, "detail": string, "points": [string]}]}]}], '
    + '"dimensions": [string], '
    + '"items": [{"name": string, "values": [string]}], '
    + '"steps": [{"label": string, "detail": string, "points": [string]}], '
    + '"events": [{"date": string, "label": string, "detail": string, "points": [string]}], '
    + '"terms": [{"term": string, "definition": string, "points": [string]}], '
    + '"causes": [{"label": string, "detail": string, "effects": [string]}], '
    + '"problems": [{"label": string, "detail": string, "solutions": [string]}]'
    + '}]'
    + '}'
    + '}. '
    + 'Dividí la clase en sus temas centrales: cada tema central es UNA sección con su propio "title" y SU "layout", elegido según el contenido de ESE tema. '
    + 'Completá SOLO los campos del layout elegido en cada sección (podés omitir los demás). '
    + 'Elegí por sección el layout que MEJOR se adapte a su contenido: '
    + '"topics" = mapa conceptual de uno o varios temas con sus ideas (USO GENERAL, el más común); '
    + '"comparison" = se comparan varios elementos (teorías, modelos, autores, enfoques) a lo largo de dimensiones comunes; '
    + '"steps" = proceso, método, algoritmo o secuencia de pasos a seguir; '
    + '"timeline" = evolución o sucesión histórica de hechos con fechas o etapas; '
    + '"glossary" = el tema consiste esencialmente en DEFINIR términos o conceptos (una lista de definiciones, sin comparación, proceso ni causas); '
    + '"cause" = se explican causas y sus efectos o consecuencias; '
    + '"solution" = se plantean problemas y sus soluciones, o un caso con diagnóstico y tratamiento. '
    + 'IMPORTANTE: los diseños especiales (comparison, steps, timeline, glossary, cause, solution) usalos SOLO si el contenido de esa sección realmente se ajusta a esa forma; si no, usá "topics". No fuerces un diseño. '
    + 'Si la clase trata un solo tema central, devolvé UNA sola sección. '
    + 'NO hay límite de secciones, temas, ramas, sub-ramas, puntos, elementos, pasos, eventos, términos, causas ni problemas: usá tantos como necesite la clase para cubrir TODAS las ideas principales. '
    + 'Si el tema lo pide, anidá sub-ramas dentro de una rama usando su campo "branches". '
    + 'Reglas de contenido: label/term/label de paso/evento/etiqueta corto (2 a 5 palabras); detail o definition una o dos frases con el contenido real de la transcripción; points/effects/solutions viñetas concretas (datos, sub-ideas, fórmulas, ejemplos); para comparison, cada item con sus values en el mismo orden que dimensions; para timeline usá "date" con el año, década o momento mencionado. '
    + 'Organizá por relación de ideas; solo usá orden cronológico cuando elijas "timeline" o "steps". No menciones minutos de la grabación. '
    + 'No repitas ideas y no inventes contenido ausente. '
    + 'El summary debe ser un resumen de estudio de aproximadamente ' + targetSentences
    + ' frases; priorizá cubrir todas las ideas principales antes que acortar.';
}

export { normalizeMindmap, mindmapSystemPrompt, ALL_LAYOUTS };
