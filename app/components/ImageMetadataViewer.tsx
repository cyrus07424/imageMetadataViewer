'use client';

import { useState, useRef, useCallback, DragEvent } from 'react';
import Image from 'next/image';
import dynamic from 'next/dynamic';

// Dynamically import MapModal to avoid SSR issues with Leaflet
const MapModal = dynamic(() => import('./MapModal'), { ssr: false });

// Supported MIME types for display
const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/tiff',
  'image/tif',
  'image/heic',
  'image/heif',
  'image/avif',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/x-bmp',
  'image/svg+xml',
  'image/x-icon',
  'image/vnd.ms-photo',
  'image/x-raw',
];

type MetadataEntry = {
  label: string;
  value: string;
  isGps?: boolean;
  lat?: number;
  lng?: number;
};

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (val instanceof Date) return val.toLocaleString('ja-JP');
  if (val instanceof Uint8Array || val instanceof ArrayBuffer) {
    return `[Binary data: ${val instanceof Uint8Array ? val.length : (val as ArrayBuffer).byteLength} bytes]`;
  }
  if (Array.isArray(val)) {
    return val.map(formatValue).join(', ');
  }
  if (typeof val === 'object') {
    return JSON.stringify(val);
  }
  return String(val);
}

// Convert GPS DMS array to decimal degrees
function dmsToDecimal(dms: number[], ref: string): number {
  const decimal = dms[0] + dms[1] / 60 + dms[2] / 3600;
  return ref === 'S' || ref === 'W' ? -decimal : decimal;
}

// Label translation map (EXIF tag names to Japanese)
const LABEL_MAP: Record<string, string> = {
  Make: 'カメラメーカー',
  Model: 'カメラモデル',
  Software: 'ソフトウェア',
  DateTime: '撮影日時',
  DateTimeOriginal: '撮影日時（オリジナル）',
  DateTimeDigitized: 'デジタル化日時',
  ExifImageWidth: '画像幅',
  ExifImageHeight: '画像高さ',
  ImageWidth: '画像幅',
  ImageHeight: '画像高さ',
  PixelXDimension: '画像幅（ピクセル）',
  PixelYDimension: '画像高さ（ピクセル）',
  Orientation: '向き',
  XResolution: '水平解像度',
  YResolution: '垂直解像度',
  ResolutionUnit: '解像度単位',
  ColorSpace: '色空間',
  ExposureTime: '露出時間',
  FNumber: 'F値',
  ExposureProgram: '露出プログラム',
  ISOSpeedRatings: 'ISO感度',
  ISO: 'ISO感度',
  ShutterSpeedValue: 'シャッタースピード',
  ApertureValue: '絞り値',
  BrightnessValue: '輝度',
  ExposureBiasValue: '露出補正値',
  MaxApertureValue: '最大絞り値',
  MeteringMode: '測光モード',
  LightSource: '光源',
  Flash: 'フラッシュ',
  FocalLength: '焦点距離',
  FocalLengthIn35mmFilm: '35mm換算焦点距離',
  WhiteBalance: 'ホワイトバランス',
  DigitalZoomRatio: 'デジタルズーム倍率',
  SceneCaptureType: 'シーンキャプチャタイプ',
  Contrast: 'コントラスト',
  Saturation: '彩度',
  Sharpness: 'シャープネス',
  GPSLatitude: 'GPS緯度',
  GPSLongitude: 'GPS経度',
  GPSAltitude: 'GPS高度',
  GPSAltitudeRef: 'GPS高度基準',
  GPSLatitudeRef: 'GPS緯度基準',
  GPSLongitudeRef: 'GPS経度基準',
  GPSTimeStamp: 'GPS時刻',
  GPSDateStamp: 'GPS日付',
  GPSSpeed: 'GPS速度',
  GPSSpeedRef: 'GPS速度単位',
  GPSImgDirection: 'GPS方位角',
  GPSImgDirectionRef: 'GPS方位基準',
  Artist: '撮影者',
  Copyright: '著作権',
  ImageDescription: '画像説明',
  UserComment: 'ユーザーコメント',
  LensModel: 'レンズモデル',
  LensMake: 'レンズメーカー',
  LensInfo: 'レンズ情報',
  ExifVersion: 'EXIFバージョン',
  FlashPixVersion: 'FlashPixバージョン',
  ComponentsConfiguration: 'コンポーネント設定',
  CompressedBitsPerPixel: '圧縮ビット/ピクセル',
  SubjectDistance: '被写体距離',
  SubjectDistanceRange: '被写体距離範囲',
  SceneType: 'シーンタイプ',
  SensingMethod: '撮像方式',
  FileSource: 'ファイルソース',
  CFAPattern: 'CFAパターン',
  CustomRendered: 'カスタムレンダリング',
  ExposureMode: '露出モード',
  Gamma: 'ガンマ',
};

function getLabel(key: string): string {
  return LABEL_MAP[key] || key;
}

export default function ImageMetadataViewer() {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageName, setImageName] = useState<string>('');
  const [imageType, setImageType] = useState<string>('');
  const [imageSize, setImageSize] = useState<number>(0);
  const [metadata, setMetadata] = useState<MetadataEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapGps, setMapGps] = useState<{ lat: number; lng: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback(async (file: File) => {
    setLoading(true);
    setError(null);
    setMetadata([]);
    setMapGps(null);

    // Revoke previous object URL
    if (imageUrl) URL.revokeObjectURL(imageUrl);

    const url = URL.createObjectURL(file);
    setImageUrl(url);
    setImageName(file.name);
    setImageType(file.type || '不明');
    setImageSize(file.size);

    try {
      const exifr = (await import('exifr')).default;

      // Parse all available metadata
      const raw = await exifr.parse(file, {
        tiff: true,
        exif: true,
        gps: true,
        iptc: true,
        xmp: true,
        icc: true,
        jfif: true,
        ihdr: true,
        multiSegment: true,
        mergeOutput: false,
        sanitize: false,
        reviveValues: true,
        translateKeys: true,
        translateValues: true,
      });

      const entries: MetadataEntry[] = [];

      if (!raw) {
        setMetadata([]);
        setLoading(false);
        return;
      }

      // Collect GPS info for map
      let gpsLat: number | undefined;
      let gpsLng: number | undefined;

      // Flatten all segments
      for (const [, segData] of Object.entries(raw)) {
        if (typeof segData !== 'object' || segData === null || Array.isArray(segData)) continue;
        for (const [key, val] of Object.entries(segData as Record<string, unknown>)) {
          if (val === undefined || val === null) continue;
          const formatted = formatValue(val);
          if (!formatted) continue;

          const label = getLabel(key);
          entries.push({ label, value: formatted });

          // Detect GPS coordinates
          if (key === 'GPSLatitude' && Array.isArray(val)) {
            const refEntry = (segData as Record<string, unknown>)['GPSLatitudeRef'];
            gpsLat = dmsToDecimal(val as number[], String(refEntry ?? 'N'));
          }
          if (key === 'GPSLongitude' && Array.isArray(val)) {
            const refEntry = (segData as Record<string, unknown>)['GPSLongitudeRef'];
            gpsLng = dmsToDecimal(val as number[], String(refEntry ?? 'E'));
          }
          // exifr may return decimal directly
          if (key === 'latitude' && typeof val === 'number') gpsLat = val;
          if (key === 'longitude' && typeof val === 'number') gpsLng = val;
        }
      }

      // Also check top-level GPS from gps() helper
      try {
        const gps = await exifr.gps(file);
        if (gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number') {
          gpsLat = gps.latitude;
          gpsLng = gps.longitude;
        }
      } catch {
        // Ignore GPS parsing error
      }

      if (gpsLat !== undefined && gpsLng !== undefined) {
        setMapGps({ lat: gpsLat, lng: gpsLng });
        // Add GPS map entry as special item at the top
        entries.unshift({
          label: 'GPS位置情報',
          value: `${gpsLat.toFixed(6)}, ${gpsLng.toFixed(6)}`,
          isGps: true,
          lat: gpsLat,
          lng: gpsLng,
        });
      }

      setMetadata(entries);
    } catch (err) {
      console.error('Metadata parsing error:', err);
      setError('メタデータの読み取りに失敗しました。このファイルにはメタデータが含まれていない可能性があります。');
    }

    setLoading(false);
  }, [imageUrl]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 to-blue-50 py-10">
      <div className="max-w-3xl mx-auto px-4">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-800">🖼️ 画像メタデータビューア</h1>
          <p className="text-gray-500 mt-2 text-sm">
            JPEG / PNG / TIFF / HEIC / AVIF / WebP など多くの形式に対応
          </p>
        </div>

        {/* Upload area */}
        <div
          className={`relative border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-colors
            ${isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300 bg-white hover:border-blue-400 hover:bg-blue-50/40'}`}
          onClick={() => fileInputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={SUPPORTED_IMAGE_TYPES.join(',')}
            className="hidden"
            onChange={handleFileChange}
          />
          {isDragging ? (
            <p className="text-blue-600 font-semibold text-lg">ここにドロップ！</p>
          ) : (
            <>
              <div className="text-5xl mb-3">📂</div>
              <p className="text-gray-600 font-medium">クリックして画像を選択</p>
              <p className="text-gray-400 text-sm mt-1">またはここにドラッグ＆ドロップ</p>
            </>
          )}
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent" />
            <span className="ml-3 text-gray-600">メタデータを解析中...</span>
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="mt-4 p-4 bg-yellow-50 border border-yellow-300 rounded-xl text-yellow-800 text-sm">
            ⚠️ {error}
          </div>
        )}

        {/* Thumbnail */}
        {imageUrl && !loading && (
          <div className="mt-6 flex flex-col items-center">
            <div className="relative max-w-sm w-full shadow-lg rounded-xl overflow-hidden bg-gray-100">
              <Image
                src={imageUrl}
                alt={imageName}
                width={480}
                height={360}
                className="w-full h-auto object-contain max-h-80"
                unoptimized
              />
            </div>
            <p className="mt-2 text-gray-500 text-sm">{imageName}</p>

            {/* File info */}
            <div className="mt-3 flex gap-4 text-xs text-gray-500">
              <span>形式: <span className="font-medium text-gray-700">{imageType || '不明'}</span></span>
              <span>サイズ: <span className="font-medium text-gray-700">{formatFileSize(imageSize)}</span></span>
            </div>

            {/* GPS map button */}
            {mapGps && (
              <button
                onClick={() => setMapGps(mapGps)}
                className="mt-4 px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium shadow"
              >
                🗺️ 地図で位置情報を確認
              </button>
            )}
          </div>
        )}

        {/* Metadata table */}
        {!loading && metadata.length > 0 && (
          <div className="mt-8 bg-white rounded-2xl shadow-md overflow-hidden">
            <div className="px-6 py-4 border-b bg-gray-50">
              <h2 className="text-lg font-semibold text-gray-700">
                📋 メタデータ一覧
                <span className="ml-2 text-sm font-normal text-gray-400">({metadata.length} 件)</span>
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-gray-500 uppercase text-xs tracking-wide">
                    <th className="text-left px-6 py-3 w-1/3 border-b">項目</th>
                    <th className="text-left px-6 py-3 border-b">値</th>
                  </tr>
                </thead>
                <tbody>
                  {metadata.map((entry, i) => (
                    <tr
                      key={i}
                      className={`border-b last:border-0 transition-colors ${
                        entry.isGps ? 'bg-blue-50 hover:bg-blue-100' : i % 2 === 0 ? 'bg-white hover:bg-gray-50' : 'bg-gray-50/60 hover:bg-gray-100'
                      }`}
                    >
                      <td className="px-6 py-3 font-medium text-gray-600 whitespace-nowrap">
                        {entry.isGps && <span className="mr-1">📍</span>}
                        {entry.label}
                      </td>
                      <td className="px-6 py-3 text-gray-800 break-all">
                        {entry.isGps && entry.lat !== undefined && entry.lng !== undefined ? (
                          <button
                            onClick={() => setMapGps({ lat: entry.lat!, lng: entry.lng! })}
                            className="text-blue-600 hover:underline font-mono"
                          >
                            {entry.value} 🗺️
                          </button>
                        ) : (
                          <span className="font-mono">{entry.value}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* No metadata message */}
        {!loading && imageUrl && metadata.length === 0 && !error && (
          <div className="mt-6 p-4 bg-gray-50 border border-gray-200 rounded-xl text-gray-500 text-sm text-center">
            ℹ️ この画像にはメタデータが含まれていません。
          </div>
        )}

        <footer className="text-center text-gray-400 mt-10 text-sm">
          &copy; 2026 <a href="https://github.com/cyrus07424" target="_blank" rel="noopener noreferrer" className="hover:underline">cyrus</a>
        </footer>
      </div>

      {/* Map Modal */}
      {mapGps && (
        <MapModal
          lat={mapGps.lat}
          lng={mapGps.lng}
          onClose={() => setMapGps(null)}
        />
      )}
    </div>
  );
}
