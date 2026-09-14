import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  optimizeDeps: {
    include: [
      '@solana/web3.js',
      '@solana/spl-token',
      'buffer',
    ],
  },
  // Fix Buffer is not defined error
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  // Handle buffer polyfill
  resolve: {
    alias: {
      'buffer': 'buffer',
    },
  },
})
