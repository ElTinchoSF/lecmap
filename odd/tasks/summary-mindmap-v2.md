# Feature: summary-mindmap-v2

Objetivo: quitar los topes del resumen de clases (escalonado por duración + sin perder fragmentos) y pasar el mindmap a secciones multi-layout por tema central.
Branch: `feat/summary-mindmap-v2` (base `cc9b8bc` = origin/main). Delivery: work-unit commits en la rama; push/PR decisión del usuario. Runner: backend `node --test` (nuevo script `npm test`), Android `gradle testDebugUnitTest`, web `npx tsc --noEmit && npx vite build`. Forecast: ~450-550 líneas authored → pedir chain strategy al acercarse a 400.

## Specs

### S1 — Resumen escalonado por duración
Verbatim (pedido 1): "El resumen de cada grabación, tiene un tope de cantidad de palabras? si es así, hay que sacarlo, ya que habitualmente las clases son de 2 horas, imposible hacer un resumen de dos horas de clase con un tope de cantidad de palabras, o bien dame opciones fundamentadas para establecer cantidad de palabras de resumen de acuerdo a la duración de la grabación."
Opción A aprobada: tope escalonado `frases = clamp(round(minutos × 0.4), 6, 70)` calculado desde la duración del transcript; reemplaza "El summary debe ser un resumen de estudio de 3 a 6 frases." (base index.js:738). Fundamento: 2h ≈ 16-19k palabras habladas → 48 frases ≈ 700-800 palabras ≈ 4-5% de compresión (rango de estudio 3-10%).
Aceptación: la fórmula vive como función pura con unit test RED→GREEN; el prompt final pide el objetivo de frases según duración; no queda el cap "3 a 6 frases"; 10 min → 6 (piso), 120 min → 48, 180+ min → 70 (techo).

### S2 — Ningún fragmento se pierde (eliminar slice de 7000 chars)
Verbatim (pedido 1): "hay que sacarlo". Diagnóstico registrado: `material.slice(0, 7000)` (base index.js:758-759) descarta el FINAL de clases largas. Reemplazo: resumen jerárquico multi-pasada — agrupar los resúmenes de chunks en grupos ≤ 6000 chars, condensar cada grupo con un call propio, e iterar hasta que el material final entre en el presupuesto; ningún fragmento se descarta. Presupuesto real: Groq free 8000 TPM con gpt-oss-120b (base index.js:89,177,634).
Aceptación: no existe `slice(0, 7000)`; para transcript simulada de 2h (12+ chunks) el material final conserva información del ÚLTIMO chunk; cada llamada individual queda por debajo del presupuesto TPM (tokens de entrada + maxTokens de salida < ~8k); unit test del agrupador/condensador con LLM simulado.

### S3 — Un layout por tema central, no uno por transcripción
Verbatim (pedido 2): "La app funciona bastante bien detectando temas centrales, lo que yo quiero sabes es si cada tema central es tratado individualmente y se lo analiza con el tipo correspondiente de mindmap o si se establece un solo tipo de mindmap por transcripción. Porque lo ideal es que cada tema central o fragmento de transcripción esté sujeto al análisis y representación representativa de su contenido. Si sólo se usa un estilo de mindmap, no serviría de mucho la app."
Schema v2: `mindmap.sections: [{ title, layout, ...payload }]` con `layout ∈ topics|comparison|steps|timeline|glossary|cause|solution` por sección.
Aceptación: (a) el prompt pide secciones con layout propio por tema/fragmento; (b) `normalizeMindmap` acepta v2 y sigue aceptando el formato viejo single-layout (compat con notas existentes); (c) web `MindmapView` renderiza las secciones en orden, cada una con su componente; (d) Android renderiza igual; (e) tsc+vite y gradle test/assemble en verde.

### S4 — NotebookLM (diferida, fuera de este feature)
Tercera etapa aparte. Corrección del usuario verbatim (L3): "lo que quería implementar era NotebookLM, tenés razón, no es notionLM (que no existe)." La investigación y el diseño de integración con NotebookLM se documentan en L4 pero no forman parte de T1-T6.

## Tasks

- T1 [S1] inline — cálculo de duración del transcript + fórmula escalonada + prompt con objetivo de frases (backend). Estado: ✅ commit b353158 (RED observado ERR_MODULE_NOT_FOUND → GREEN 6/6 tests).
- T2 [S2] inline — jerarquía multi-pasada que reemplaza el slice de 7000 chars (backend). Estado: ✅ commits 6fc707a + fix 60b69af (RED observado export faltante → GREEN 11/11).
- T3 [S3] inline — schema `sections[]` + prompt multi-layout + `normalizeMindmap` v2 con compat (backend). Estado: ✅ commit 39caeca (RED observado ERR_MODULE_NOT_FOUND → GREEN 21/21; módulo extraído a backend/src/mindmap.js).
- T4 [S3] inline — render web multi-sección en `MindmapView`. Estado: ✅ commit d28d975 (sin test runner en web: verificado con tsc --noEmit + vite build verdes).
- T5 [S3] inline — render Android multi-sección. Estado: ✅ commit 77816b7 (RED observado compile error → GREEN testDebugUnitTest + assembleDebug; 7 tests nuevos en MindmapNormalizeTest.kt).
- T6 [S1-S3] inline — verificación final: unit tests backend, gradle testDebugUnitTest + assembleDebug, tsc + vite build; E2E device opcional. Estado: pendiente.

## Log

L1 (2026-10-28, verbatim): "antes de pushear nada quiero que revises algunas cosas:
1. El resumen de cada grabación, tiene un tope de cantidad de palabras? si es así, hay que sacarlo, ya que habitualmente las clases son de 2 horas, imposible hacer un resumen de dos horas de clase con un tope de cantidad de palabras, o bien dame opciones fundamentadas para establecer cantidad de palabras de resumen de acuerdo a la duración de la grabación.
2. La app funciona bastante bien detectando temas centrales, lo que yo quiero sabes es si cada tema central es tratado individualmente y se lo analiza con el tipo correspondiente de mindmap o si se establece un solo tipo de mindmap por transcripción. Porque lo ideal es que cada tema central o fragmento de transcripción esté sujeto al análisis y representación representativa de su contenido. Si sólo se usa un estilo de mindmap, no serviría de mucho la app.
3. Qué posibilidades hay de agregar una capa de interacción con NotionLM? dame ideas y buenas opciones si es que puede haberlas, siempre con fundamento."

L2 (2026-10-28): verificación read-only del pipeline. Hallazgos: (1) triple tope de resumen — prompt "3 a 6 frases" (index.js:738), `material.slice(0, 7000)` que descarta el final de clases largas (758-759), maxTokens 4000 (768); causa raíz = Groq plan gratis 8000 TPM con gpt-oss-120b (89, 177, 634), no la ventana del modelo (131k). (2) mindmap single-layout: un único `layout` por transcripción (712); "varios temas centrales" sólo existen dentro de "topics" (734); render switch único (web App.tsx:631-639; Android igual). (3) "NotionLM" no existe como producto. Plan recomendado: push del login primero, luego Opción A + multi-layout acá; integración de la etapa 3 después. Usuario: "Me gusta, vamos por ahí". Push de feat/login-header-google (7 commits) hecho a origin.

L3 (2026-10-28, corrección del usuario verbatim): "Continúa! y te agrego un dato para que investigues:
lo que quería implementar era NotebookLM, tenés razón, no es notionLM (que no existe)."
→ La etapa 3 investiga NotebookLM (producto de Google), no Notion. Detalle en L4.

L4 (2026-10-28): investigación NotebookLM (2 websearches). Hallazgos verificados:
- **Vía oficial (Enterprise)**: "Gemini Notebook Enterprise" (ex NotebookLM Enterprise) expone API REST v1alpha (Pre-GA) en Discovery Engine — `notebooks.create`, `sources.batchCreate`/`uploadFile`, share, etc. (docs.cloud.google.com/gemini/enterprise/notebooklm-enterprise). Requiere proyecto GCP + API Discovery Engine + IAM (`Cloud NotebookLM User`) + licencia. **Precio: trial 14-30 días y después $9 USD/licencia/mes, mínimo 15 licencias = USD 135/mes** — inviable para un usuario individual.
- **Vías no oficiales (community)**: SDKs que envuelven la API interna de notebooklm.google.com con la sesión del usuario (`notebooklm-py`, `notebooklm_sdk`, `notebooklm-rest-api` en GitHub): crear notebooks, agregar fuentes (texto/archivo/URL/Drive), `chat.ask`, generar artifacts — **Audio Overviews (podcast), quiz, y mind maps (`client.mind_maps.generate`, kinds INTERACTIVE y NOTE_BACKED con descarga de JSON)**. Riesgo: frágil, ToS gris, puede romper sin aviso.
- **Export manual (cero riesgo)**: LecMap genera un "class pack" (transcript.md + resumen.md + mindmap.md) que el usuario arrastra a notebooklm.google.com — sin costo, sin API.
Ideas etapa 3: (a) export class pack (MVP, sin costo); (b) integración via SDK no oficial con consentimiento explícito del usuario (riesgo asumido); (c) Enterprise sólo si algún día hay presupuesto institucional. Nota: los mind maps nativos de NotebookLM son de un solo estilo radial — el multi-layout de LecMap (S3) sigue siendo diferencial propio.

L5 (2026-10-28): T1 y T2 implementados con test-first. Nuevas funciones puras en `backend/src/summary.js` (`targetSummarySentences`, `transcriptDurationSeconds`, `groupPartsForMerge`, `condenseToFit`) con 11 tests en `backend/test/summary.test.js` (script `npm test` = `node --test`, Node v24). Hallazgo de integración: `paceChat` (index.js:~179, TPM_BUDGET 7000, estimación chars/3.5) rechaza pedidos > 7000 tokens estimados — `FINAL_MATERIAL_MAX_CHARS` bajó de 10_000 a 7_000 para que el call final (prompt ~650 + maxTokens 4000) pase el gate. Commits: b353158 (T1), 6fc707a (T2), 60b69af (fix gate). Running count ~190 líneas authored (< 400: sin chain strategy todavía).

L6 (2026-10-28): T3 implementado con test-first. El normalizador y el prompt del mindmap se extrajeron de index.js a `backend/src/mindmap.js` (exporta `normalizeMindmap`, `mindmapSystemPrompt`, `ALL_LAYOUTS`) para poder testear sin arrancar Fastify. `normalizeMindmap` ahora detecta `mm.sections[]` (v2: cada sección con su `title`+`layout` propio, secciones sin datos válidos se descartan, null si ninguna queda) y mantiene intacto el path single-layout viejo (compat con notas existentes y con respuestas del modelo que no apliquen v2). Prompt v2: schema `"sections": [{title, layout, ...payload}]`, instrucciones de dividir por tema central y elegir layout por sección; mantiene el objetivo escalonado de frases. Tests: `backend/test/mindmap.test.js` (10 tests) — total suite 21/21 GREEN. Gate paceChat verificado con el prompt nuevo: 6913/7000 estimados con material máximo (headroom 87 tokens — no hacer crecer más el prompt sin bajar FINAL_MATERIAL_MAX_CHARS o maxTokens). Commit: 39caeca. Running count ~400 líneas authored → umbral de chain strategy alcanzado; pregunta hecha al usuario.

L7 (2026-10-28, decisión del usuario): chain strategy = **stacked-to-main** ("Cada PR apunta directo a main y se mergea en orden"). Aplica cuando haya entrega de PRs; push/PR sigue siendo decisión del usuario.

L8 (2026-10-28): T4 implementado. El normalizador web (`web/src/App.tsx`) ahora expone `normalizeMindmap(mm): MindDocument | null` con `MindDocument = { title, sections: MindData[] }`: si el JSON trae `sections[]` (v2) normaliza cada sección con `normalizeSection` (mismo builders de antes); el formato viejo single-layout se envuelve como una única sección. `MindmapView` renderiza `doc.sections` en orden con `layoutBody(data)` (el switch de antes, extraído como función) y cada sección va envuelta en `.mm-section` (separador CSS espejo de `.mm-topic + .mm-topic` en App.css). Verificación: `npx tsc --noEmit` + `npx vite build` verdes (no hay test runner en web — excepción de test-first registrada). Commit: d28d975.

L9 (2026-10-28): T5 implementado con test-first. `MindmapDto` ganó `sections: List<MindmapDto>?` (recursivo, compatible con Gson para notas viejas); nuevo `MindDocument(title, sections)`; `normalizeMindmap` ahora retorna `MindDocument?` (v2 itera secciones con `normalizeSection`, el viejo se envuelve en 1 sección); composable `MindmapSection` renderiza `doc.sections` con `LayoutBody(data)` (el when de antes) y divider entre secciones. Tests: `MindmapNormalizeTest.kt` (7 tests, RED = compile error por `sections` inexistente → GREEN). Commits: 77816b7. Entorno gradle verificado: sin wrapper — `JAVA_HOME=/opt/homebrew/opt/openjdk@17 ANDROID_HOME=/opt/homebrew/share/android-commandlinetools gradle -p android <task>`.

