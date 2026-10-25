import { getApp, getApps, initializeApp } from 'firebase/app'
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: 'AIzaSyDF7dseFJzdiP7_go0ucGHriJTu_uspEiA',
  authDomain: /(^|\.)2gofresh\.com$/.test(window.location.hostname) ? 'www.2gofresh.com' : 'gofresh-3f2f3.firebaseapp.com',
  projectId: 'gofresh-3f2f3',
  appId: '1:164090712378:web:c6bae8261d47efb0128003',
}

export const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig)

// Aplikasi POS menyimpan salinan katalog, stok, shift, dan member di perangkat agar tetap terbaca saat internet mati.
const isPosHost = /^(www\.)?kasir\./i.test(window.location.hostname)

function createDatabase() {
  if (!isPosHost) return getFirestore(app)
  try {
    return initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) })
  } catch {
    return getFirestore(app)
  }
}

export const database = createDatabase()
