const API = 'http://localhost:3001';

const list = await (await fetch(`${API}/recordings`)).json();
console.log('RECORDINGS:', list.length);
for (const r of list) {
  console.log(`- ${r.id} | ${r.title} | ${r.status} | segments=${r.transcript.length} | summary=${!!r.summary}`);
}

const first = list.find((r) => r.audioPath);
if (first) {
  const name = first.audioPath.split(/[\\/]/).pop();
  const res = await fetch(`${API}/files/${name}`);
  const buf = await res.arrayBuffer();
  console.log(`FILE: ${res.status} ${res.headers.get('content-type')} bytes=${buf.byteLength} name=${name}`);
}

const q = await (await fetch(`${API}/recordings?q=green`)).json();
console.log('SEARCH green:', q.length);
