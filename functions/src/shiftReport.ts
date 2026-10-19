import { createTransport } from 'nodemailer'
import { logger } from 'firebase-functions'
import { defineSecret } from 'firebase-functions/params'
import { getFirestore } from 'firebase-admin/firestore'

export const reportSmtpUser = defineSecret('REPORT_SMTP_USER')
export const reportSmtpPass = defineSecret('REPORT_SMTP_PASS')

export const supervisorEmails = ['onnyhermawan22@gmail.com', 'lilisanggaratih@gmail.com']

const rupiah = (value: number) => `Rp${Math.round(value).toLocaleString('id-ID')}`
const categoryLabel: Record<string, string> = {
  change: 'Modal Kembalian',
  nempil: 'Nempil',
  sales: 'Bayar Sales',
  ops: 'Operasional Toko / Ongkir',
}
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const stamp = (value: unknown) => {
  const date = (value as { toDate?: () => Date } | null)?.toDate?.()
  return date ? date.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' }) : '-'
}
const timeOnly = (value: unknown) => {
  const date = (value as { toDate?: () => Date } | null)?.toDate?.()
  return date ? date.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }) : '-'
}

export async function buildShiftReport(shiftId: string, closedBy: string) {
  const database = getFirestore()
  const shiftRef = database.collection('shifts').doc(shiftId)
  const [shift, expenseDocs, topupDocs] = await Promise.all([
    shiftRef.get(),
    shiftRef.collection('expenses').orderBy('createdAt').get(),
    shiftRef.collection('topups').orderBy('createdAt').get(),
  ])
  const data = shift.data() ?? {}
  const totals = (data.totals ?? {}) as Record<string, unknown>
  const funds = (data.funds ?? {}) as Record<string, unknown>
  const spent = (data.spent ?? {}) as Record<string, unknown>
  const fundTotal = num(funds.change) + num(funds.nempil) + num(funds.sales) + num(funds.ops)
  const spentTotal = num(spent.nempil) + num(spent.sales) + num(spent.ops)
  const difference = num(data.difference)
  const expenses = expenseDocs.docs.filter((entry) => entry.get('removed') !== true)

  const lines: string[] = [
    '*LAPORAN CLOSING SHIFT - 2goFresh*',
    `Kasir: ${String(data.cashierName ?? '-')}`,
    `Dibuka: ${stamp(data.openedAt)}`,
    `Ditutup: ${stamp(data.closedAt)}`,
    ...(closedBy && closedBy !== data.cashierName ? [`Closing oleh: ${closedBy}`] : []),
    '',
    '*PEMASUKAN*',
    `Jumlah transaksi: ${num(totals.count)}`,
    `Total penjualan: ${rupiah(num(totals.sales))}`,
    `- Tunai: ${rupiah(num(totals.cash))}`,
    `- QRIS/EDC: ${rupiah(num(totals.qris))}`,
    `- Transfer: ${rupiah(num(totals.transfer))}`,
    `- Kasir Retail: ${rupiah(num(totals.retail))}`,
    `- Kasir B2B: ${rupiah(num(totals.b2b))}`,
    '',
    '*MODAL AWAL*',
    `- Modal kembalian: ${rupiah(num(funds.change))}`,
    `- Modal Nempil: ${rupiah(num(funds.nempil))}`,
    `- Modal Sales: ${rupiah(num(funds.sales))}`,
    `- Modal Operasional: ${rupiah(num(funds.ops))}`,
    `Total modal: ${rupiah(fundTotal)}`,
  ]
  if (topupDocs.size > 0) {
    lines.push('', '*TAMBAH MODAL (tengah shift)*')
    topupDocs.docs.forEach((entry) => {
      lines.push(`- ${timeOnly(entry.get('createdAt'))} ${categoryLabel[String(entry.get('category'))] ?? entry.get('category')}: ${rupiah(num(entry.get('amount')))} (sumber: ${String(entry.get('source') ?? '-')})`)
    })
  }
  lines.push('', '*PENGELUARAN KAS*')
  if (expenses.length === 0) lines.push('- Tidak ada pengeluaran')
  for (const key of ['nempil', 'sales', 'ops']) {
    const group = expenses.filter((entry) => entry.get('category') === key)
    if (group.length === 0) continue
    lines.push(`${categoryLabel[key]} (total ${rupiah(num(spent[key]))}):`)
    group.forEach((entry) => lines.push(`  - ${timeOnly(entry.get('createdAt'))} ${String(entry.get('note') ?? '')}: ${rupiah(num(entry.get('amount')))}`))
  }
  lines.push(`Total pengeluaran: ${rupiah(spentTotal)}`)
  lines.push(
    '',
    '*PENCOCOKAN UANG TUNAI*',
    `Uang seharusnya di laci: ${rupiah(num(data.expectedCash))}`,
    `Uang di laci (dihitung): ${rupiah(num(data.countedCash))}`,
    difference === 0 ? 'Selisih: PAS (tidak ada selisih)' : `Selisih: ${difference > 0 ? 'LEBIH' : 'KURANG'} ${rupiah(Math.abs(difference))}`,
  )
  if (data.closeNote) lines.push(`Catatan: ${String(data.closeNote)}`)

  const text = lines.join('\n')
  return { text, cashierName: String(data.cashierName ?? '') }
}

// Email failure must never block closing; the outcome is stored on the shift for follow-up.
export async function sendShiftReportEmail(shiftId: string, text: string, cashierName: string) {
  const user = reportSmtpUser.value()
  const pass = reportSmtpPass.value()
  const shiftRef = getFirestore().collection('shifts').doc(shiftId)
  if (!user || !pass || pass.startsWith('PLACEHOLDER')) {
    await shiftRef.update({ reportText: text, reportEmail: 'not_configured' })
    return false
  }
  try {
    const transport = createTransport({ service: 'gmail', auth: { user, pass } })
    const plain = text.replace(/\*/g, '')
    const html = `<pre style="font-family:Consolas,monospace;font-size:14px">${plain.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`
    await transport.sendMail({
      from: `"2goFresh POS" <${user}>`,
      to: supervisorEmails.join(','),
      subject: `Laporan Closing Shift ${cashierName} - ${new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium' })}`,
      text: plain,
      html,
    })
    await shiftRef.update({ reportText: text, reportEmail: 'sent' })
    return true
  } catch (error) {
    logger.error('Shift report email failed.', { shiftId, message: error instanceof Error ? error.message : String(error) })
    await shiftRef.update({ reportText: text, reportEmail: 'failed' })
    return false
  }
}
