import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// Menulis daftar berkas build (JS/CSS) ke precache.json agar service worker POS bisa menyimpannya untuk mode offline.
function posPrecacheManifest(): Plugin {
  return {
    name: 'pos-precache-manifest',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((fileName) => /\.(js|css)$/.test(fileName))
        .map((fileName) => `/${fileName}`)
      this.emitFile({ type: 'asset', fileName: 'precache.json', source: JSON.stringify(files) })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), posPrecacheManifest()],
})
