import { useEffect, useRef, useState } from 'react'
import { signInAnonymously } from 'firebase/auth'
import { doc, collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { database } from './firebase'
import { auth, functions } from './posFirebase'
import { normalizePhone } from './retailPricing'
import { storeInfo } from './storeInfo'
import './YubiChat.css'

type Message = { id: string; sender: 'customer' | 'staff' | 'bot'; text: string; senderName?: string }

const quickAnswers: { label: string; answer: string }[] = [
  {
    label: 'Alamat toko',
    answer: `Toko kami di ${storeInfo.address}. Bisa juga pesan online lewat ${storeInfo.websiteLabel}.`,
  },
  {
    label: 'Cara pesan',
    answer: 'Pilih produk di website, masukkan ke keranjang, lalu checkout. Bisa bayar online atau pesan lewat WhatsApp toko.',
  },
  {
    label: 'Harga grosir / B2B',
    answer: `Untuk harga B2B dan katalog lengkap, hubungi WhatsApp kami di ${storeInfo.whatsapp}.`,
  },
  {
    label: 'Member VIP',
    answer:
      'Member VIP dapat gratis ongkir radius 1 km dari toko (min. belanja Rp50.000) dan poin 1% dari belanja min. Rp50.000 yang bisa ditukar dengan produk. Beli Kartu VIP di website atau di kasir toko.',
  },
  {
    label: 'Kontak & medsos',
    answer: `WA ${storeInfo.whatsapp} · IG ${storeInfo.instagram} · Shopee ${storeInfo.shopee} · ${storeInfo.email}`,
  },
]

function YubiChat() {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'bot' | 'form' | 'chat'>('bot')
  const [online, setOnline] = useState(false)
  const [cashierName, setCashierName] = useState('')
  const [nudge, setNudge] = useState('')
  const [botLog, setBotLog] = useState<Message[]>([
    { id: 'hi', sender: 'bot', text: 'Halo, aku Yubi! Mau tanya apa tentang 2goFresh?' },
  ])
  const [name, setName] = useState(() => localStorage.getItem('yubi-name') ?? '')
  const [phone, setPhone] = useState(() => localStorage.getItem('yubi-phone') ?? '')
  const [text, setText] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [unread, setUnread] = useState(0)
  const [chatUid, setChatUid] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(
    () =>
      onSnapshot(
        doc(database, 'storeStatus', 'current'),
        (snapshot) => {
          setOnline(snapshot.get('cashierOnline') === true)
          setCashierName(String(snapshot.get('cashierName') ?? ''))
        },
        () => setOnline(false),
      ),
    [],
  )

  // Yubi menyapa pelanggan secara berkala selama panel chat tertutup.
  useEffect(() => {
    if (open) return
    const greetings = [
      'Halo! Aku Yubi 👋 Ada yang bisa kubantu?',
      'Mau tanya soal toko, ongkir, atau cara pesan? Tanya aku ya!',
      online
        ? `Kasir ${cashierName || 'kami'} sedang online. Mau ngobrol langsung?`
        : 'Tinggalkan pesan di sini, nanti kasir kami balas ya.',
    ]
    let index = 0
    let hide: number | undefined
    const show = () => {
      setNudge(greetings[index % greetings.length])
      index += 1
      hide = window.setTimeout(() => setNudge(''), 6000)
    }
    const first = window.setTimeout(show, 4000)
    const loop = window.setInterval(show, 25000)
    return () => {
      window.clearTimeout(first)
      window.clearTimeout(hide)
      window.clearInterval(loop)
    }
  }, [open, online, cashierName])

  useEffect(() => {
    if (!open || mode === 'bot') return
    let unsubscribeChat = () => {}
    let cancelled = false
    void (async () => {
      try {
        const credential = auth.currentUser ?? (await signInAnonymously(auth)).user
        if (cancelled) return
        setChatUid(credential.uid)
        unsubscribeChat = onSnapshot(
          query(collection(database, 'chats', credential.uid, 'messages'), orderBy('createdAt', 'asc'), limit(200)),
          (snapshot) => {
            const loaded = snapshot.docs.map((entry) => ({
              id: entry.id,
              sender: entry.get('sender') === 'staff' ? ('staff' as const) : ('customer' as const),
              text: String(entry.get('text') ?? ''),
              senderName: String(entry.get('senderName') ?? ''),
            }))
            setMessages(loaded)
            if (loaded.length > 0) setMode('chat')
          },
          () => undefined,
        )
      } catch {
        setError('Chat belum bisa dibuka. Silakan hubungi kami via WhatsApp.')
      }
    })()
    return () => {
      cancelled = true
      unsubscribeChat()
    }
  }, [open, mode])

  useEffect(() => {
    if (!chatUid) return
    return onSnapshot(
      doc(database, 'chats', chatUid),
      (snapshot) => setUnread(open ? 0 : Number(snapshot.get('unreadCustomer') ?? 0)),
      () => undefined,
    )
  }, [chatUid, open])

  useEffect(() => {
    if (open && chatUid && mode === 'chat') {
      void httpsCallable(functions, 'markChatSeenByCustomer')({})
    }
  }, [open, chatUid, mode, messages.length])

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, botLog.length, mode])

  function ask(entry: { label: string; answer: string }) {
    setBotLog((log) => [
      ...log,
      { id: `q${log.length}`, sender: 'customer', text: entry.label },
      { id: `a${log.length}`, sender: 'bot', text: entry.answer },
    ])
  }

  async function send(event: React.FormEvent) {
    event.preventDefault()
    const normalized = phone.trim() === '' ? '' : normalizePhone(phone)
    if (normalized === null) {
      setError('Nomor WA tidak valid. Contoh: 081234567890 (boleh dikosongkan).')
      return
    }
    if (name.trim().length < 2) {
      setError('Nama wajib diisi.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await httpsCallable(functions, 'sendChatMessage')({ name: name.trim(), phone: normalized, text })
      localStorage.setItem('yubi-name', name.trim())
      localStorage.setItem('yubi-phone', phone.trim())
      setText('')
      setMode('chat')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Pesan gagal dikirim.')
    } finally {
      setBusy(false)
    }
  }

  const shown: Message[] = mode === 'chat' ? messages : botLog

  return (
    <div className="yubi">
      {open && (
        <section className="yubi-panel" aria-label="Chat Yubi">
          <header>
            <img src="/brand/yubi.png" alt="" width="40" height="40" />
            <div>
              <strong>Yubi · 2goFresh</strong>
              <span className={online ? 'on' : 'off'}>
                {online ? `● Kasir ${cashierName || ''} online` : '● Kasir offline'}
              </span>
            </div>
            <button type="button" aria-label="Tutup" onClick={() => setOpen(false)}>×</button>
          </header>
          <div className="yubi-body">
            {shown.map((message) => (
              <div key={message.id} className={`yubi-msg ${message.sender}`}>
                {message.sender === 'staff' && <small>Kasir {message.senderName || cashierName}</small>}
                {message.text}
              </div>
            ))}
            {mode === 'bot' && (
              <div className="yubi-quick">
                {quickAnswers.map((entry) => (
                  <button key={entry.label} type="button" onClick={() => ask(entry)}>{entry.label}</button>
                ))}
                <button type="button" className="primary" onClick={() => setMode('form')}>
                  {online ? 'Chat dengan kasir' : 'Tinggalkan pesan'}
                </button>
              </div>
            )}
            {mode === 'chat' && !online && (
              <p className="yubi-note">Kasir sedang offline. Pesan Anda akan dibalas nanti{phone ? ' lewat WA/chat ini.' : '.'}</p>
            )}
            <div ref={bottom} />
          </div>
          {mode !== 'bot' && (
            <form className="yubi-form" onSubmit={(event) => void send(event)}>
              {mode === 'form' && (
                <>
                  {!online && (
                    <p className="yubi-note">Kasir sedang offline. Tinggalkan nama dan nomor WA, nanti kami balas.</p>
                  )}
                  <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nama Anda (wajib)" maxLength={40} />
                  <input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="No. WA (opsional)" inputMode="tel" />
                </>
              )}
              {error && <p className="yubi-error" role="alert">{error}</p>}
              <div className="yubi-send">
                <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Tulis pesan..." maxLength={500} />
                <button type="submit" disabled={busy || text.trim() === ''}>Kirim</button>
              </div>
            </form>
          )}
        </section>
      )}
      {!open && nudge && (
        <button type="button" className="yubi-nudge" onClick={() => { setNudge(''); setOpen(true) }}>
          {nudge}
        </button>
      )}
      <button type="button" className="yubi-fab" aria-label="Chat dengan Yubi" onClick={() => { setNudge(''); setOpen((value) => !value) }}>
        <img src="/brand/yubi.png" alt="" width="84" height="107" />
        {unread > 0 && <b>{unread}</b>}
      </button>
    </div>
  )
}

export default YubiChat
