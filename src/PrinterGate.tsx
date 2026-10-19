import {
  bluetoothSupported,
  connectBluetoothPrinter,
  connectSerialPrinter,
  paperChars,
  printTestPage,
  serialSupported,
  setPaperChars,
  usePrinter,
} from './printer'
import { useState } from 'react'

type Props = {
  displayName: string
  eyebrow: string
  continueLabel: string
  onContinue: () => void
  skipLabel?: string
  onSkip?: () => void
}

function PrinterGate({ displayName, eyebrow, continueLabel, onContinue, skipLabel, onSkip }: Props) {
  const printer = usePrinter()
  const [testError, setTestError] = useState('')
  const busy = printer.status === 'connecting'
  const chars = paperChars()

  async function test() {
    setTestError('')
    try {
      await printTestPage()
    } catch (error) {
      setTestError(error instanceof Error ? error.message : 'Tes cetak gagal.')
    }
  }

  return (
    <main className="printer-gate">
      <section className="printer-card">
        <p className="pos-eyebrow">{eyebrow}</p>
        <h1>Hubungkan printer struk</h1>
        <p>
          Halo {displayName}. Nyalakan printer <strong>Kassen BTP-3100</strong> (atau printer
          thermal Bluetooth lain), lalu hubungkan sebelum mulai berjualan.
        </p>

        <div className="printer-paper" role="group" aria-label="Lebar kertas">
          <span>Lebar kertas</span>
          <button type="button" className={chars === 48 ? 'active' : ''} onClick={() => setPaperChars(48)}>
            80 mm
          </button>
          <button type="button" className={chars === 32 ? 'active' : ''} onClick={() => setPaperChars(32)}>
            58 mm
          </button>
        </div>

        {printer.status === 'connected' ? (
          <div className="printer-ok">
            <strong>✓ Terhubung: {printer.name}</strong>
            <button type="button" onClick={test}>Cetak tes</button>
            {testError && <p role="alert">{testError}</p>}
          </div>
        ) : (
          <div className="printer-actions">
            <button type="button" disabled={busy || !bluetoothSupported} onClick={() => void connectBluetoothPrinter()}>
              {busy ? 'Menghubungkan...' : 'Hubungkan via Bluetooth'}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || !serialSupported}
              onClick={() => void connectSerialPrinter()}
            >
              Hubungkan via Serial/COM
            </button>
          </div>
        )}

        {printer.error && <p className="printer-error" role="alert">{printer.error}</p>}
        {!bluetoothSupported && !serialSupported && (
          <p className="printer-error">
            Browser ini tidak mendukung koneksi printer langsung. Buka POS di Chrome (Android/PC) atau Edge. Struk tetap bisa dicetak lewat dialog cetak browser.
          </p>
        )}

        <ul className="printer-help">
          <li><b>Bluetooth:</b> pilih printer dari daftar yang muncul (Chrome/Edge, Android atau komputer). Di HP/tablet Android, aktifkan Bluetooth dan Lokasi, dan buka lewat Chrome. iPhone/iPad tidak mendukung, gunakan dialog cetak.</li>
          <li>
            <b>Serial/COM:</b> untuk printer Bluetooth klasik di Windows. Pasangkan dulu di Pengaturan
            Bluetooth Windows, lalu pilih port COM printer.
          </li>
        </ul>

        {printer.status === 'connected' && (
          <button type="button" className="printer-continue" onClick={onContinue}>
            {continueLabel}
          </button>
        )}
        {printer.status !== 'connected' && onSkip && skipLabel && (
          <button type="button" className="printer-skip" onClick={onSkip}>
            {skipLabel}
          </button>
        )}      </section>
    </main>
  )
}

export default PrinterGate
