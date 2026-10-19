import { storeInfo } from './storeInfo'

export type CatalogKind = 'retail' | 'b2b' | 'both'

export type CatalogRow = {
  sku: string
  name: string
  category: string
  unit: string
  minQty: number
  retailPrice: number
  b2bPrice: number | null
}

const idr = (value: number) => `Rp${new Intl.NumberFormat('id-ID').format(value)}`
const qty = (value: number) => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 }).format(value)

export const kindLabel: Record<CatalogKind, string> = {
  retail: 'Katalog Harga Retail',
  b2b: 'Katalog Harga B2B',
  both: 'Katalog Harga Retail & B2B',
}

// Produk tanpa harga B2B tidak ikut katalog B2B.
export function rowsForKind(rows: CatalogRow[], kind: CatalogKind) {
  return kind === 'b2b' ? rows.filter((row) => row.b2bPrice !== null) : rows
}

function columnsFor(kind: CatalogKind) {
  return kind === 'retail'
    ? ['Produk', 'Satuan', 'Min. Beli', 'Harga Retail']
    : kind === 'b2b'
      ? ['Produk', 'Satuan', 'Harga B2B']
      : ['Produk', 'Satuan', 'Min. Beli (Retail)', 'Harga Retail', 'Harga B2B']
}

function valuesFor(row: CatalogRow, kind: CatalogKind) {
  return kind === 'retail'
    ? [row.name, row.unit, `${qty(row.minQty)} ${row.unit}`, idr(row.retailPrice)]
    : kind === 'b2b'
      ? [row.name, row.unit, idr(row.b2bPrice ?? 0)]
      : [
          row.name,
          row.unit,
          `${qty(row.minQty)} ${row.unit}`,
          idr(row.retailPrice),
          row.b2bPrice === null ? '-' : idr(row.b2bPrice),
        ]
}

function groupByCategory(rows: CatalogRow[]) {
  const groups = new Map<string, CatalogRow[]>()
  for (const row of rows) {
    const list = groups.get(row.category) ?? []
    list.push(row)
    groups.set(row.category, list)
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'id'))
}

const dateLabel = () => new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })

export const storeContactLines = [
  storeInfo.address,
  `WhatsApp: ${storeInfo.whatsapp}  |  Email: ${storeInfo.email}`,
  `Instagram: ${storeInfo.instagram}  |  Shopee: ${storeInfo.shopee}  |  Website: ${storeInfo.websiteLabel}`,
]

export function catalogWhatsAppText(rows: CatalogRow[], kind: CatalogKind) {
  const lines = [`*${kindLabel[kind].toUpperCase()} - ${storeInfo.name}*`, `Harga per ${dateLabel()}`, '']
  for (const [category, items] of groupByCategory(rows)) {
    lines.push(`*${category}*`)
    for (const item of items) {
      const price =
        kind === 'retail'
          ? `${idr(item.retailPrice)}/${item.unit} (min ${qty(item.minQty)} ${item.unit})`
          : kind === 'b2b'
            ? `${idr(item.b2bPrice ?? 0)}/${item.unit}`
            : `Retail ${idr(item.retailPrice)} (min ${qty(item.minQty)}) | B2B ${
                item.b2bPrice === null ? '-' : idr(item.b2bPrice)
              }/${item.unit}`
      lines.push(`- ${item.name}: ${price}`)
    }
    lines.push('')
  }
  lines.push(
    'Harga dapat berubah sewaktu-waktu.',
    '',
    `*${storeInfo.name}*`,
    storeInfo.address,
    `WA: ${storeInfo.whatsapp}`,
    `Email: ${storeInfo.email}`,
    `IG: ${storeInfo.instagram}`,
    `Shopee: ${storeInfo.shopee}`,
    `${storeInfo.qrCaption}: ${storeInfo.websiteUrl}`,
  )
  return lines.join('\n')
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const fileStamp = () => new Date().toISOString().slice(0, 10)

export async function downloadCatalogExcel(rows: CatalogRow[], kind: CatalogKind) {
  const { default: writeExcelFile } = await import('write-excel-file/universal')
  const header = columnsFor(kind).map((value) => ({ value, fontWeight: 'bold' as const, backgroundColor: '#E8F3EC' }))
  const money = (value: number) => ({ value, format: '"Rp"#,##0' })
  const sheet: unknown[][] = [
    [{ value: `${storeInfo.name} - ${kindLabel[kind]}`, fontWeight: 'bold' as const }],
    [`Harga per ${dateLabel()}`],
    ...storeContactLines.map((line) => [line]),
    [],
    ['Kategori', ...header.map((cell) => cell)],
  ]
  for (const [category, items] of groupByCategory(rows)) {
    for (const item of items) {
      const priceCells =
        kind === 'retail'
          ? [item.name, item.unit, item.minQty, money(item.retailPrice)]
          : kind === 'b2b'
            ? [item.name, item.unit, money(item.b2bPrice ?? 0)]
            : [item.name, item.unit, item.minQty, money(item.retailPrice), item.b2bPrice === null ? '-' : money(item.b2bPrice)]
      sheet.push([category, ...priceCells])
    }
  }
  sheet.push([], ['Harga dapat berubah sewaktu-waktu.'], [`${storeInfo.qrCaption}: ${storeInfo.websiteUrl}`])
  // @ts-expect-error sel campuran (string/angka/objek) valid untuk write-excel-file
  const blob: Blob = await writeExcelFile(sheet).toBlob()
  triggerDownload(blob, `katalog-2gofresh-${kind}-${fileStamp()}.xlsx`)
}

export async function buildCatalogPdf(rows: CatalogRow[], kind: CatalogKind) {
  const [{ jsPDF }, { default: autoTable }, { default: QRCode }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    import('qrcode'),
  ])
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const width = doc.internal.pageSize.getWidth()
  const height = doc.internal.pageSize.getHeight()
  const margin = 36

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.text(`${storeInfo.name} - ${kindLabel[kind]}`, margin, 46)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(90)
  doc.text(`Harga per ${dateLabel()}`, margin, 62)
  storeContactLines.forEach((line, index) => doc.text(line, margin, 76 + index * 12))
  doc.setTextColor(0)

  const body: (string | { content: string; colSpan: number; styles: Record<string, unknown> })[][] = []
  const columns = columnsFor(kind)
  for (const [category, items] of groupByCategory(rows)) {
    body.push([
      {
        content: category,
        colSpan: columns.length,
        styles: { fillColor: [232, 243, 236], fontStyle: 'bold', textColor: [24, 70, 48] },
      },
    ])
    for (const item of items) body.push(valuesFor(item, kind))
  }

  autoTable(doc, {
    startY: 76 + storeContactLines.length * 12 + 8,
    head: [columns],
    body,
    margin: { left: margin, right: margin, bottom: 54 },
    styles: { fontSize: 9, cellPadding: 4 },
    headStyles: { fillColor: [24, 70, 48] },
    columnStyles: Object.fromEntries(
      columns.map((_, index) => [index, index >= 2 ? { halign: 'right' } : {}]),
    ),
    didDrawPage: () => {
      doc.setFontSize(8)
      doc.setTextColor(90)
      doc.text(
        `${storeInfo.name} | WA ${storeInfo.whatsapp} | ${storeInfo.email} | ${storeInfo.websiteLabel}`,
        margin,
        height - 24,
      )
      doc.text(`Hal. ${doc.getCurrentPageInfo().pageNumber}`, width - margin, height - 24, { align: 'right' })
      doc.setTextColor(0)
    },
  })

  // Tempel QR di halaman terakhir; pindah halaman bila ruang tidak cukup.
  const qr = await QRCode.toDataURL(storeInfo.websiteUrl, { margin: 1, width: 240 })
  let y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 20
  if (y + 120 > height - 40) {
    doc.addPage()
    y = 50
  }
  doc.addImage(qr, 'PNG', margin, y, 90, 90)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.text(storeInfo.qrCaption, margin + 102, y + 38)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text(storeInfo.websiteLabel, margin + 102, y + 54)
  doc.setFontSize(8)
  doc.setTextColor(90)
  doc.text('Harga dapat berubah sewaktu-waktu.', margin + 102, y + 70)
  return doc
}

export async function downloadCatalogPdf(rows: CatalogRow[], kind: CatalogKind) {
  const doc = await buildCatalogPdf(rows, kind)
  triggerDownload(doc.output('blob'), `katalog-2gofresh-${kind}-${fileStamp()}.pdf`)
}
