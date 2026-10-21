import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Rutas relativas: funciona tanto en usuario.github.io/lecmap/ como en lecmap.app.
  base: './',
})
