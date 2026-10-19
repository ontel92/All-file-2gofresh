import { useEffect, useState } from 'react'
import { onIdTokenChanged } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { database } from '../firebase'
import { auth } from '../posFirebase'

export type Product = {
  sku: string
  name: string
  category: string
  unit: string
  minQty: number
  retailPrice: number
  imageUrl: string
}

export type CartMap = Record<string, number>

export type CustomerProfile = {
  name: string
  phone: string
  email: string
  vip: boolean
  points: number
  address: string
  lat: number | null
  lng: number | null
}

export const currency = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0,
})
export const qtyFormat = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 })

export function useCustomer() {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)
  const [, setTick] = useState(0)
  const [profile, setProfile] = useState<CustomerProfile | null | undefined>(undefined)

  useEffect(
    () =>
      onIdTokenChanged(auth, (next) => {
        setUser(next)
        setTick((value) => value + 1)
        setReady(true)
      }),
    [],
  )

  const registered = !!user && !user.isAnonymous
  const uid = registered ? user.uid : ''

  useEffect(() => {
    if (!uid) return
    return onSnapshot(
      doc(database, 'customers', uid),
      (snapshot) =>
        setProfile(
          snapshot.exists()
            ? {
                name: String(snapshot.get('name') ?? ''),
                phone: String(snapshot.get('phone') ?? ''),
                email: String(snapshot.get('email') ?? ''),
                vip: snapshot.get('vip') === true,
                points: Number(snapshot.get('points') ?? 0),
                address: String(snapshot.get('address') ?? ''),
                lat: typeof snapshot.get('lat') === 'number' ? (snapshot.get('lat') as number) : null,
                lng: typeof snapshot.get('lng') === 'number' ? (snapshot.get('lng') as number) : null,
              }
            : null,
        ),
      () => setProfile(null),
    )
  }, [uid])

  return {
    user,
    ready,
    registered,
    profile: registered ? (profile ?? null) : null,
    profileLoading: registered && profile === undefined,
  }
}
