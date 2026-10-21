import { useEffect, useRef, useState, useCallback } from 'react';
import type { CSSProperties, ReactNode, SyntheticEvent } from 'react';
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

export default function App() {
  const [list, setList] = useState<Recording[]>([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Recording | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [rec, setRec] = useState(false);
  const [activeSeg, setActiveSeg] = useState<number>(-1);
  const mr = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`${API}/recordings?q=${encodeURIComponent(q)}`);
    setList(await r.json());
  }, [q]);

  useEffect(() => { load(); }, [load]);

  const toggleRec = async () => {
    if (rec) {
      mr.current?.stop();
      setRec(false);
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const m = new MediaRecorder(stream);
    chunks.current = [];
    m.ondataavailable = (e) => chunks.current.push(e.data);
    m.onstop = async () => {
      const blob = new Blob(chunks.current, { type: m.mimeType });
      const fd = new FormData();
      fd.append('audio', blob, 'nota.webm');
      fd.append('title', 'Nota ' + new Date().toLocaleString());
      await fetch(`${API}/recordings`, { method: 'POST', body: fd });
      load();
    };
    m.start();
    mr.current = m;
    setRec(true);
  };

  const open = async (id: string) => {
    const r = await fetch(`${API}/recordings/${id}`);
    setSel(await r.json());
    setAnswer('');
    setActiveSeg(-1);
  };

  const close = () => {
    setSel(null);
    setAnswer('');
    setActiveSeg(-1);
    if (audioRef.current) audioRef.current.pause();
  };

  const toggle = async (id: string) => {
    if (sel?.id === id) {
      close();
      return;
    }
    await open(id);
    if (window.innerWidth < 900) {
      setTimeout(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    }
  };

  const transcribe = async () => {
    if (!sel) return;
    const r = await fetch(`${API}/recordings/${sel.id}/transcribe`, { method: 'POST' });
    setSel(await r.json());
    load();
  };

  const summarize = async () => {
    if (!sel) return;
    await fetch(`${API}/recordings/${sel.id}/summarize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: 'meeting' })
    });
    open(sel.id);
    load();
  };

  const ask = async () => {
    if (!sel) return;
    const r = await fetch(`${API}/recordings/${sel.id}/ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question })
    });
    const j = await r.json();
    setAnswer(j.answer);
  };

  const remove = async () => {
    if (!sel) return;
    if (!confirm(`¿Eliminar "${sel.title}"?`)) return;
    await fetch(`${API}/recordings/${sel.id}`, { method: 'DELETE' });
    setSel(null);
    setAnswer('');
    load();
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
        <button className={`btn ${rec ? 'btn-recording' : 'btn-primary'}`} onClick={toggleRec}>
          {rec ? '■ Detener' : '● Grabar'}
        </button>
      </div>

      <div className="toolbar">
        <input className="search-input" placeholder="Buscar en transcripciones..." value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-secondary" onClick={load}>Buscar</button>
      </div>

      <div className="main-grid">
        <div className="sidebar">
          {list.length === 0 && <p style={{ color: 'var(--text2)', textAlign: 'center', marginTop: 40 }}>Sin grabaciones aún</p>}
          {list.map((r) => (
            <div
              key={r.id}
              className={`rec-item ${sel?.id === r.id ? 'active' : ''}`}
              onClick={() => toggle(r.id)}
              role="button"
              tabIndex={0}
              aria-expanded={sel?.id === r.id}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(r.id); } }}
            >
              <div className="rec-title">{r.title}</div>
              <div className={`rec-status ${r.status}`}>{r.status}</div>
            </div>
          ))}
        </div>

        <div className="detail" ref={detailRef}>
          {!sel && <div className="detail-empty">Elegí una grabación o grabá una nueva</div>}
          {sel && (
            <>
              <div className="detail-header">
                <h2>{sel.title}</h2>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className={`status-badge ${sel.status}`}>{sel.status}</span>
                  <button className="btn btn-secondary" onClick={close} title="Cerrar detalle">Cerrar ✕</button>
                  <button className="btn btn-danger" onClick={remove}>Eliminar</button>
                </div>
              </div>

              {sel.error && <div className="error-msg">{sel.error}</div>}

              <div className="player">
                <audio ref={audioRef} controls onTimeUpdate={onTimeUpdate} src={sel.audioPath ? `${API}/files/${sel.audioPath.split(/[\\/]/).pop()}` : undefined} />
              </div>

              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <button className="btn btn-primary" onClick={transcribe}>Transcribir</button>
                <button className="btn btn-secondary" onClick={summarize}>Resumir</button>
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
                  <input className="qa-input" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Preguntale a ApIA… ¿Cuáles fueron las conclusiones?" />
                  <button className="btn btn-primary" onClick={ask}>Preguntar</button>
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
