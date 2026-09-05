import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // 开发期把 API 与 WebSocket 代理到本地中枢
      '/api': { target: 'http://localhost:7317', ws: true },
    },
  },
})
