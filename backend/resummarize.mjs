const API = 'http://localhost:3001';
const id = process.argv[2];
if (!id) {
  console.log('uso: node resummarize.mjs <id> [template]');
  process.exit(1);
}
const template = process.argv[3] || 'class';
const s = await (await fetch(`${API}/recordings/${id}/summarize`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ template }),
})).json();
const mm = s.mindmap || {};
const counts = {
  topics: mm.topics?.length || 0,
  items: mm.items?.length || 0,
  steps: mm.steps?.length || 0,
  events: mm.events?.length || 0,
  terms: mm.terms?.length || 0,
  causes: mm.causes?.length || 0,
  problems: mm.problems?.length || 0,
};
console.log(`id=${id} layout=${mm.layout} ${JSON.stringify(counts)}`);
console.log(`title="${mm.title}"`);
if (mm.terms) console.log(JSON.stringify(mm.terms.map((t) => t.term)));
