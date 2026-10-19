import { getApp, getApps, initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: 'AIzaSyDF7dseFJzdiP7_go0ucGHriJTu_uspEiA',
  authDomain: /(^|\.)2gofresh\.com$/.test(window.location.hostname) ? 'www.2gofresh.com' : 'gofresh-3f2f3.firebaseapp.com',
  projectId: 'gofresh-3f2f3',
  appId: '1:164090712378:web:c6bae8261d47efb0128003',
}

export const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig)

export const database = getFirestore(app)
