import { useEffect, useState } from 'react'
import { collection, doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore'
import { database } from './firebase'
import './ShopeePanel.css'

const BEAT_MS = 60000
const ONLINE_MS = 150000

type Person = { uid: string; name: string; role: string; lastSeen: number; panel: string }
type ShiftInfo = { cashierUid: string; cashierName: string; sales: number; count: number; openedAt: Date | null } | null

// Every signed-in staff device reports a heartbeat so owner/supervisor can see who is online.
export function usePresence(enabled: boolean, uid: string | undefined, name: string, role: string, panel: string) {
  useEffect(() => {
    if (!enabled || !uid) return
    const beat = () => {
      if (document.visibilityState === 'hidden') return
      void setDoc(doc(database, 'presence', uid), { name, role, panel, lastSeen: serverTimestamp() }).catch(() => undefined)
    }
    beat()
    const timer = window.setInterval(beat, BEAT_MS)
    document.addEventListener('visibilitychange', beat)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', beat)
    }
  }, [enabled, uid, name, role, panel])
}

const roleText: Record<string, string> = { owner: 'Owner', supervisor: 'Supervisor', cashier: 'Kasir' }
const money = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })

export function useOnlineStaff(enabled: boolean) {
  const [people, setPeople] = useState<Person[]>([])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const stop = onSnapshot(
      collection(database, 'presence'),
      (snapshot) =>
        setPeople(
          snapshot.docs.map((entry) => ({
            uid: entry.id,
            name: String(entry.get('name') ?? ''),
            role: String(entry.get('role') ?? ''),
            lastSeen: (entry.get('lastSeen') as { toMillis?: () => number } | null)?.toMillis?.() ?? Date.now(),
            panel: String(entry.get('panel') ?? ''),
          })),
        ),
      () => setPeople([]),
    )
    const timer = window.setInterval(() => setNow(Date.now()), 20000)
    return () => {
      stop()
      window.clearInterval(timer)
    }
  }, [enabled])
  const online = people.filter((person) => now - person.lastSeen <= ONLINE_MS)
  return { online, offline: people.filter((person) => now - person.lastSeen > ONLINE_MS), now }
}

function ago(ms: number, now: number) {
  const minutes = Math.floor((now - ms) / 60000)
  if (minutes < 1) return 'baru saja'
  if (minutes < 60) return `${minutes} mnt lalu`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} jam lalu`
  return new Date(ms).toLocaleDateString('id-ID', { dateStyle: 'medium' })
}

export default function StaffOnline({ shift, online, offline, now }: { shift: ShiftInfo; online: Person[]; offline: Person[]; now: number }) {
  return (
    <div className="sp online-staff">
      <div className="sp-head">
        <div>
          <strong>Kasir Online</strong>
          <span>Siapa yang bertugas dan sedang login saat ini</span>
        </div>
      </div>

      <section className="sp-order">
        <header>
          <b>Kasir bertugas (shift berjalan)</b>
          <span className={`sp-badge ${shift ? 's-READY_TO_SHIP' : ''}`}>{shift ? 'BERTUGAS' : 'TIDAK ADA SHIFT'}</span>
        </header>
        {shift ? (
          <div className="sp-meta">
            <b>{shift.cashierName}</b>
            <span>Buka: {shift.openedAt ? shift.openedAt.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '-'}</span>
            <span>{shift.count} transaksi</span>
            <span>Penjualan {money.format(shift.sales)}</span>
          </div>
        ) : (
          <p className="sp-muted">Belum ada kasir yang membuka shift. Toko tampil "kasir offline" di website.</p>
        )}
      </section>

      <h3 className="ops-sub">Sedang login ({online.length})</h3>
      {online.length === 0 && <div className="sp-empty">Tidak ada yang online</div>}
      {online.map((person) => (
        <article key={person.uid} className="sp-order ops-person">
          <span className="ops-dot on" aria-hidden="true" />
          <b>{person.name || person.uid}</b>
          <span className="sp-muted">{roleText[person.role] ?? person.role}</span>
          {shift?.cashierUid === person.uid && <span className="sp-badge s-READY_TO_SHIP">Shift aktif</span>}
          <span className="sp-muted ops-right">{ago(person.lastSeen, now)}</span>
        </article>
      ))}

      {offline.length > 0 && <h3 className="ops-sub">Terakhir terlihat</h3>}
      {offline.map((person) => (
        <article key={person.uid} className="sp-order ops-person">
          <span className="ops-dot" aria-hidden="true" />
          <b>{person.name || person.uid}</b>
          <span className="sp-muted">{roleText[person.role] ?? person.role}</span>
          <span className="sp-muted ops-right">{ago(person.lastSeen, now)}</span>
        </article>
      ))}
    </div>
  )
}
