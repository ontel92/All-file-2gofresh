import { useState } from 'react'
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  linkWithCredential,
  linkWithPopup,
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from 'firebase/auth'
import type { FirebaseError } from 'firebase/app'
import { httpsCallable } from 'firebase/functions'
import { auth, functions } from '../posFirebase'
import { normalizePhone } from '../retailPricing'
import MapPicker from './MapPicker'
import type { Point } from './MapPicker'
import { OrderHistory } from './OrderHistory'
import type { CustomerProfile } from './customer'

function friendly(error: unknown): string {
  const code = (error as { code?: string }).code ?? ''
  if (code.includes('email-already-in-use')) return 'Email ini sudah terdaftar. Silakan masuk.'
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) {
    return 'Email atau password salah.'
  }
  if (code.includes('weak-password')) return 'Password minimal 6 karakter.'
  if (code.includes('invalid-email')) return 'Format email tidak valid.'
  if (code.includes('operation-not-allowed')) return 'Metode masuk ini belum diaktifkan oleh toko.'
  if (code.includes('unauthorized-domain')) return 'Domain ini belum diizinkan untuk login. Hubungi toko.'
  if (code.includes('popup-blocked')) return 'Pop-up diblokir browser. Izinkan pop-up lalu coba lagi.'
  return error instanceof Error ? error.message : 'Terjadi kesalahan. Coba lagi.'
}

async function signInWithGoogle() {
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  const current = auth.currentUser
  if (current?.isAnonymous) {
    try {
      await linkWithPopup(current, provider)
    } catch (failure) {
      const credential = GoogleAuthProvider.credentialFromError(failure as FirebaseError)
      if ((failure as FirebaseError).code === 'auth/credential-already-in-use' && credential) {
        await signInWithCredential(auth, credential)
        return
      }
      throw failure
    }
  } else {
    await signInWithPopup(auth, provider)
  }
}

function isCancelled(error: unknown) {
  const code = (error as { code?: string }).code ?? ''
  return code.includes('popup-closed-by-user') || code.includes('cancelled-popup-request')
}

function CompleteProfile({ defaultName }: { defaultName: string }) {
  const [name, setName] = useState(defaultName)
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    const normalized = normalizePhone(phone)
    if (name.trim().length < 2) return setError('Nama wajib diisi.')
    if (!normalized) return setError('Nomor WhatsApp tidak valid. Contoh: 081234567890')
    setBusy(true)
    try {
      await httpsCallable(functions, 'saveCustomerProfile')({ name: name.trim(), phone: normalized })
    } catch (failure) {
      setError(friendly(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="form" onSubmit={(event) => void submit(event)}>
      <h2>Lengkapi data</h2>
      <p className="muted">Satu langkah lagi. Nomor WhatsApp dipakai toko untuk menghubungi Anda dan mengenali Member VIP.</p>
      <label>Nama lengkap<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></label>
      <label>No. WhatsApp<input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" autoComplete="tel" placeholder="08xxxxxxxxxx" /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" className="btn" disabled={busy}>{busy ? 'Menyimpan...' : 'Simpan'}</button>
      <button type="button" className="link" onClick={() => void signOut(auth)}>Batal & keluar</button>
    </form>
  )
}

function AddressTab({ profile }: { profile: CustomerProfile }) {
  const [address, setAddress] = useState(profile.address)
  const [point, setPoint] = useState<Point | null>(
    profile.lat !== null && profile.lng !== null ? { lat: profile.lat, lng: profile.lng } : null,
  )
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function save() {
    setError('')
    setMessage('')
    if (address.trim().length < 10) return setError('Tulis alamat lengkap (jalan, nomor, RT/RW, patokan).')
    setBusy(true)
    try {
      await httpsCallable(functions, 'saveCustomerAddress')({ address: address.trim(), lat: point?.lat, lng: point?.lng })
      setMessage('Alamat tersimpan. Alamat ini otomatis terisi saat checkout.')
    } catch (failure) {
      setError(friendly(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="form">
      <p className="muted">Alamat utama untuk pengiriman. Tandai titik rumah di peta agar kurir tidak salah.</p>
      <MapPicker value={point} onChange={setPoint} />
      <label>Alamat lengkap
        <textarea rows={3} value={address} onChange={(event) => setAddress(event.target.value)} maxLength={300} placeholder="Nama jalan, nomor rumah, RT/RW, kelurahan, patokan" />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="info">{message}</p>}
      <button type="button" className="btn" disabled={busy} onClick={() => void save()}>{busy ? 'Menyimpan...' : 'Simpan alamat'}</button>
    </div>
  )
}

function ProfileTab({ profile }: { profile: CustomerProfile }) {
  const [name, setName] = useState(profile.name)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function save() {
    setError('')
    setMessage('')
    if (name.trim().length < 2) return setError('Nama wajib diisi.')
    setBusy(true)
    try {
      await httpsCallable(functions, 'saveCustomerProfile')({ name: name.trim(), phone: profile.phone })
      setMessage('Nama diperbarui.')
    } catch (failure) {
      setError(friendly(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="form">
      <label>Nama lengkap<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></label>
      <label>No. WhatsApp<input value={profile.phone} readOnly /></label>
      <small className="muted">Untuk mengganti nomor WhatsApp, hubungi toko.</small>
      <label>Email<input value={profile.email} readOnly /></label>
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="info">{message}</p>}
      <button type="button" className="btn" disabled={busy} onClick={() => void save()}>{busy ? 'Menyimpan...' : 'Simpan nama'}</button>
      <button type="button" className="btn ghost" onClick={() => void signOut(auth)}>Keluar</button>
    </div>
  )
}

function Dashboard({ profile, uid, onClose }: { profile: CustomerProfile; uid: string; onClose: () => void }) {
  const [tab, setTab] = useState<'orders' | 'address' | 'profile'>('orders')
  return (
    <>
      <h2>Halo, {profile.name.split(' ')[0]}</h2>
      <p className="muted">{profile.email} · {profile.phone}</p>
      <div className="account-stats">
        <div>
          <small>Status</small>
          <b>{profile.vip ? 'Member VIP' : 'Belum VIP'}</b>
        </div>
        <div>
          <small>Poin</small>
          <b>{profile.points.toLocaleString('id-ID')}</b>
        </div>
      </div>
      {!profile.vip && <p className="muted">Beli Kartu VIP untuk gratis ongkir radius 1 km dan poin cashback.</p>}
      <div className="tabs">
        <button type="button" className={tab === 'orders' ? 'on' : ''} onClick={() => setTab('orders')}>Pesanan</button>
        <button type="button" className={tab === 'address' ? 'on' : ''} onClick={() => setTab('address')}>Alamat</button>
        <button type="button" className={tab === 'profile' ? 'on' : ''} onClick={() => setTab('profile')}>Akun</button>
      </div>
      {tab === 'orders' && (
        <>
          <OrderHistory uid={uid} />
          <button type="button" className="btn ghost" onClick={onClose}>Lanjut belanja</button>
        </>
      )}
      {tab === 'address' && <AddressTab profile={profile} />}
      {tab === 'profile' && <ProfileTab profile={profile} />}
    </>
  )
}

function Account({
  profile,
  profileLoading,
  uid,
  displayName,
  registered,
  startTab,
  onClose,
}: {
  profile: CustomerProfile | null
  profileLoading: boolean
  uid: string
  displayName: string
  registered: boolean
  startTab: 'login' | 'register'
  onClose: () => void
}) {
  const [tab, setTab] = useState(startTab)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  async function google() {
    setError('')
    setInfo('')
    setBusy(true)
    try {
      await signInWithGoogle()
    } catch (failure) {
      if (!isCancelled(failure)) setError(friendly(failure))
    } finally {
      setBusy(false)
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    setInfo('')
    setBusy(true)
    try {
      if (tab === 'login') {
        await signInWithEmailAndPassword(auth, email.trim(), password)
      } else {
        const normalized = normalizePhone(phone)
        if (name.trim().length < 2) throw new Error('Nama wajib diisi.')
        if (!normalized) throw new Error('Nomor WhatsApp tidak valid. Contoh: 081234567890')
        if (auth.currentUser?.isAnonymous) {
          await linkWithCredential(auth.currentUser, EmailAuthProvider.credential(email.trim(), password))
        } else {
          await createUserWithEmailAndPassword(auth, email.trim(), password)
        }
        await auth.currentUser?.getIdToken(true)
        await httpsCallable(functions, 'saveCustomerProfile')({ name: name.trim(), phone: normalized })
      }
    } catch (failure) {
      setError(friendly(failure))
    } finally {
      setBusy(false)
    }
  }

  async function reset() {
    setError('')
    if (!email.trim()) {
      setError('Isi email dulu, lalu klik Lupa password.')
      return
    }
    try {
      await sendPasswordResetEmail(auth, email.trim())
      setInfo('Link reset password sudah dikirim ke email Anda.')
    } catch (failure) {
      setError(friendly(failure))
    }
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Akun">
      <div className="modal-card wide">
        <button type="button" className="modal-close" aria-label="Tutup" onClick={onClose}>×</button>
        {registered && profile ? (
          <Dashboard profile={profile} uid={uid} onClose={onClose} />
        ) : registered && profileLoading ? (
          <p className="muted">Memuat akun...</p>
        ) : registered ? (
          <CompleteProfile defaultName={displayName} />
        ) : (
          <>
            <div className="tabs">
              <button type="button" className={tab === 'login' ? 'on' : ''} onClick={() => setTab('login')}>Masuk</button>
              <button type="button" className={tab === 'register' ? 'on' : ''} onClick={() => setTab('register')}>Registrasi</button>
            </div>
            <button type="button" className="btn ghost google-btn" disabled={busy} onClick={() => void google()}>
              <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
                <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.9 2.4 30.4 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z" />
                <path fill="#FBBC05" d="M10.5 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.8l7.9-6.1z" />
                <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
              </svg>
              {tab === 'login' ? 'Masuk dengan Google' : 'Daftar dengan Google'}
            </button>
            <p className="muted small center-text">atau dengan email</p>
            <form className="form" onSubmit={(event) => void submit(event)}>
              {tab === 'register' && (
                <>
                  <label>Nama lengkap<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></label>
                  <label>No. WhatsApp<input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" autoComplete="tel" placeholder="08xxxxxxxxxx" /></label>
                </>
              )}
              <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label>
              <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={tab === 'login' ? 'current-password' : 'new-password'} /></label>
              {error && <p className="error" role="alert">{error}</p>}
              {info && <p className="info">{info}</p>}
              <button type="submit" className="btn" disabled={busy}>{busy ? 'Memproses...' : tab === 'login' ? 'Masuk' : 'Daftar'}</button>
              {tab === 'login' && <button type="button" className="link" onClick={() => void reset()}>Lupa password?</button>}
            </form>
            <p className="muted small">Belanja tanpa akun tetap bisa (guest checkout). Akun dibutuhkan untuk riwayat belanja, poin, dan Member VIP.</p>
          </>
        )}
        {error && registered && <p className="error" role="alert">{error}</p>}
      </div>
    </div>
  )
}

export default Account
