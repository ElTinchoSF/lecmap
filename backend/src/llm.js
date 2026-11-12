// Adaptador LLM con dos proveedores intercambiables:
//   - gemini: free tier de Google (250K TPM) → sin pacer
//   - groq:   plan gratis (8K TPM)           → con pacer TPM_BUDGET
// El proveedor se resuelve por llamada (no al importar) para que los tests
// y los cambios de env en runtime no queden congelados.

const chatWindow = [];
// Presupuesto de tokens por minuto SOLO para groq free (8000 TPM reales).
const TPM_BUDGET = Number(process.env.TPM_BUDGET || 7000);

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 3.5);
}

function estimateMessagesTokens(messages) {
  return messages.reduce((n, m) => n + estimateTokens(m.content) + 8, 0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pacer de ventana deslizante (solo groq). Rechaza de inmediato pedidos que
 * no entran en el presupuesto de un minuto y espera antes de mandar otros.
 */
async function paceGroq(messages, maxTokens) {
  const estimated = estimateMessagesTokens(messages) + maxTokens;
  if (estimated > TPM_BUDGET) {
    throw new Error(`Pedido demasiado grande (${estimated} tokens); hay que dividir la transcripción`);
  }
  for (;;) {
    const now = Date.now();
    while (chatWindow.length && now - chatWindow[0].at > 60_000) chatWindow.shift();
    const used = chatWindow.reduce((n, u) => n + u.tokens, 0);
    if (used + estimated <= TPM_BUDGET) {
      chatWindow.push({ at: now, tokens: estimated });
      return;
    }
    const wait = 60_000 - (now - chatWindow[0].at) + 500;
    await sleep(Math.max(wait, 1000));
  }
}

/** Resuelve el proveedor actual. Lanza si falta la clave. */
function resolveProvider() {
  const explicit = (process.env.LLM_PROVIDER || '').trim().toLowerCase();
  const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
  const groqKey = (process.env.OPENAI_API_KEY || '').trim();

  let provider = explicit;
  if (!provider) provider = geminiKey ? 'gemini' : 'groq';

  if (provider === 'gemini') {
    if (!geminiKey) throw new Error('Falta GEMINI_API_KEY (o setee LLM_PROVIDER=groq con OPENAI_API_KEY)');
    return {
      name: 'gemini',
      baseUrl: (process.env.LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, ''),
      key: geminiKey,
      model: process.env.LLM_MODEL || 'gemini-2.5-flash',
      maxTokensField: 'max_tokens',
      paced: false,
    };
  }
  if (provider !== 'groq') {
    throw new Error(`LLM_PROVIDER desconocido: "${provider}" (use "gemini" o "groq")`);
  }
  if (!groqKey) throw new Error('Falta OPENAI_API_KEY (o setee LLM_PROVIDER=gemini con GEMINI_API_KEY)');
  return {
    name: 'groq',
    baseUrl: (process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
    key: groqKey,
    model: process.env.LLM_MODEL || process.env.CHAT_MODEL || 'openai/gpt-oss-120b',
    maxTokensField: 'max_completion_tokens',
    paced: true,
  };
}

/** ¿Hay un proveedor LLM configurado? (para chequeos de endpoints) */
export function llmAvailable() {
  try {
    resolveProvider();
    return true;
  } catch {
    return false;
  }
}

/** Info para GET /health. */
export function llmInfo() {
  try {
    const p = resolveProvider();
    return { ok: true, provider: p.name, model: p.model };
  } catch (e) {
    return { ok: false, provider: null, model: null, error: e.message };
  }
}

/**
 * Chat completion multi-proveedor. Misma firma que el openaiChat anterior:
 * devuelve el string de content.
 */
export async function chat(messages, { json = false, maxTokens = 3000 } = {}) {
  const p = resolveProvider();
  if (p.paced) await paceGroq(messages, maxTokens);

  const body = {
    model: p.model,
    messages,
    [p.maxTokensField]: maxTokens,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
    // Gemini cuenta los tokens de pensamiento dentro de max_tokens: con el
    // presupuesto por defecto el corte llega a truncar la respuesta visible
    // entera (resumen de71 min guardado en643 chars a mitad de frase).
    ...(p.name === 'gemini' ? { reasoning_effort: 'low' } : {}),
  };

  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 150_000);
  let res;
  try {
    res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    const err = new Error(
      timedOut ? `AI chat: timeout tras ${timeoutMs} ms` : `AI chat: ${e.message}`,
    );
    err.upstream = true;
    throw err;
  }
  if (!res.ok) throw new Error(`AI chat error: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return j.choices[0].message.content;
}
