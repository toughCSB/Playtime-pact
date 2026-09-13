import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [{
    name: 'test-cli-shebang',
    enforce: 'pre',
    // Vitest's module wrapper can leave a CLI hashbang inside a function on Windows.
    transform(code, id) {
      if (id.endsWith('.mjs') && code.startsWith('#!')) {
        return { code: code.replace(/^#![^\n]*(?:\n|$)/, '\n'), map: null }
      }
    },
  }],
})
