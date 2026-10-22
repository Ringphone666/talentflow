import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
    // 页面测试渲染完整的 Ant Design 组件，单线程并放宽超时，结果才稳定。
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 30000,
  },
})
