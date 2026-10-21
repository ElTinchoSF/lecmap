# Lecmap web

Frontend de **Lecmap**: grabación, transcripción, resumen, mapa de ideas y preguntas con **ApIA**.

## Desarrollo

```bash
npm install
npm run dev
```

La API se toma de `VITE_API_URL` o, por defecto, `http://localhost:3001`.

```bash
# .env.local
VITE_API_URL=https://tu-backend.example.com
```

## Build

```bash
npm run build
npm run preview
```

El resultado queda en `dist/`.
