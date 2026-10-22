import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { CSSProperties, ReactNode, SyntheticEvent } from 'react';
import {
  deleteAudio,
  deleteLocalNote,
  getAudio,
  getLocalNote,
  listLocalNotes,
  saveAudio,
  saveLocalNote,
} from './local';
import type { LocalNote } from './local';
import './App.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

type Segment = { start: number; end: number; speaker: string; text: string };
type MindBranch = { label: string; detail?: string; points: string[]; branches: MindBranch[] };
type MindTopic = { title: string; branches: MindBranch[] };
type MindItem = { name: string; values: string[] };
type MindStep = { label: string; detail?: string; points: string[] };
type MindEvent = { date?: string; label: string; detail?: string; points: string[] };
type MindTerm = { term: string; definition: string; points: string[] };
type MindCause = { label: string; detail?: string; effects: string[] };
type MindProblem = { label: string; detail?: string; solutions: string[] };
type MindLayout =
  | 'topics'
  | 'comparison'
  | 'steps'
  | 'timeline'
  | 'glossary'
  | 'cause'
  | 'solution';
type MindData = {
  title: string;
  layout: MindLayout;
  topics: MindTopic[];
  dimensions: string[];
  items: MindItem[];
  steps: MindStep[];
  events: MindEvent[];
  terms: MindTerm[];
  causes: MindCause[];
  problems: MindProblem[];
};

const ALL_LAYOUTS: MindLayout[] = [
  'topics', 'comparison', 'steps', 'timeline', 'glossary', 'cause', 'solution',
];
type Recording = {
  id: string; title: string; status: string; error?: string;
  audioPath?: string | null; transcript: Segment[]; summary: string | null; mindmap: any;
  createdAt?: string;
};

type NoteView = Recording & {
  localId?: string;
  serverId?: string;
  hasLocalAudio: boolean;
  hasServerAudio: boolean;
};

function fmtTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

const str = (v: any) => (v === undefined || v === null ? '' : String(v).trim());
const strList = (v: any) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

function asBranches(list: any, depth = 0): MindBranch[] {
  if (!Array.isArray(list) || depth > 4) return [];
  return list
    .map((b: any) => ({
      label: str(b?.label),
      detail: b?.detail ? String(b.detail) : undefined,
      points: strList(b?.points),
      branches: asBranches(b?.branches ?? b?.children, depth + 1),
    }))
    .filter((b: MindBranch) => b.label);
}

function buildTopics(mm: any, fallbackTitle: string): MindTopic[] {
  if (Array.isArray(mm.topics) && mm.topics.length > 0) {
    const topics = mm.topics
      .map((t: any, i: number) => {
        const branches = asBranches(t?.branches);
        const title = str(t?.title ?? t?.label) || branches[0]?.label || `Tema ${i + 1}`;
        return { title, branches };
      })
      .filter((t: MindTopic) => t.branches.length > 0);
    if (topics.length > 0) return topics;
  }

  if (Array.isArray(mm.branches)) {
    const branches = asBranches(mm.branches);
    if (branches.length > 0) return [{ title: fallbackTitle || branches[0].label, branches }];
  }

  if (Array.isArray(mm.nodes) && mm.nodes.length > 0) {
    const nodes = mm.nodes
      .map((n: any, i: number) => ({
        id: str(n?.id) || `n${i + 1}`,
        label: str(n?.label),
        detail: n?.detail ? String(n.detail) : undefined,
        parent: n?.parent ? String(n.parent) : null,
      }))
      .filter((n: any) => n.label);

    const ids = new Set(nodes.map((n: any) => n.id));
    const childrenOf = new Map<string | null, any[]>();
    for (const n of nodes) {
      const parent = n.parent && ids.has(n.parent) && n.parent !== n.id ? n.parent : null;
      const arr = childrenOf.get(parent) || [];
      arr.push(n);
      childrenOf.set(parent, arr);
    }

    const toBranch = (n: any): MindBranch => ({
      label: n.label,
      detail: n.detail,
      points: [],
      branches: (childrenOf.get(n.id) || []).map(toBranch),
    });

    const roots = childrenOf.get(null) || [];
    const rootKids = roots.length === 1 ? childrenOf.get(roots[0].id) || [] : [];
    const baseTitle = fallbackTitle || String(roots[0]?.label || 'Mapa de ideas');

    if (roots.length === 1 && rootKids.length >= 2) {
      return [{ title: baseTitle, branches: rootKids.map(toBranch) }];
    }
    if (roots.length === 1 && nodes.length > 2) {
      return [{
        title: baseTitle,
        branches: nodes.map((n: any) => ({ label: n.label, detail: n.detail, points: [], branches: [] })),
      }];
    }
    return [{ title: baseTitle, branches: roots.map(toBranch) }];
  }

  const rootLabel = mm.root || mm.title;
  if (!rootLabel && !mm.children) return [];
  const title = String(rootLabel || 'Mapa de ideas');
  return [{
    title,
    branches: (mm.children || [])
      .map((c: any) => ({
        label: str(typeof c === 'string' ? c : c?.label),
        detail: typeof c === 'object' && c?.detail ? String(c.detail) : undefined,
        points: [],
        branches: [],
      }))
      .filter((b: MindBranch) => b.label),
  }];
}

function emptyData(layout: MindLayout, title: string): MindData {
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

function buildComparison(mm: any, title: string): MindData | null {
  const dimensions = strList(mm.dimensions);
  const items: MindItem[] = (Array.isArray(mm.items) ? mm.items : [])
    .map((it: any) => ({
      name: str(it?.name ?? it?.label),
      values: Array.isArray(it?.values) ? it.values.map((v: any) => String(v)) : [],
    }))
    .filter((it: MindItem) => it.name);
  return items.length > 0 ? { ...emptyData('comparison', title), dimensions, items } : null;
}

function buildSteps(mm: any, title: string): MindData | null {
  const steps: MindStep[] = (Array.isArray(mm.steps) ? mm.steps : [])
    .map((s: any) => ({
      label: str(s?.label),
      detail: s?.detail ? String(s.detail) : undefined,
      points: strList(s?.points),
    }))
    .filter((s: MindStep) => s.label);
  return steps.length > 0 ? { ...emptyData('steps', title), steps } : null;
}

function buildTimeline(mm: any, title: string): MindData | null {
  const events: MindEvent[] = (Array.isArray(mm.events) ? mm.events : [])
    .map((e: any) => ({
      date: e?.date ? String(e.date) : undefined,
      label: str(e?.label ?? e?.title),
      detail: e?.detail ? String(e.detail) : undefined,
      points: strList(e?.points),
    }))
    .filter((e: MindEvent) => e.label);
  return events.length > 0 ? { ...emptyData('timeline', title), events } : null;
}

function buildGlossary(mm: any, title: string): MindData | null {
  const terms: MindTerm[] = (Array.isArray(mm.terms) ? mm.terms : [])
    .map((t: any) => ({
      term: str(t?.term ?? t?.label ?? t?.name),
      definition: str(t?.definition ?? t?.detail),
      points: strList(t?.points),
    }))
    .filter((t: MindTerm) => t.term && t.definition);
  return terms.length > 0 ? { ...emptyData('glossary', title), terms } : null;
}

function buildCause(mm: any, title: string): MindData | null {
  const causes: MindCause[] = (Array.isArray(mm.causes) ? mm.causes : [])
    .map((c: any) => ({
      label: str(c?.label ?? c?.cause),
      detail: c?.detail ? String(c.detail) : undefined,
      effects: strList(c?.effects ?? c?.points),
    }))
    .filter((c: MindCause) => c.label);
  return causes.length > 0 ? { ...emptyData('cause', title), causes } : null;
}

function buildSolution(mm: any, title: string): MindData | null {
  const problems: MindProblem[] = (Array.isArray(mm.problems) ? mm.problems : [])
    .map((p: any) => ({
      label: str(p?.label ?? p?.problem),
      detail: p?.detail ? String(p.detail) : undefined,
      solutions: strList(p?.solutions ?? p?.points),
    }))
    .filter((p: MindProblem) => p.label);
  return problems.length > 0 ? { ...emptyData('solution', title), problems } : null;
}

// Normaliza a un modelo con layout elegido por la IA. Si el layout pedido no trae
// datos, prueba los demás y, como último recurso, cae al mapa de temas.
function normalizeMindmap(mm: any): MindData | null {
  if (!mm) return null;
  const title = str(mm.title);
  const requested: MindLayout = (ALL_LAYOUTS as string[]).includes(mm.layout)
    ? (mm.layout as MindLayout)
    : 'topics';

  const builders: Record<MindLayout, () => MindData | null> = {
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

  const order = [requested, ...ALL_LAYOUTS.filter((l) => l !== requested)];
  for (const layout of order) {
    const data = builders[layout]();
    if (data) return data;
  }
  return null;
}

const BRANCH_COLORS = ['#38bdf8', '#818cf8', '#34d399', '#fbbf24', '#f472b6', '#22d3ee'];

function BranchCard({ b, index }: { b: MindBranch; index: number }) {
  const color = BRANCH_COLORS[index % BRANCH_COLORS.length];
  return (
    <div className="mm-branch" style={{ '--branch': color } as CSSProperties}>
      <div className="mm-branch-head">
        <span className="mm-branch-num">{index + 1}</span>
        <span className="mm-branch-label">{b.label}</span>
      </div>
      {b.detail && <p className="mm-branch-detail">{b.detail}</p>}
      {b.points.length > 0 && (
        <ul className="mm-points">
          {b.points.map((p, j) => <li key={j}>{p}</li>)}
        </ul>
      )}
      {b.branches.length > 0 && (
        <div className="mm-sub">
          {b.branches.map((sub, k) => <BranchCard key={k} b={sub} index={index + k + 1} />)}
        </div>
      )}
    </div>
  );
}

function TopicsView({ data }: { data: MindData }) {
  return (
    <div className="mm-topics">
      {data.topics.length > 1 && (
        <div className="mm-overall">
          <span>{data.title}</span>
          <span className="mm-overall-count">{data.topics.length} temas centrales</span>
        </div>
      )}

      {data.topics.map((topic, ti) => {
        const stacked = topic.branches.length <= 6;
        return (
          <section className="mm-topic" key={`${topic.title}-${ti}`}>
            {stacked ? (
              <div className="mm-tree">
                <div className="mm-root">
                  <span className="mm-root-kicker">Tema central</span>
                  <span className="mm-root-title">{topic.title}</span>
                </div>
                <div className="mm-link" aria-hidden="true" />
                <div className="mm-branch-col">
                  {topic.branches.map((b, i) => <BranchCard key={i} b={b} index={i} />)}
                </div>
              </div>
            ) : (
              <>
                <div className="mm-root mm-root-center">
                  <span className="mm-root-kicker">Tema central</span>
                  <span className="mm-root-title">{topic.title}</span>
                </div>
                <div className="mm-stem" aria-hidden="true" />
                <div className="mm-branch-grid">
                  {topic.branches.map((b, i) => <BranchCard key={i} b={b} index={i} />)}
                </div>
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

function ComparisonView({ data }: { data: MindData }) {
  const maxValues = data.items.reduce((m, it) => Math.max(m, it.values.length), 0);
  const headers = data.dimensions.length > 0
    ? data.dimensions
    : Array.from({ length: maxValues }, (_, i) => `Aspecto ${i + 1}`);

  return (
    <>
      <div className="mm-overall">
        <span>{data.title}</span>
        <span className="mm-overall-count">{data.items.length} elementos · comparación</span>
      </div>
      <div className="mm-compare-wrap">
        <table className="mm-compare">
          <thead>
            <tr>
              {headers.map((h, i) => <th key={i}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.items.map((it, r) => (
              <tr key={r}>
                <th scope="row">{it.name}</th>
                {headers.map((_, c) => <td key={c}>{it.values[c] ?? ''}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function StepsView({ data }: { data: MindData }) {
  return (
    <>
      <div className="mm-overall">
        <span>{data.title}</span>
        <span className="mm-overall-count">{data.steps.length} pasos</span>
      </div>
      <ol className="mm-steps">
        {data.steps.map((s, i) => (
          <li
            className="mm-step"
            key={i}
            style={{ '--branch': BRANCH_COLORS[i % BRANCH_COLORS.length] } as CSSProperties}
          >
            <span className="mm-step-num">{i + 1}</span>
            <div className="mm-step-body">
              <div className="mm-step-label">{s.label}</div>
              {s.detail && <p className="mm-branch-detail">{s.detail}</p>}
              {s.points.length > 0 && (
                <ul className="mm-points">
                  {s.points.map((p, j) => <li key={j}>{p}</li>)}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

function TimelineView({ data }: { data: MindData }) {
  return (
    <>
      <div className="mm-overall">
        <span>{data.title}</span>
        <span className="mm-overall-count">{data.events.length} momentos</span>
      </div>
      <ol className="mm-timeline">
        {data.events.map((e, i) => (
          <li
            className="mm-tl"
            key={i}
            style={{ '--branch': BRANCH_COLORS[i % BRANCH_COLORS.length] } as CSSProperties}
          >
            <div className="mm-tl-marker">
              {e.date
                ? <span className="mm-tl-date">{e.date}</span>
                : <span className="mm-tl-num">{i + 1}</span>}
            </div>
            <div className="mm-tl-body">
              <div className="mm-tl-title">{e.label}</div>
              {e.detail && <p className="mm-branch-detail">{e.detail}</p>}
              {e.points.length > 0 && (
                <ul className="mm-points">
                  {e.points.map((p, j) => <li key={j}>{p}</li>)}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

function GlossaryView({ data }: { data: MindData }) {
  return (
    <>
      <div className="mm-overall">
        <span>{data.title}</span>
        <span className="mm-overall-count">{data.terms.length} términos</span>
      </div>
      <div className="mm-glossary">
        {data.terms.map((t, i) => (
          <div
            className="mm-term"
            key={i}
            style={{ '--branch': BRANCH_COLORS[i % BRANCH_COLORS.length] } as CSSProperties}
          >
            <div className="mm-term-name">{t.term}</div>
            <p className="mm-term-def">{t.definition}</p>
            {t.points.length > 0 && (
              <ul className="mm-points">
                {t.points.map((p, j) => <li key={j}>{p}</li>)}
              </ul>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function CauseView({ data }: { data: MindData }) {
  return (
    <>
      <div className="mm-overall">
        <span>{data.title}</span>
        <span className="mm-overall-count">{data.causes.length} causas</span>
      </div>
      <ul className="mm-causes">
        {data.causes.map((c, i) => (
          <li
            className="mm-cause"
            key={i}
            style={{ '--branch': BRANCH_COLORS[i % BRANCH_COLORS.length] } as CSSProperties}
          >
            <div className="mm-cause-main">
              <span className="mm-tag">Causa</span>
              <div className="mm-cause-label">{c.label}</div>
              {c.detail && <p className="mm-branch-detail">{c.detail}</p>}
            </div>
            <span className="mm-arrow" aria-hidden="true">➜</span>
            <div className="mm-effect-main">
              <span className="mm-tag">Efectos</span>
              {c.effects.length > 0
                ? (
                  <ul className="mm-points">
                    {c.effects.map((e, j) => <li key={j}>{e}</li>)}
                  </ul>
                )
                : <p className="mm-branch-detail">—</p>}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function SolutionView({ data }: { data: MindData }) {
  return (
    <>
      <div className="mm-overall">
        <span>{data.title}</span>
        <span className="mm-overall-count">{data.problems.length} problemas</span>
      </div>
      <ul className="mm-problems">
        {data.problems.map((p, i) => (
          <li
            className="mm-problem"
            key={i}
            style={{ '--branch': BRANCH_COLORS[i % BRANCH_COLORS.length] } as CSSProperties}
          >
            <div className="mm-problem-main">
              <span className="mm-tag">Problema</span>
              <div className="mm-problem-label">{p.label}</div>
              {p.detail && <p className="mm-branch-detail">{p.detail}</p>}
            </div>
            <div className="mm-solution-main">
              <span className="mm-tag mm-tag-ok">Solución</span>
              {p.solutions.length > 0
                ? (
                  <ul className="mm-points">
                    {p.solutions.map((s, j) => <li key={j}>{s}</li>)}
                  </ul>
                )
                : <p className="mm-branch-detail">—</p>}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function MindmapView({ mm }: { mm: any }) {
  const data = normalizeMindmap(mm);
  if (!data) return null;

  let body: ReactNode;
  switch (data.layout) {
    case 'comparison': body = <ComparisonView data={data} />; break;
    case 'steps': body = <StepsView data={data} />; break;
    case 'timeline': body = <TimelineView data={data} />; break;
    case 'glossary': body = <GlossaryView data={data} />; break;
    case 'cause': body = <CauseView data={data} />; break;
    case 'solution': body = <SolutionView data={data} />; break;
    default: body = <TopicsView data={data} />;
  }

  return <div className="mindmap">{body}</div>;
}

function serverAudioUrl(audioPath?: string | null): string | null {
  if (!audioPath) return null;
  return `${API}/files/${audioPath.split(/[\\/]/).pop()}`;
}

/** El backend resume en segundo plano (202). Esperamos a que termine. */
async function waitForSummary(serverId: string, timeoutMs = 12 * 60 * 1000): Promise<Recording> {
  const start = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500));
    const res = await fetch(`${API}/recordings/${serverId}`);
    if (!res.ok) throw new Error(`No se pudo consultar el resumen (HTTP ${res.status})`);
    const detail: Recording = await res.json();
    if (detail.summary) return detail;
    if (detail.status === 'error') throw new Error(detail.error || 'No se pudo resumir');
    if (Date.now() - start > timeoutMs) {
      throw new Error('El resumen está tardando demasiado. Probá de nuevo en unos minutos.');
    }
  }
}

function localMatches(local: LocalNote, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (local.title.toLowerCase().includes(needle)) return true;
  return local.transcript.some((s) => s.text.toLowerCase().includes(needle));
}

function mergeNotes(server: Recording[], locals: LocalNote[], q: string, serverOk: boolean): NoteView[] {
  const byServer = new Map(server.map((s) => [s.id, s]));
  const used = new Set<string>();
  const merged: NoteView[] = [];

  for (const local of locals) {
    if (local.serverId && byServer.has(local.serverId)) {
      const s = byServer.get(local.serverId)!;
      used.add(s.id);
      merged.push({
        ...s,
        localId: local.id,
        serverId: s.id,
        title: s.title || local.title,
        status: s.status || local.status,
        error: s.summary ? undefined : (s.error || local.error),
        transcript: s.transcript?.length ? s.transcript : local.transcript,
        summary: s.summary ?? local.summary,
        mindmap: s.mindmap ?? local.mindmap,
        createdAt: s.createdAt || local.createdAt,
        hasLocalAudio: local.hasAudio,
        hasServerAudio: !!s.audioPath,
      });
      continue;
    }

    // Si la lista del servidor se cargó bien y la nota mapeada no aparece, es
    // porque el servidor la borró o porque no coincide con la búsqueda.
    if (local.serverId && serverOk) {
      if (!localMatches(local, q)) continue;
      merged.push({
        id: local.id,
        localId: local.id,
        serverId: local.serverId,
        title: local.title,
        status: local.status,
        error: local.error,
        audioPath: null,
        transcript: local.transcript,
        summary: local.summary,
        mindmap: local.mindmap,
        createdAt: local.createdAt,
        hasLocalAudio: local.hasAudio,
        hasServerAudio: false,
      });
      continue;
    }

    if (!localMatches(local, q)) continue;
    merged.push({
      id: local.id,
      localId: local.id,
      serverId: local.serverId || undefined,
      title: local.title,
      status: local.status,
      error: local.error,
      audioPath: null,
      transcript: local.transcript,
      summary: local.summary,
      mindmap: local.mindmap,
      createdAt: local.createdAt,
      hasLocalAudio: local.hasAudio,
      hasServerAudio: false,
    });
  }

  for (const s of server) {
    if (used.has(s.id)) continue;
    merged.push({
      ...s,
      serverId: s.id,
      hasLocalAudio: false,
      hasServerAudio: !!s.audioPath,
    });
  }

  return merged.sort((a, b) => {
    const at = a.createdAt || '';
    const bt = b.createdAt || '';
    return at < bt ? 1 : at > bt ? -1 : 0;
  });
}

function noteNeedsAnalysis(note: NoteView): boolean {
  return !note.summary || note.transcript.length === 0;
}

export default function App() {
  const [serverNotes, setServerNotes] = useState<Recording[]>([]);
  const [locals, setLocals] = useState<LocalNote[]>([]);
  const [serverOk, setServerOk] = useState(true);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<NoteView | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [rec, setRec] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeSeg, setActiveSeg] = useState<number>(-1);
  const [error, setError] = useState<string | null>(null);
  const mr = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const localList = await listLocalNotes().catch(() => [] as LocalNote[]);
    setLocals(localList);
    try {
      const r = await fetch(`${API}/recordings?q=${encodeURIComponent(q)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const serverList: Recording[] = Array.isArray(data) ? data : [];
      setServerNotes(serverList);
      setServerOk(true);

      // Persistir en IndexedDB el resumen y la transcripción que ya están en el
      // servidor, para que sigan disponibles sin conexión.
      const byId = new Map(serverList.map((s) => [s.id, s]));
      let changed = false;
      const synced = localList.map((local) => {
        const s = local.serverId ? byId.get(local.serverId) : undefined;
        if (!s) return local;
        const next: LocalNote = {
          ...local,
          title: s.title || local.title,
          status: s.status || local.status,
          error: s.summary ? undefined : (s.error ?? local.error),
          transcript: s.transcript?.length ? s.transcript : local.transcript,
          summary: s.summary ?? local.summary,
          mindmap: s.mindmap ?? local.mindmap,
        };
        if (JSON.stringify(next) !== JSON.stringify(local)) changed = true;
        return next;
      });
      if (changed) {
        await Promise.all(synced.map((l, i) => (l !== localList[i] ? saveLocalNote(l) : Promise.resolve())));
        setLocals(synced);
      }
    } catch {
      setServerNotes([]);
      setServerOk(false);
    }
  }, [q]);

  useEffect(() => { load(); }, [load]);

  const list = useMemo(
    () => mergeNotes(serverNotes, locals, q, serverOk),
    [serverNotes, locals, q, serverOk],
  );

  const refreshLocals = async () => {
    setLocals(await listLocalNotes());
  };

  const releaseObjectUrl = () => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  };

  const chooseAudio = async (note: NoteView) => {
    releaseObjectUrl();
    if (note.localId && note.hasLocalAudio) {
      const blob = await getAudio(note.localId);
      if (blob) {
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;
        setAudioUrl(url);
        return;
      }
    }
    setAudioUrl(serverAudioUrl(note.audioPath));
  };

  const toggleRec = async () => {
    setError(null);
    if (rec) {
      mr.current?.stop();
      setRec(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const m = new MediaRecorder(stream, { mimeType: mime });
      chunks.current = [];
      m.ondataavailable = (e) => { if (e.data.size > 0) chunks.current.push(e.data); };
      m.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: m.mimeType || 'audio/webm' });
        chunks.current = [];
        if (blob.size === 0) {
          setError('La grabación quedó vacía');
          return;
        }
        const localId = `local_${Date.now()}`;
        const note: LocalNote = {
          id: localId,
          serverId: null,
          title: 'Nota ' + new Date().toLocaleString(),
          createdAt: new Date().toISOString(),
          status: 'local',
          transcript: [],
          summary: null,
          mindmap: null,
          hasAudio: true,
        };
        try {
          await saveAudio(localId, blob);
          await saveLocalNote(note);
          await refreshLocals();
        } catch (e: any) {
          setError('No se pudo guardar la grabación en este dispositivo: ' + (e?.message || e));
        }
      };
      m.start(1000);
      mr.current = m;
      setRec(true);
    } catch (e: any) {
      setError('No se pudo acceder al micrófono: ' + (e?.message || e));
    }
  };

  const open = async (note: NoteView) => {
    setAnswer('');
    setActiveSeg(-1);
    let view = note;

    if (note.serverId) {
      try {
        const r = await fetch(`${API}/recordings/${note.serverId}`);
        if (r.ok) {
          const detail: Recording = await r.json();
          view = {
            ...note,
            ...detail,
            localId: note.localId,
            serverId: note.serverId,
            hasLocalAudio: note.hasLocalAudio,
            hasServerAudio: !!detail.audioPath,
            title: detail.title || note.title,
          };
        } else if (r.status === 404) {
          view = {
            ...note,
            status: note.localId ? 'local' : 'error',
            error: note.localId ? undefined : 'La nota ya no existe en el servidor',
          };
        }
      } catch {
        // Sin red: usamos la copia local si existe.
      }
    }

    setSel(view);
    await chooseAudio(view);
    if (window.innerWidth < 900) {
      setTimeout(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    }
  };

  const close = () => {
    setSel(null);
    setAnswer('');
    setActiveSeg(-1);
    setAudioUrl(null);
    releaseObjectUrl();
    if (audioRef.current) audioRef.current.pause();
  };

  const toggle = async (note: NoteView) => {
    if (sel && (sel.localId === note.localId && sel.serverId === note.serverId)) {
      close();
      return;
    }
    await open(note);
  };

  const uploadBlob = async (local: LocalNote, blob: Blob): Promise<Recording> => {
    const fd = new FormData();
    fd.append('audio', blob, 'nota.webm');
    fd.append('title', local.title);
    const r = await fetch(`${API}/recordings`, { method: 'POST', body: fd });
    if (!r.ok) throw new Error(`No se pudo subir el audio (HTTP ${r.status})`);
    return r.json();
  };

  const uploadAudioToServer = async (serverId: string, blob: Blob) => {
    const fd = new FormData();
    fd.append('audio', blob, 'nota.webm');
    const r = await fetch(`${API}/recordings/${serverId}/audio`, { method: 'POST', body: fd });
    if (!r.ok) throw new Error(`No se pudo re-subir el audio (HTTP ${r.status})`);
    return r.json();
  };

  const analyze = async (note: NoteView) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setAnswer('');
    let local: LocalNote | undefined;
    try {
      local = note.localId ? await getLocalNote(note.localId) : undefined;
      let serverId = note.serverId || local?.serverId || null;
      let detail: Recording | null = null;

      if (!serverId) {
        if (!local) throw new Error('Esta nota no está en este dispositivo. No hay audio para analizar.');
        const blob = await getAudio(local.id);
        if (!blob) throw new Error('El audio local ya fue liberado. No se puede analizar sin audio.');
        local = { ...local, status: 'uploading', error: undefined };
        await saveLocalNote(local);
        await refreshLocals();
        const created = await uploadBlob(local, blob);
        serverId = created.id;
        detail = created;
        local = { ...local, serverId, status: created.status || 'queued' };
        await saveLocalNote(local);
        await refreshLocals();
      }

      const needsTranscribe = !note.transcript.length;
      if (needsTranscribe) {
        if (!note.hasServerAudio && !note.audioPath && local?.hasAudio) {
          const blob = await getAudio(local.id);
          if (!blob) throw new Error('El audio local ya fue liberado.');
          detail = await uploadAudioToServer(serverId, blob);
        }
        const r = await fetch(`${API}/recordings/${serverId}/transcribe`, { method: 'POST' });
        if (!r.ok) throw new Error(await r.text() || `Error al transcribir (HTTP ${r.status})`);
        detail = await r.json();
      }

      if (!note.summary || needsTranscribe) {
        const r = await fetch(`${API}/recordings/${serverId}/summarize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ template: 'class' }),
        });
        if (!r.ok) throw new Error(await r.text() || `Error al resumir (HTTP ${r.status})`);
        const started: Recording = await r.json();
        if (started.status === 'summarizing') {
          setServerNotes((prev) => prev.map((s) => (s.id === serverId ? { ...s, status: 'summarizing', error: undefined } : s)));
          setSel((prev) => (prev ? { ...prev, status: 'summarizing' } : prev));
          detail = await waitForSummary(serverId);
        } else {
          detail = started;
        }
      }

      if (!detail) {
        const r = await fetch(`${API}/recordings/${serverId}`);
        if (r.ok) detail = await r.json();
      }

      if (local && detail) {
        local = {
          ...local,
          serverId,
          title: detail.title || local.title,
          status: detail.status || 'ready',
          error: detail.error,
          transcript: detail.transcript || local.transcript,
          summary: detail.summary ?? local.summary,
          mindmap: detail.mindmap ?? local.mindmap,
        };
        await saveLocalNote(local);
        await refreshLocals();
      }

      await load();
      if (detail && serverId) {
        const view: NoteView = {
          ...detail,
          serverId,
          localId: local?.id,
          hasLocalAudio: !!local?.hasAudio,
          hasServerAudio: !!detail.audioPath,
        };
        setSel(view);
        await chooseAudio(view);
      }
    } catch (e: any) {
      setError(e?.message || 'No se pudo analizar la nota');
      if (local) {
        const failed = { ...local, status: 'error', error: e?.message || 'Error de análisis' };
        await saveLocalNote(failed).catch(() => {});
        await refreshLocals().catch(() => {});
      }
    } finally {
      setBusy(false);
    }
  };

  const summarize = async () => {
    if (!sel) return;
    if (!sel.serverId) {
      await analyze(sel);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${API}/recordings/${sel.serverId}/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: 'class' }),
      });
      if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
      const started: Recording = await r.json();
      if (started.status === 'summarizing') {
        setServerNotes((prev) => prev.map((s) => (s.id === sel.serverId ? { ...s, status: 'summarizing', error: undefined } : s)));
        setSel({ ...sel, status: 'summarizing' });
      }
      const detail = started.status === 'summarizing'
        ? await waitForSummary(sel.serverId)
        : started;
      await syncLocal(sel.serverId, detail);
      setSel({ ...sel, ...detail, hasServerAudio: !!detail.audioPath });
      await load();
    } catch (e: any) {
      setError(e?.message || 'No se pudo resumir');
    } finally {
      setBusy(false);
    }
  };

  const syncLocal = async (serverId: string, detail: Recording) => {
    const local = locals.find((l) => l.serverId === serverId);
    if (!local) return;
    const updated: LocalNote = {
      ...local,
      title: detail.title || local.title,
      status: detail.status || local.status,
      error: detail.error,
      transcript: detail.transcript || local.transcript,
      summary: detail.summary ?? local.summary,
      mindmap: detail.mindmap ?? local.mindmap,
    };
    await saveLocalNote(updated);
    await refreshLocals();
  };

  const ask = async () => {
    if (!sel?.serverId) {
      setError('Analizá la nota primero para poder preguntarle a ApIA.');
      return;
    }
    if (!question.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${API}/recordings/${sel.serverId}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setAnswer(j.answer || 'Sin respuesta.');
    } catch (e: any) {
      setError(e?.message || 'No se pudo preguntar a ApIA');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!sel) return;
    if (!confirm(`¿Eliminar "${sel.title}"? Se borrará también el audio guardado en este dispositivo.`)) return;
    setBusy(true);
    setError(null);
    try {
      if (sel.serverId) {
        const r = await fetch(`${API}/recordings/${sel.serverId}`, { method: 'DELETE' });
        if (!r.ok && r.status !== 404) throw new Error(`No se pudo eliminar del servidor (HTTP ${r.status})`);
      }
      if (sel.localId) await deleteLocalNote(sel.localId);
      close();
      await load();
    } catch (e: any) {
      setError(e?.message || 'No se pudo eliminar la nota');
    } finally {
      setBusy(false);
    }
  };

  const releaseAudio = async () => {
    if (!sel?.localId || !sel.hasLocalAudio) return;
    if (!confirm('Se borrará el audio guardado en este dispositivo. La transcripción, el resumen y el mapa se conservan. ¿Continuar?')) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAudio(sel.localId);
      const local = await getLocalNote(sel.localId);
      if (local) {
        await saveLocalNote({ ...local, hasAudio: false });
        await refreshLocals();
      }
      setSel({ ...sel, hasLocalAudio: false });
      setAudioUrl(null);
      releaseObjectUrl();
    } catch (e: any) {
      setError(e?.message || 'No se pudo liberar el audio');
    } finally {
      setBusy(false);
    }
  };

  const seek = (start: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = start;
      audioRef.current.play();
    }
  };

  const onTimeUpdate = (e: SyntheticEvent<HTMLAudioElement>) => {
    const t = e.currentTarget.currentTime;
    if (!sel) return;
    const idx = sel.transcript.findIndex((s) => t >= s.start && t < s.end);
    setActiveSeg(idx);
  };

  return (
    <div className="app">
      <div className="header">
        <div className="brand">
          <h1>Lecmap</h1>
          <p className="tagline">Tus clases, en un mapa</p>
        </div>
        <button className={`btn ${rec ? 'btn-recording' : 'btn-primary'}`} onClick={toggleRec} disabled={busy}>
          {rec ? '■ Detener' : '● Grabar'}
        </button>
      </div>

      <div className="toolbar">
        <input
          className="search-input"
          placeholder="Buscar en transcripciones..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="btn btn-secondary" onClick={load} disabled={busy}>Buscar</button>
      </div>

      {error && (
        <div className="error-msg" style={{ marginBottom: 12 }}>
          {error}
          <button
            className="btn btn-secondary"
            style={{ marginLeft: 8, padding: '2px 8px' }}
            onClick={() => setError(null)}
          >
            ✕
          </button>
        </div>
      )}

      {busy && <div style={{ color: 'var(--text2)', fontSize: 13, marginBottom: 8 }}>Procesando…</div>}

      <div className="main-grid">
        <div className="sidebar">
          {!serverOk && locals.length === 0 && (
            <p style={{ color: 'var(--text2)', textAlign: 'center', marginTop: 20 }}>
              Sin conexión al servidor. Las notas locales se pueden grabar y analizar cuando vuelva la red.
            </p>
          )}
          {list.length === 0 && serverOk && (
            <p style={{ color: 'var(--text2)', textAlign: 'center', marginTop: 40 }}>Sin grabaciones aún</p>
          )}
          {list.map((note) => {
            const active = !!sel && sel.localId === note.localId && sel.serverId === note.serverId;
            return (
              <div
                key={note.serverId || note.localId || note.id}
                className={`rec-item ${active ? 'active' : ''}`}
                onClick={() => toggle(note)}
                role="button"
                tabIndex={0}
                aria-expanded={active}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(note); } }}
              >
                <div className="rec-title">{note.title}</div>
                <div className={`rec-status ${note.status}`}>
                  {note.serverId ? note.status : 'local'}
                  {note.hasLocalAudio ? ' · audio local' : ''}
                </div>
                {note.status === 'summarizing' ? (
                  <div style={{ marginTop: 8, color: 'var(--accent)', fontSize: 12 }}>
                    Resumiendo… puede tardar unos minutos
                  </div>
                ) : noteNeedsAnalysis(note) && (note.serverId || note.hasLocalAudio) ? (
                  <button
                    className="btn btn-secondary"
                    style={{ marginTop: 8, padding: '4px 10px', fontSize: 12 }}
                    disabled={busy}
                    onClick={(e) => { e.stopPropagation(); analyze(note); }}
                  >
                    {note.serverId ? 'Analizar' : 'Analizar (subir audio)'}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="detail" ref={detailRef}>
          {!sel && <div className="detail-empty">Elegí una grabación o grabá una nueva</div>}
          {sel && (
            <>
              <div className="detail-header">
                <h2>{sel.title}</h2>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className={`status-badge ${sel.status}`}>{sel.serverId ? sel.status : 'local'}</span>
                  <button className="btn btn-secondary" onClick={close} title="Cerrar detalle">Cerrar ✕</button>
                  <button className="btn btn-danger" onClick={remove} disabled={busy || sel.status === 'summarizing'}>Eliminar nota</button>
                </div>
              </div>

              {sel.error && <div className="error-msg">{sel.error}</div>}

              {sel.status === 'summarizing' && (
                <div className="summary-box" style={{ color: 'var(--accent)', marginBottom: 12 }}>
                  Resumiendo la clase en segundo plano… puede tardar unos minutos. Podés seguir usando la app.
                </div>
              )}

              <div className="player">
                {audioUrl
                  ? <audio ref={audioRef} controls onTimeUpdate={onTimeUpdate} src={audioUrl} />
                  : (
                    <div className="summary-box" style={{ color: 'var(--text2)' }}>
                      Audio no disponible en este dispositivo.
                      {sel.hasLocalAudio && ' (el audio local no se pudo abrir)'}
                    </div>
                  )}
              </div>

              <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                {sel.serverId || sel.hasLocalAudio ? (
                  <button className="btn btn-primary" onClick={() => analyze(sel)} disabled={busy || sel.status === 'summarizing'}>
                    {sel.serverId ? 'Analizar de nuevo' : 'Analizar (subir audio)'}
                  </button>
                ) : (
                  <span style={{ color: 'var(--text2)', fontSize: 13, alignSelf: 'center' }}>
                    Audio liberado: no queda audio para reanalizar.
                  </span>
                )}
                {sel.transcript.length > 0 && (
                  <button className="btn btn-secondary" onClick={summarize} disabled={busy || sel.status === 'summarizing'}>Resumir</button>
                )}
                {sel.hasLocalAudio && (
                  <button className="btn btn-secondary" onClick={releaseAudio} disabled={busy || sel.status === 'summarizing'}>Liberar audio</button>
                )}
              </div>

              {sel.transcript.length > 0 && (
                <div className="transcript">
                  {sel.transcript.map((s, i) => (
                    <div key={i} className={`transcript-segment ${activeSeg === i ? 'active' : ''}`} onClick={() => seek(s.start)}>
                      <div className="segment-time">{fmtTime(s.start)} - {fmtTime(s.end)}</div>
                      <div className="segment-speaker">{s.speaker}</div>
                      <div className="segment-text">{s.text}</div>
                    </div>
                  ))}
                </div>
              )}

              {sel.summary && (
                <div className="section">
                  <h3>Resumen</h3>
                  <div className="summary-box">{sel.summary}</div>
                </div>
              )}

              {sel.mindmap && (
                <div className="section">
                  <h3>Mapa de ideas</h3>
                  <MindmapView mm={sel.mindmap} />
                </div>
              )}

              <div className="section">
                <h3>Preguntar a ApIA</h3>
                <div className="qa-section">
                  <input
                    className="qa-input"
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder="Preguntale a ApIA… ¿Cuáles fueron las conclusiones?"
                  />
                  <button className="btn btn-primary" onClick={ask} disabled={busy}>Preguntar</button>
                </div>
                {answer && <div className="answer-box">{answer}</div>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
