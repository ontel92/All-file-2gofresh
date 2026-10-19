import { getAuth } from 'firebase/auth'
import { getFunctions } from 'firebase/functions'
import { app } from './firebase'

export const auth = getAuth(app)
export const functions = getFunctions(app, 'asia-southeast2')
