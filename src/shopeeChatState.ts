import type { ShopeeStoreId } from './opsStore'

export type ChatLike = { id: string; unread: number; latestId: string }

const KEY = 'shopeeChatLocalReadV1'

function load(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

const entryKey = (store: ShopeeStoreId, conversationId: string) => `${store}:${conversationId}`

// Penanda lokal: chat yang sudah dibuka di kasir tidak dihitung belum dibaca sampai ada pesan baru,
// walaupun penandaan baca ke Shopee gagal.
export function markChatReadLocally(store: ShopeeStoreId, chat: Pick<ChatLike, 'id' | 'latestId'>) {
  if (!chat.id || !chat.latestId) return
  const marks = load()
  marks[entryKey(store, chat.id)] = chat.latestId
  const trimmed = Object.fromEntries(Object.entries(marks).slice(-500))
  try {
    localStorage.setItem(KEY, JSON.stringify(trimmed))
  } catch {
    // Penanda hanya hilang jika penyimpanan browser tidak tersedia.
  }
}

// Jumlah pesan belum dibaca menurut Shopee (unread_count), 0 bila sudah dibuka di kasir untuk pesan terakhir yang sama.
export function effectiveUnread(store: ShopeeStoreId, chat: ChatLike): number {
  if (chat.unread <= 0) return 0
  return load()[entryKey(store, chat.id)] === chat.latestId ? 0 : chat.unread
}

export function countUnreadChats(store: ShopeeStoreId, chats: ChatLike[]): number {
  const marks = load()
  return chats.filter((chat) => chat.unread > 0 && marks[entryKey(store, chat.id)] !== chat.latestId).length
}
