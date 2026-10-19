import { useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from './posFirebase'
import { normalizePhone } from './retailPricing'
import type { MemberRegistration, RetailMember } from './memberData'
import './Shifts.css'

type Props = {
  registrations: MemberRegistration[]
  members: RetailMember[]
}

const sourceText: Record<string, string> = { 'retail-offline': 'Kasir Retail', web: 'Web Order' }

function RegistrationCard({ registration }: { registration: MemberRegistration }) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const normalized = normalizePhone(phone)
    if (!normalized) {
      setError('Nomor HP/WA tidak valid. Contoh: 081234567890.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await httpsCallable(functions, 'registerRetailMember')({
        registrationId: registration.id,
        name,
        phone: normalized,
      })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Pendaftaran gagal.')
      setBusy(false)
    }
  }

  return (
    <form className="ct-card sf-form" onSubmit={(event) => void submit(event)}>
      <h2>Nota {registration.receiptNo}</h2>
      <p className="sf-note">
        Pembelian kartu VIP via {sourceText[registration.source] ?? registration.source}. Isi data pemilik kartu.
      </p>
      <label className="sf-field">
        <span>Nama member</span>
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
      </label>
      <label className="sf-field">
        <span>No. WA / HP</span>
        <input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" placeholder="08xx" />
      </label>
      {error && <p className="rc-warning" role="alert">{error}</p>}
      <button type="submit" className="sf-primary" disabled={busy || name.trim().length < 2 || phone.trim() === ''}>
        {busy ? 'Menyimpan...' : 'Daftarkan member'}
      </button>
    </form>
  )
}

function RetailMembers({ registrations, members }: Props) {
  const [search, setSearch] = useState('')
  const pending = registrations.filter((entry) => entry.status === 'pending')
  const term = search.trim().toLowerCase()
  const visible = members.filter(
    (member) => !term || member.name.toLowerCase().includes(term) || member.phone.includes(term),
  )

  return (
    <div className="sf-page">
      <div className="pos-page-heading">
        <div>
          <p className="pos-eyebrow">MEMBER</p>
          <h1>Member Retail</h1>
          <p>Pembeli yang membeli kartu VIP (SKU VIP-CARD-01) otomatis menjadi member setelah datanya diisi.</p>
        </div>
      </div>

      {pending.length > 0 && (
        <section className="sf-page">
          <h2 className="sf-sub">Menunggu data member ({pending.length})</h2>
          {pending.map((registration) => (
            <RegistrationCard key={registration.id} registration={registration} />
          ))}
        </section>
      )}

      <label className="pos-search b2b-search">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Cari nama atau nomor"
          aria-label="Cari member"
        />
      </label>

      <div className="po-grid">
        {visible.length === 0 && <div className="pos-no-products">Belum ada member retail.</div>}
        {visible.map((member) => (
          <article key={member.phone} className="po-card">
            <header>
              <div>
                <h2>{member.name}</h2>
                <small>+{member.phone}</small>
              </div>
              <strong>{member.active ? 'VIP' : 'Nonaktif'}</strong>
            </header>
            <small>
              Nota {member.receiptNo || '-'} · sejak{' '}
              {member.createdAt?.toLocaleDateString('id-ID', { dateStyle: 'medium' }) ?? '-'}
            </small>
          </article>
        ))}
      </div>
    </div>
  )
}

export default RetailMembers
