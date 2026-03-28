'use client';

import { useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

// Fix default marker icon for webpack/Next.js
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

interface MapModalProps {
  lat: number;
  lng: number;
  onClose: () => void;
}

export default function MapModal({ lat, lng, onClose }: MapModalProps) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h2 className="text-lg font-semibold text-gray-800">
            📍 位置情報マップ
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-800 text-2xl leading-none cursor-pointer"
            aria-label="閉じる"
          >
            &times;
          </button>
        </div>

        {/* Coordinates */}
        <div className="px-5 py-2 text-sm text-gray-600 bg-gray-50">
          緯度: <span className="font-mono">{lat.toFixed(6)}</span>
          &nbsp;／&nbsp;
          経度: <span className="font-mono">{lng.toFixed(6)}</span>
          <a
            href={`https://www.google.com/maps?q=${lat},${lng}`}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-4 text-blue-600 hover:underline"
          >
            Google マップで開く ↗
          </a>
        </div>

        {/* Map */}
        <div className="h-96 w-full">
          <MapContainer
            center={[lat, lng]}
            zoom={15}
            className="h-full w-full"
            scrollWheelZoom={true}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <Marker position={[lat, lng]}>
              <Popup>
                {lat.toFixed(6)}, {lng.toFixed(6)}
              </Popup>
            </Marker>
          </MapContainer>
        </div>
      </div>
    </div>
  );
}
