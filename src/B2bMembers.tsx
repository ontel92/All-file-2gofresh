import { useState } from 'react'
import { normalizePhone } from './retailPricing'
import type { B2bMember } from './B2bCashier'

type Props = {
  members: B2bMember[]
  canManage: boolean
  onSave: (member: B2bMember) => Promise<void>
}

function B2bMembers({ members, canManage, onSave }: Props) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const term = search.trim().toLowerCase()
  const visible = members
    .filter((member) => !term || member.name.toLowerCase().includes(term) || member.phone.includes(term))
    .sort((first, second) => first.name.localeCompare(second.name, 'id'))

  async function save(member: B2bMember) {
    setBusy(true)
    setError('')
    try {
      await onSave(member)
      return true
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Member gagal disimpan.')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault()
    const normalized = normalizePhone(phone)
    if (!normalized) {
      setError('Nomor HP tidak valid. Contoh: 081234567890.')
      return
    }
    if (name.trim() === '') {
      setError('Nama member wajib diisi.')
      return
    }
    if (await save({ phone: normalized, name: name.trim(), active: true })) {
      setName('')
      setPhone('')
    }
  }

  return (
    <>
      <div className="pos-page-heading">
        <div>
          <p className="pos-eyebrow">KASIR B2B</p>
          <h1>Member B2B</h1>
          <p>Hanya nomor HP yang terdaftar di sini yang bisa bertransaksi di Kasir B2B.</p>
        </div>
      </div>

      {canManage && (
        <form className="b2b-form" onSubmit={add}>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nama member / usaha" maxLength={80} />
          <input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="No. HP (08xx)" inputMode="tel" />
          <button type="submit" className="pos-account-button" disabled={busy}>Tambah member</button>
        </form>
      )}
      {error && <p className="pos-data-error" role="alert">{error}</p>}

      <label className="pos-search b2b-search">
        <span aria-hidden="true">⌕</span>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Cari nama atau nomor"
          aria-label="Cari member"
        />
      </label>

      <div className="po-grid">
        {visible.length === 0 && <div className="pos-no-products">Belum ada member B2B.</div>}
        {visible.map((member) => (
          <article key={member.phone} className="po-card">
            <header>
              <div>
                <h2>{member.name}</h2>
                <small>+{member.phone}</small>
              </div>
              <strong>{member.active ? 'Aktif' : 'Nonaktif'}</strong>
            </header>
            {canManage && (
              <footer>
                <button
                  type="button"
                  className={member.active ? 'po-delete' : 'po-resume'}
                  disabled={busy}
                  onClick={() => void save({ ...member, active: !member.active })}
                >
                  {member.active ? 'Nonaktifkan' : 'Aktifkan'}
                </button>
              </footer>
            )}
          </article>
        ))}
      </div>
    </>
  )
}

export default B2bMembers
