import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: command === 'serve' ? '/' : '/lottie-ai-studio/',
  plugins: [react()],
  server: {
    proxy: {
      '/api/wiro': {
        target: 'https://api.wiro.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/wiro/, ''),
      },
    },
  },
}))
