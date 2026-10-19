import { useEffect, useState } from 'react'
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import { database } from './firebase'

export type MemberRegistration = {
  id: string
  receiptNo: string
  source: string
  status: 'pending' | 'done' | 'cancelled'
  memberName: string
  memberPhone: string
  createdAt: Date | null
}

export type RetailMember = {
  phone: string
  name: string
  active: boolean
  receiptNo: string
  createdAt: Date | null
}

function toDate(value: unknown): Date | null {
  const converter = (value as { toDate?: () => Date } | null)?.toDate
  return typeof converter === 'function' ? converter.call(value) : null
}

export function useMemberData(enabled: boolean) {
  const [registrations, setRegistrations] = useState<MemberRegistration[]>([])
  const [members, setMembers] = useState<RetailMember[]>([])

  useEffect(() => {
    if (!enabled) return
    const unsubscribeRegistrations = onSnapshot(
      query(collection(database, 'memberRegistrations'), orderBy('createdAt', 'desc'), limit(100)),
      (snapshot) =>
        setRegistrations(
          snapshot.docs.map((entry) => ({
            id: entry.id,
            receiptNo: String(entry.get('receiptNo') ?? ''),
            source: String(entry.get('source') ?? ''),
            status: entry.get('status') as MemberRegistration['status'],
            memberName: String(entry.get('memberName') ?? ''),
            memberPhone: String(entry.get('memberPhone') ?? ''),
            createdAt: toDate(entry.get('createdAt')),
          })),
        ),
      () => setRegistrations([]),
    )
    const unsubscribeMembers = onSnapshot(
      query(collection(database, 'retailMembers'), orderBy('createdAt', 'desc'), limit(500)),
      (snapshot) =>
        setMembers(
          snapshot.docs.map((entry) => ({
            phone: entry.id,
            name: String(entry.get('name') ?? ''),
            active: entry.get('active') === true,
            receiptNo: String(entry.get('receiptNo') ?? ''),
            createdAt: toDate(entry.get('createdAt')),
          })),
        ),
      () => setMembers([]),
    )
    return () => {
      unsubscribeRegistrations()
      unsubscribeMembers()
    }
  }, [enabled])

  return { registrations, members, pendingCount: registrations.filter((entry) => entry.status === 'pending').length }
}
