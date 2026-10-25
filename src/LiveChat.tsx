import { useEffect, useRef, useState } from 'react'
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { database } from './firebase'
import { functions } from './posFirebase'
import { pushToast } from './opsStore'
import './Chat.css'

export type StoreChat = {
  id: string
  customerName: string
  customerPhone: string
  status: 'open' | 'closed'
  lastMessage: string
  lastSender: string
  lastMessageAt: Date | null
  unreadStaff: number
  cashierWasOnline: boolean
}
type ChatMessage = { id: string; sender: 'customer' | 'staff'; senderName: string; text: string; createdAt: Date | null }

function toDate(value: unknown): Date | null {
  const converter = (value as { toDate?: () => Date } | null)?.toDate
  return typeof converter === 'function' ? converter.call(value) : null
}

export function useStoreChats(enabled: boolean) {
  const [chats, setChats] = useState<StoreChat[]>([])
  const [soundOn, setSoundOn] = useState(false)
  const known = useRef<Record<string, number> | null>(null)

  useEffect(() => {
    if (!enabled) return
    return onSnapshot(
      query(collection(database, 'chats'), orderBy('lastMessageAt', 'desc'), limit(100)),
      (snapshot) => {
        const next = snapshot.docs.map((entry) => ({
          id: entry.id,
          customerName: String(entry.get('customerName') ?? ''),
          customerPhone: String(entry.get('customerPhone') ?? ''),
          status: (entry.get('status') === 'closed' ? 'closed' : 'open') as StoreChat['status'],
          lastMessage: String(entry.get('lastMessage') ?? ''),
          lastSender: String(entry.get('lastSender') ?? ''),
          lastMessageAt: toDate(entry.get('lastMessageAt')),
          unreadStaff: Number(entry.get('unreadStaff') ?? 0),
          cashierWasOnline: entry.get('cashierWasOnline') === true,
        }))
        const previous = known.current
        known.current = Object.fromEntries(next.map((chat) => [chat.id, chat.unreadStaff]))
        if (previous && next.some((chat) => chat.unreadStaff > (previous[chat.id] ?? 0))) {
          next.filter((entry) => entry.unreadStaff > (previous[entry.id] ?? 0)).forEach((chat, index) => {
            pushToast({ icon: '💬', title: `Live Chat: ${chat.customerName || 'Pelanggan'}`, body: chat.lastMessage, sticky: false, sound: index === 0 ? '/chatmasuk.mp3' : undefined, actions: [{ label: 'Buka chat', panel: 'chat' }] })
          })
        }
        setChats(next)
      },
      () => setChats([]),
    )

  }, [enabled])

  function enableSound() {
    setSoundOn(true)
  }

  return {
    chats,
    soundOn,
    enableSound,
    unreadTotal: chats.reduce((sum, chat) => sum + chat.unreadStaff, 0),
  }
}

function ago(date: Date | null) {
  if (!date) return ''
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000)
  if (minutes < 1) return 'baru saja'
  if (minutes < 60) return `${minutes} mnt`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} jam`
  return date.toLocaleDateString('id-ID', { dateStyle: 'short' })
}

function Thread({ chat, staffName }: { chat: StoreChat; staffName: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(
    () =>
      onSnapshot(
        query(collection(database, 'chats', chat.id, 'messages'), orderBy('createdAt', 'asc'), limit(200)),
        (snapshot) =>
          setMessages(
            snapshot.docs.map((entry) => ({
              id: entry.id,
              sender: entry.get('sender') === 'staff' ? 'staff' : 'customer',
              senderName: String(entry.get('senderName') ?? ''),
              text: String(entry.get('text') ?? ''),
              createdAt: toDate(entry.get('createdAt')),
            })),
          ),
        () => setMessages([]),
      ),
    [chat.id],
  )

  useEffect(() => {
    if (chat.unreadStaff > 0) {
      void httpsCallable(functions, 'markChatRead')({ chatId: chat.id })
    }
  }, [chat.id, chat.unreadStaff])

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  async function send(event: React.FormEvent) {
    event.preventDefault()
    if (text.trim() === '') return
    setBusy(true)
    setError('')
    try {
      await httpsCallable(functions, 'replyChat')({ chatId: chat.id, text })
      setText('')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Balasan gagal dikirim.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="chat-thread">
      <header>
        <div>
          <strong>{chat.customerName}</strong>
          <small>{chat.customerPhone ? `+${chat.customerPhone}` : 'Tanpa nomor WA'}</small>
        </div>
        <div className="chat-actions">
          {chat.customerPhone && (
            <a href={`https://wa.me/${chat.customerPhone}`} target="_blank" rel="noreferrer">Balas via WA</a>
          )}
          {chat.status === 'open' && (
            <button type="button" onClick={() => void httpsCallable(functions, 'markChatRead')({ chatId: chat.id, close: true })}>
              Tutup chat
            </button>
          )}
        </div>
      </header>
      {!chat.cashierWasOnline && chat.status === 'open' && (
        <p className="chat-offline-note">Pesan ini masuk saat kasir offline. Balas lewat sini atau WA.</p>
      )}
      <div className="chat-messages">
        {messages.map((message) => (
          <div key={message.id} className={`chat-bubble ${message.sender}`}>
            {message.sender === 'staff' && message.senderName && <small>{message.senderName}</small>}
            <p>{message.text}</p>
            <time>{message.createdAt?.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</time>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <form className="chat-form" onSubmit={(event) => void send(event)}>
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={1000}
          placeholder={`Balas sebagai ${staffName}...`}
        />
        <button type="submit" disabled={busy || text.trim() === ''}>Kirim</button>
      </form>
      {error && <p className="rc-warning" role="alert">{error}</p>}
    </section>
  )
}

type PanelProps = {
  chats: StoreChat[]
  soundOn: boolean
  onEnableSound: () => void
  staffName: string
}

function LiveChat({ chats, soundOn, onEnableSound, staffName }: PanelProps) {
  const [selectedId, setSelectedId] = useState('')
  const [showClosed, setShowClosed] = useState(false)
  const visible = chats.filter((chat) => showClosed || chat.status === 'open')
  const selected = chats.find((chat) => chat.id === selectedId)

  return (
    <div className="chat-page">
      <div className="pos-page-heading">
        <div>
          <p className="pos-eyebrow">PELANGGAN</p>
          <h1>Live Chat Store</h1>
          <p>Chat dari Yubi di www.2gofresh.com. Pelanggan melihat status kasir online selama shift terbuka.</p>
        </div>
        {!soundOn && (
          <button type="button" className="pos-account-button" onClick={onEnableSound}>Aktifkan suara notifikasi</button>
        )}
      </div>
      <div className="chat-layout">
        <aside className="chat-list">
          <label className="chat-closed-toggle">
            <input type="checkbox" checked={showClosed} onChange={(event) => setShowClosed(event.target.checked)} />
            Tampilkan chat yang sudah ditutup
          </label>
          {visible.length === 0 && <p className="sf-note">Belum ada chat masuk.</p>}
          {visible.map((chat) => (
            <button
              key={chat.id}
              type="button"
              className={`chat-item${selectedId === chat.id ? ' active' : ''}`}
              onClick={() => setSelectedId(chat.id)}
            >
              <span>
                <strong>{chat.customerName}</strong>
                <small>{chat.lastSender === 'staff' ? 'Anda: ' : ''}{chat.lastMessage}</small>
              </span>
              <span className="chat-meta">
                <time>{ago(chat.lastMessageAt)}</time>
                {chat.unreadStaff > 0 && <b>{chat.unreadStaff}</b>}
              </span>
            </button>
          ))}
        </aside>
        {selected ? (
          <Thread key={selected.id} chat={selected} staffName={staffName} />
        ) : (
          <section className="chat-thread chat-empty">Pilih percakapan di sebelah kiri.</section>
        )}
      </div>
    </div>
  )
}

export default LiveChat
