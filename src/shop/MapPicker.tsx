import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { storeLocation } from '../shipping'

export type Point = { lat: number; lng: number }

const pin = (className: string) =>
  L.divIcon({ className: `map-pin ${className}`, iconSize: [26, 26], iconAnchor: [13, 26] })

function MapPicker({ value, onChange }: { value: Point | null; onChange: (point: Point) => void }) {
  const element = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const marker = useRef<L.Marker | null>(null)
  const onChangeRef = useRef(onChange)
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    onChangeRef.current = onChange
  })

  useEffect(() => {
    if (!element.current || map.current) return
    const instance = L.map(element.current, {
      center: [storeLocation.lat, storeLocation.lng],
      zoom: 14,
      scrollWheelZoom: false,
    })
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap',
    }).addTo(instance)
    L.marker([storeLocation.lat, storeLocation.lng], { icon: pin('store'), interactive: false }).addTo(instance)
    instance.on('click', (event: L.LeafletMouseEvent) =>
      onChangeRef.current({ lat: event.latlng.lat, lng: event.latlng.lng }),
    )
    map.current = instance
    return () => {
      instance.remove()
      map.current = null
      marker.current = null
    }
  }, [])

  useEffect(() => {
    const instance = map.current
    if (!instance || !value) return
    if (!marker.current) {
      marker.current = L.marker([value.lat, value.lng], { icon: pin('home'), draggable: true }).addTo(instance)
      marker.current.on('dragend', () => {
        const position = marker.current?.getLatLng()
        if (position) onChangeRef.current({ lat: position.lat, lng: position.lng })
      })
    } else {
      marker.current.setLatLng([value.lat, value.lng])
    }
    instance.panTo([value.lat, value.lng])
  }, [value])

  function locate() {
    setMessage('')
    if (!navigator.geolocation) {
      setMessage('Perangkat tidak mendukung lokasi. Ketuk peta untuk menandai.')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        onChange({ lat: position.coords.latitude, lng: position.coords.longitude })
        map.current?.setZoom(17)
      },
      () => setMessage('Izin lokasi ditolak. Ketuk peta untuk menandai rumah Anda.'),
      { enableHighAccuracy: true, timeout: 10000 },
    )
  }

  async function search(event: React.FormEvent) {
    event.preventDefault()
    if (query.trim().length < 3) return
    setMessage('Mencari...')
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&countrycodes=id&limit=1&q=${encodeURIComponent(query)}`,
      )
      const results = (await response.json()) as { lat: string; lon: string }[]
      if (results.length === 0) {
        setMessage('Lokasi tidak ditemukan. Coba kata kunci lain atau ketuk peta.')
        return
      }
      setMessage('')
      onChange({ lat: Number(results[0].lat), lng: Number(results[0].lon) })
      map.current?.setZoom(17)
    } catch {
      setMessage('Pencarian gagal. Ketuk peta untuk menandai lokasi.')
    }
  }

  return (
    <div className="map-picker">
      <form className="map-search" onSubmit={(event) => void search(event)}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Cari alamat / nama tempat"
          aria-label="Cari alamat"
        />
        <button type="submit">Cari</button>
        <button type="button" onClick={locate}>Lokasi saya</button>
      </form>
      <div ref={element} className="map-canvas" role="application" aria-label="Peta lokasi pengantaran" />
      <p className="map-hint">
        {message ||
          (value
            ? 'Geser pin merah atau ketuk peta untuk menyesuaikan titik rumah.'
            : 'Ketuk peta untuk menandai titik rumah Anda (pin hijau = toko kami).')}
      </p>
    </div>
  )
}

export default MapPicker
