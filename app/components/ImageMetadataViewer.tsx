'use client';

import { useState, useRef, useCallback, useEffect, DragEvent } from 'react';
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

// ─── PNG / JUMBF helpers ──────────────────────────────────────────────────────

// Maximum thumbnail height in pixels (matches Tailwind's max-h-80 = 320px)
const THUMBNAIL_MAX_HEIGHT = 320;

// Human-readable PNG color type names (IHDR byte 17)
const PNG_COLOR_TYPES: Record<number, string> = {
  0: 'Grayscale',
  2: 'RGB',
  3: 'Indexed',
  4: 'Grayscale with Alpha',
  6: 'RGB with Alpha',
};

// Derive file type label and extension from MIME type / file name
function getFileTypeInfo(mime: string, fileName: string): { fileType: string; fileTypeExt: string } {
  const mimeMap: Record<string, { fileType: string; fileTypeExt: string }> = {
    'image/jpeg': { fileType: 'JPEG', fileTypeExt: 'jpg' },
    'image/jpg': { fileType: 'JPEG', fileTypeExt: 'jpg' },
    'image/png': { fileType: 'PNG', fileTypeExt: 'png' },
    'image/tiff': { fileType: 'TIFF', fileTypeExt: 'tif' },
    'image/tif': { fileType: 'TIFF', fileTypeExt: 'tif' },
    'image/gif': { fileType: 'GIF', fileTypeExt: 'gif' },
    'image/webp': { fileType: 'WebP', fileTypeExt: 'webp' },
    'image/heic': { fileType: 'HEIC', fileTypeExt: 'heic' },
    'image/heif': { fileType: 'HEIF', fileTypeExt: 'heif' },
    'image/avif': { fileType: 'AVIF', fileTypeExt: 'avif' },
    'image/bmp': { fileType: 'BMP', fileTypeExt: 'bmp' },
    'image/x-bmp': { fileType: 'BMP', fileTypeExt: 'bmp' },
    'image/svg+xml': { fileType: 'SVG', fileTypeExt: 'svg' },
    'image/x-icon': { fileType: 'ICO', fileTypeExt: 'ico' },
    'image/vnd.ms-photo': { fileType: 'JPEGXR', fileTypeExt: 'jxr' },
  };
  if (mime && mimeMap[mime]) return mimeMap[mime];
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return { fileType: ext.toUpperCase(), fileTypeExt: ext };
}

// Compute SHA-256 checksum of an ArrayBuffer; returns hex string or '' on error
async function computeChecksum(buffer: ArrayBuffer): Promise<string> {
  if (!crypto?.subtle) return '';
  try {
    const hash = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return '';
  }
}

// Return the first `byteCount` bytes of buffer as uppercase hex pairs separated by spaces
function extractRawHeader(buffer: ArrayBuffer, byteCount = 80): string {
  const bytes = new Uint8Array(buffer, 0, Math.min(byteCount, buffer.byteLength));
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

// Find the index of the first 0x00 byte in arr at or after `from`; returns -1 if not found
function findNullTerminator(arr: Uint8Array, from: number): number {
  for (let i = from; i < arr.length; i++) {
    if (arr[i] === 0) return i;
  }
  return -1;
}

// Read one ISOBMFF/JUMBF box from data[offset..]; returns null if the box is malformed
function readJumbfBox(
  data: Uint8Array,
  offset: number,
): { totalSize: number; type: string; payload: Uint8Array } | null {
  if (offset + 8 > data.length) return null;

  let size =
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0;
  const type = String.fromCharCode(
    data[offset + 4],
    data[offset + 5],
    data[offset + 6],
    data[offset + 7],
  );
  let headerSize = 8;

  if (size === 1) {
    // 64-bit extended size – use only the lower 32 bits (practical file sizes)
    if (offset + 16 > data.length) return null;
    size =
      ((data[offset + 12] << 24) |
        (data[offset + 13] << 16) |
        (data[offset + 14] << 8) |
        data[offset + 15]) >>>
      0;
    headerSize = 16;
  } else if (size === 0) {
    size = data.length - offset;
  }

  if (size < headerSize || offset + size > data.length) return null;

  return {
    totalSize: size,
    type,
    payload: data.slice(offset + headerSize, offset + size),
  };
}

// Format a 16-byte JUMBF UUID.
// If bytes 0-3 are all printable ASCII → "(text)-XXXX-XXXX-XXXXXXXXXXXXXXXX"
// Otherwise → standard "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
function formatJumbfUuid(bytes: Uint8Array): string {
  const isAscii = (b: number) => b >= 0x20 && b < 0x7f;
  if (Array.from(bytes.slice(0, 4)).every(isAscii)) {
    const text = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const rest = Array.from(bytes.slice(4))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return `(${text})-${rest.slice(0, 4)}-${rest.slice(4, 8)}-${rest.slice(8)}`;
  }
  const hex = Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Parse a JUMD (JUMBF Description Box) payload: [16 UUID][1 flags][label\0?]
function parseJumd(payload: Uint8Array): { uuid: string; label: string } {
  if (payload.length < 17) return { uuid: '', label: '' };
  const uuid = formatJumbfUuid(payload.slice(0, 16));
  const flags = payload[16];
  const hasLabel = (flags & 0x02) !== 0;
  let label = '';
  if (hasLabel && payload.length > 17) {
    const nullIdx = findNullTerminator(payload, 17);
    const end = nullIdx >= 0 ? nullIdx : payload.length;
    label = new TextDecoder('utf-8', { fatal: false }).decode(payload.slice(17, end));
  }
  return { uuid, label };
}

// Extract useful fields from a parsed C2PA JSON assertion box
function extractC2paJsonFields(
  json: Record<string, unknown>,
  label: string,
  result: Record<string, unknown>,
): void {
  if (label === 'c2pa.actions' || label === 'c2pa.actions.v2') {
    const actions = Array.isArray(json.actions)
      ? (json.actions as Record<string, unknown>[])
      : [];
    if (actions.length > 0) {
      const action = actions[0];
      if (typeof action.action === 'string') result['ActionsAction'] = action.action;
      if (typeof action.when === 'string') result['ActionsWhen'] = action.when;
      const sa = action.softwareAgent as Record<string, unknown> | undefined;
      if (sa && typeof sa.name === 'string') result['ActionsSoftwareAgentName'] = sa.name;
      if (typeof action.digitalSourceType === 'string')
        result['ActionsDigitalSourceType'] = action.digitalSourceType;
      if (typeof action.description === 'string')
        result['ActionsDescription'] = action.description;
    }
    const meta = json.metadata as Record<string, unknown> | undefined;
    if (meta && meta.allActionsIncluded !== undefined) {
      result['AllActionsIncluded'] = String(meta.allActionsIncluded);
    }
  }
}

// Recursively traverse the content (payload) of a jumb box.
// payload layout: [jumd box][content box…]
// depth 0 → store JUMDType / JUMDLabel in result
function traverseJumbfContent(
  data: Uint8Array,
  result: Record<string, unknown>,
  depth: number,
): void {
  let offset = 0;

  // First box must be jumd
  const jumdBox = readJumbfBox(data, offset);
  if (!jumdBox || jumdBox.type !== 'jumd') return;
  const { uuid, label } = parseJumd(jumdBox.payload);

  if (depth === 0) {
    if (uuid) result['JUMDType'] = uuid;
    if (label) result['JUMDLabel'] = label;
  }

  offset += jumdBox.totalSize;

  // Process remaining content boxes
  while (offset < data.length) {
    const box = readJumbfBox(data, offset);
    if (!box) break;

    if (box.type === 'jumb') {
      // Recurse into nested jumb (manifest, assertion, etc.)
      traverseJumbfContent(box.payload, result, depth + 1);
    } else if (box.type === 'json' && label) {
      // JSON assertion content
      try {
        const text = new TextDecoder('utf-8', { fatal: false }).decode(box.payload);
        const json = JSON.parse(text) as Record<string, unknown>;
        extractC2paJsonFields(json, label, result);
      } catch {
        // Ignore malformed JSON
      }
    }
    // CBOR boxes (claim, hash data) are skipped – would need a CBOR parser

    offset += box.totalSize;
  }
}

// Parse PNG chunks; returns a flat metadata record.
// Extracts: IHDR fields + C2PA / JUMBF data from caBX chunk.
function parsePngChunks(buffer: ArrayBuffer): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const data = new Uint8Array(buffer);

  // Verify PNG signature
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (data[i] !== PNG_SIG[i]) return result;
  }

  const view = new DataView(buffer);
  let offset = 8;

  while (offset + 12 <= buffer.byteLength) {
    const chunkLength = view.getUint32(offset, false);
    const chunkType = String.fromCharCode(
      data[offset + 4],
      data[offset + 5],
      data[offset + 6],
      data[offset + 7],
    );

    if (chunkType === 'IHDR' && chunkLength >= 13) {
      result['ImageWidth'] = view.getUint32(offset + 8, false);
      result['ImageHeight'] = view.getUint32(offset + 12, false);
      result['BitDepth'] = data[offset + 16];
      const colorTypeNum = data[offset + 17];
      result['ColorType'] = PNG_COLOR_TYPES[colorTypeNum] ?? `Type ${colorTypeNum}`;
      const cm = data[offset + 18];
      result['Compression'] = cm === 0 ? 'Deflate/Inflate' : `Method ${cm}`;
      const fm = data[offset + 19];
      result['Filter'] = fm === 0 ? 'Adaptive' : `Method ${fm}`;
      const im = data[offset + 20];
      result['Interlace'] = im === 0 ? 'Noninterlaced' : 'Adam7 Interlace';
    } else if (chunkType === 'caBX' && chunkLength > 0) {
      try {
        const caBxData = data.slice(offset + 8, offset + 8 + chunkLength);
        const rootBox = readJumbfBox(caBxData, 0);
        if (rootBox && rootBox.type === 'jumb') {
          traverseJumbfContent(rootBox.payload, result, 0);
        }
      } catch {
        // Ignore C2PA parse errors
      }
    } else if (chunkType === 'IEND') {
      break;
    }

    offset += 12 + chunkLength; // length(4) + type(4) + data(chunkLength) + crc(4)
  }

  return result;
}

// Format file size in human-readable form
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

type MetadataEntry = {
  label: string;
  value: string;
  isGps?: boolean;
  lat?: number;
  lng?: number;
};

// Normalized (0–1) region from XMP RegionInfo / Regions metadata
type ImageRegion = {
  name: string;
  type?: string;
  description?: string;
  x: number; // center x
  y: number; // center y
  w: number; // width
  h: number; // height
};

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (val instanceof Date) return val.toLocaleString('ja-JP');
  if (val instanceof Uint8Array || val instanceof ArrayBuffer) {
    const byteLen = val instanceof Uint8Array ? val.length : (val as ArrayBuffer).byteLength;
    return `(Binary data ${byteLen} bytes)`;
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
  // ── File metadata ──
  FileName: 'ファイル名',
  FileSize: 'ファイルサイズ',
  FileType: 'ファイルタイプ',
  FileTypeExtension: 'ファイル拡張子',
  MIMEType: 'MIMEタイプ',
  Checksum: 'チェックサム (SHA-256)',
  // ── Camera & equipment ──
  Make: 'カメラメーカー',
  Model: 'カメラモデル',
  Software: 'ソフトウェア',
  // ── Date/time ──
  DateTime: '撮影日時',
  DateTimeOriginal: '撮影日時（オリジナル）',
  DateTimeDigitized: 'デジタル化日時',
  // ── Image dimensions ──
  ExifImageWidth: '画像幅',
  ExifImageHeight: '画像高さ',
  ImageWidth: '画像幅',
  ImageHeight: '画像高さ',
  PixelXDimension: '画像幅（ピクセル）',
  PixelYDimension: '画像高さ（ピクセル）',
  // ── Resolution & orientation ──
  Orientation: '向き',
  XResolution: '水平解像度',
  YResolution: '垂直解像度',
  ResolutionUnit: '解像度単位',
  ColorSpace: '色空間',
  // ── Exposure ──
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
  // ── Metering / lighting ──
  MeteringMode: '測光モード',
  LightSource: '光源',
  Flash: 'フラッシュ',
  // ── Focal / zoom ──
  FocalLength: '焦点距離',
  FocalLengthIn35mmFilm: '35mm換算焦点距離',
  WhiteBalance: 'ホワイトバランス',
  DigitalZoomRatio: 'デジタルズーム倍率',
  // ── Image processing ──
  SceneCaptureType: 'シーンキャプチャタイプ',
  Contrast: 'コントラスト',
  Saturation: '彩度',
  Sharpness: 'シャープネス',
  // ── GPS ──
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
  // ── Copyright / description ──
  Artist: '撮影者',
  Copyright: '著作権',
  ImageDescription: '画像説明',
  UserComment: 'ユーザーコメント',
  // ── Lens ──
  LensModel: 'レンズモデル',
  LensMake: 'レンズメーカー',
  LensInfo: 'レンズ情報',
  // ── EXIF misc ──
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
  // ── PNG-specific (IHDR) ──
  BitDepth: 'ビット深度',
  ColorType: 'カラータイプ',
  Compression: '圧縮方式',
  Filter: 'フィルター',
  Interlace: 'インターレース',
  // ── C2PA / JUMBF ──
  JUMDType: 'JUMBFタイプ (UUID)',
  JUMDLabel: 'JUMBFラベル',
  ActionsAction: 'C2PAアクション',
  ActionsWhen: 'C2PAアクション日時',
  ActionsSoftwareAgentName: 'ソフトウェアエージェント',
  ActionsDigitalSourceType: 'デジタルソースタイプ',
  ActionsDescription: 'アクション説明',
  AllActionsIncluded: '全アクション含む',
  // ── XMP ──
  InstanceID: 'インスタンスID',
  // ── Computed ──
  ImageSize: '画像サイズ',
  Megapixels: 'メガピクセル',
  Category: 'カテゴリ',
  RawHeader: 'ファイルヘッダー (Hex)',
};

// Extract image regions from XMP RegionInfo / Regions metadata (MWG standard)
function extractImageRegions(raw: Record<string, Record<string, unknown>> | null | undefined): ImageRegion[] {
  if (!raw) return [];
  const xmp = raw.xmp;
  if (!xmp || typeof xmp !== 'object') return [];

  const regionInfoRaw =
    (xmp as Record<string, unknown>).RegionInfo ??
    (xmp as Record<string, unknown>).Regions;
  if (!regionInfoRaw || typeof regionInfoRaw !== 'object' || Array.isArray(regionInfoRaw)) return [];
  const regionInfo = regionInfoRaw as Record<string, unknown>;

  const regionList = regionInfo.RegionList;
  if (!Array.isArray(regionList)) return [];

  const result: ImageRegion[] = [];
  for (const item of regionList) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;

    const areaRaw = r.Area;
    if (!areaRaw || typeof areaRaw !== 'object' || Array.isArray(areaRaw)) continue;
    const area = areaRaw as Record<string, unknown>;

    // Only handle normalized coordinates (0–1 fractions)
    const unit = area.unit;
    if (unit !== undefined && unit !== 'normalized') continue;

    const toNum = (v: unknown) => (typeof v === 'number' ? v : parseFloat(String(v)));
    const x = toNum(area.x);
    const y = toNum(area.y);
    const w = toNum(area.w);
    const h = toNum(area.h);

    if ([x, y, w, h].some(isNaN)) continue;
    if (x < 0 || x > 1 || y < 0 || y > 1 || w <= 0 || w > 1 || h <= 0 || h > 1) continue;

    result.push({
      name: typeof r.Name === 'string' ? r.Name : '',
      type: typeof r.Type === 'string' ? r.Type : undefined,
      description: typeof r.Description === 'string' ? r.Description : undefined,
      x,
      y,
      w,
      h,
    });
  }
  return result;
}

// Return numeric EXIF orientation (1–8, default 1 = normal) from raw parsed metadata.
// exifr may return the value as a number or as a translated string depending on options.
function getExifOrientation(raw: Record<string, Record<string, unknown>> | null | undefined): number {
  if (!raw) return 1;
  const o =
    (raw.tiff as Record<string, unknown> | undefined)?.Orientation ??
    (raw.exif as Record<string, unknown> | undefined)?.Orientation;
  if (typeof o === 'number' && o >= 1 && o <= 8) return o;
  if (typeof o === 'string') {
    // Match the translated strings that exifr emits (case-insensitive).
    // Ordered from most specific to least specific to avoid false matches.
    const s = o.toLowerCase();
    if (s.includes('mirror horizontal') && s.includes('270')) return 5;
    if (s.includes('mirror horizontal') && s.includes('90'))  return 7;
    if (s.includes('mirror horizontal')) return 2;
    if (s.includes('mirror vertical'))   return 4;
    if (s.includes('270') || s.includes('ccw')) return 8;  // "Rotate 270 CW" = 90 CCW
    if (s.includes('90'))  return 6;
    if (s.includes('180')) return 3;
  }
  return 1;
}

// Transform a region's center-based coordinates from stored-pixel space into the
// display space defined by the EXIF orientation tag.  This is needed because XMP
// region coordinates are recorded relative to the raw pixel grid while browsers
// display the image after applying the EXIF rotation.
//
// Transformation derivations (normalized center coordinates, width/height):
//   1 – normal          : no change
//   2 – mirror H        : x' = 1-x
//   3 – rotate 180°     : x' = 1-x,   y' = 1-y
//   4 – mirror V        : y' = 1-y
//   5 – transpose       : x' = y,     y' = x,   w/h swap
//   6 – rotate 90° CW   : x' = 1-y,   y' = x,   w/h swap
//   7 – transverse      : x' = 1-y,   y' = 1-x, w/h swap
//   8 – rotate 90° CCW  : x' = y,     y' = 1-x, w/h swap
function transformRegionForOrientation(region: ImageRegion, orientation: number): ImageRegion {
  const { x, y, w, h } = region;
  switch (orientation) {
    case 2: return { ...region, x: 1 - x };
    case 3: return { ...region, x: 1 - x, y: 1 - y };
    case 4: return { ...region, y: 1 - y };
    case 5: return { ...region, x: y, y: x, w: h, h: w };
    case 6: return { ...region, x: 1 - y, y: x, w: h, h: w };
    case 7: return { ...region, x: 1 - y, y: 1 - x, w: h, h: w };
    case 8: return { ...region, x: y, y: 1 - x, w: h, h: w };
    default: return region;  // 1 = normal, no transform
  }
}

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
  const [regions, setRegions] = useState<ImageRegion[]>([]);
  const [thumbBounds, setThumbBounds] = useState<{
    imgW: number;
    imgH: number;
    imgLeft: number;
    imgTop: number;
  } | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const thumbContainerRef = useRef<HTMLDivElement>(null);

  const processFile = useCallback(async (file: File) => {
    setLoading(true);
    setError(null);
    setMetadata([]);
    setMapGps(null);
    setRegions([]);
    setThumbBounds(null);
    setLightboxOpen(false);

    // Revoke previous object URL
    if (imageUrl) URL.revokeObjectURL(imageUrl);

    const url = URL.createObjectURL(file);
    setImageUrl(url);
    setImageName(file.name);
    setImageType(file.type || '不明');
    setImageSize(file.size);

    try {
      // Read file once; reuse buffer for checksum, raw-header, PNG parsing and exifr
      const [buffer, exifrMod] = await Promise.all([
        file.arrayBuffer(),
        import('exifr'),
      ]);
      const exifr = exifrMod.default;

      const [checksum, raw] = await Promise.all([
        computeChecksum(buffer),
        exifr.parse(buffer, {
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
        }),
      ]);

      const rawHeader = extractRawHeader(buffer);
      const pngMeta = parsePngChunks(buffer); // {} for non-PNG files

      const entries: MetadataEntry[] = [];
      const addedKeys = new Set<string>();

      // Helper – add entry only once (first writer wins); skip empty strings
      const addEntry = (key: string, value: string, extra?: Partial<MetadataEntry>) => {
        if (!addedKeys.has(key) && value !== '') {
          addedKeys.add(key);
          entries.push({ label: getLabel(key), value, ...extra });
        }
      };

      // ── 1. File-level metadata ────────────────────────────────────────────
      const { fileType, fileTypeExt } = getFileTypeInfo(file.type, file.name);
      addEntry('FileName', file.name);
      addEntry('FileSize', formatFileSize(file.size));
      addEntry('FileType', fileType);
      addEntry('FileTypeExtension', fileTypeExt);
      addEntry('MIMEType', file.type || '不明');
      if (checksum) addEntry('Checksum', checksum);

      // ── 2. PNG IHDR + C2PA metadata (from our own chunk parser) ──────────
      // PNG_COLOR_TYPES and IHDR fields use human-readable strings.
      // Keys like ImageWidth/ImageHeight appear here first, so they win the
      // deduplication race over exifr's numeric versions.
      let imgWidth: number | undefined;
      let imgHeight: number | undefined;

      for (const [key, val] of Object.entries(pngMeta)) {
        if (val === null || val === undefined) continue;
        const strVal = String(val);
        if (strVal === '') continue;
        addEntry(key, strVal);
        if (key === 'ImageWidth' && typeof val === 'number') imgWidth = val;
        if (key === 'ImageHeight' && typeof val === 'number') imgHeight = val;
      }

      // ── 3. EXIF / IPTC / XMP / ICC / JFIF metadata via exifr ─────────────
      let gpsLat: number | undefined;
      let gpsLng: number | undefined;

      if (raw) {
        for (const [, segData] of Object.entries(raw)) {
          if (typeof segData !== 'object' || segData === null || Array.isArray(segData)) continue;
          for (const [key, val] of Object.entries(segData as Record<string, unknown>)) {
            if (val === undefined || val === null) continue;
            const formatted = formatValue(val);
            if (formatted === '') continue;

            addEntry(key, formatted);

            // Collect image dimensions for computed fields (if not set by PNG parser)
            if (
              (key === 'ImageWidth' || key === 'ExifImageWidth') &&
              typeof val === 'number' &&
              imgWidth === undefined
            ) imgWidth = val;
            if (
              (key === 'ImageHeight' || key === 'ExifImageHeight') &&
              typeof val === 'number' &&
              imgHeight === undefined
            ) imgHeight = val;

            // Detect GPS coordinates
            if (key === 'GPSLatitude' && Array.isArray(val)) {
              const refEntry = (segData as Record<string, unknown>)['GPSLatitudeRef'];
              gpsLat = dmsToDecimal(val as number[], String(refEntry ?? 'N'));
            }
            if (key === 'GPSLongitude' && Array.isArray(val)) {
              const refEntry = (segData as Record<string, unknown>)['GPSLongitudeRef'];
              gpsLng = dmsToDecimal(val as number[], String(refEntry ?? 'E'));
            }
            if (key === 'latitude' && typeof val === 'number') gpsLat = val;
            if (key === 'longitude' && typeof val === 'number') gpsLng = val;
          }
        }
      }

      // Also check top-level GPS from gps() helper
      try {
        const gps = await exifr.gps(buffer);
        if (gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number') {
          gpsLat = gps.latitude;
          gpsLng = gps.longitude;
        }
      } catch {
        // Ignore GPS parsing error
      }

      // ── 4. Computed metadata ──────────────────────────────────────────────
      if (imgWidth !== undefined && imgHeight !== undefined) {
        addEntry('ImageSize', `${imgWidth}x${imgHeight}`);
        const mp = (imgWidth * imgHeight) / 1_000_000;
        addEntry('Megapixels', mp % 1 === 0 ? String(Math.round(mp)) : mp.toFixed(1));
      }
      addEntry('Category', 'image');
      addEntry('RawHeader', rawHeader);

      // ── 5. GPS entry (prepended so it appears at the top) ─────────────────
      if (gpsLat !== undefined && gpsLng !== undefined) {
        setMapGps({ lat: gpsLat, lng: gpsLng });
        entries.unshift({
          label: 'GPS位置情報',
          value: `${gpsLat.toFixed(6)}, ${gpsLng.toFixed(6)}`,
          isGps: true,
          lat: gpsLat,
          lng: gpsLng,
        });
      }

      setMetadata(entries);
      const rawTyped = raw as Record<string, Record<string, unknown>> | null;
      const orientation = getExifOrientation(rawTyped);
      const extractedRegions = extractImageRegions(rawTyped);
      setRegions(
        orientation !== 1
          ? extractedRegions.map((r) => transformRegionForOrientation(r, orientation))
          : extractedRegions,
      );
    } catch (err) {
      console.error('Metadata parsing error:', err);
      setError('メタデータの読み取りに失敗しました。このファイルにはメタデータが含まれていない可能性があります。');
    }

    setLoading(false);
  }, [imageUrl]);

  const handleThumbLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const container = thumbContainerRef.current;
    if (!container || img.naturalWidth === 0) return;

    const cW = container.offsetWidth;
    const MAX_H = THUMBNAIL_MAX_HEIGHT;
    const aspectH = cW * (img.naturalHeight / img.naturalWidth);

    if (aspectH <= MAX_H) {
      setThumbBounds({ imgW: cW, imgH: aspectH, imgLeft: 0, imgTop: 0 });
    } else {
      const imgH = MAX_H;
      const imgW = MAX_H * (img.naturalWidth / img.naturalHeight);
      setThumbBounds({ imgW, imgH, imgLeft: (cW - imgW) / 2, imgTop: 0 });
    }
  }, []);

  useEffect(() => {
    if (!lightboxOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxOpen(false);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [lightboxOpen]);

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
            {/* Outer wrapper is the positioning root for the overlay */}
            <div
              className="relative max-w-sm w-full cursor-pointer"
              onClick={() => setLightboxOpen(true)}
              title="クリックして拡大表示"
            >
              {/* Inner container: rounded corners + overflow clip */}
              <div
                ref={thumbContainerRef}
                className="shadow-lg rounded-xl overflow-hidden bg-gray-100"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imageUrl}
                  alt={imageName}
                  className="w-full h-auto object-contain max-h-80 block"
                  onLoad={handleThumbLoad}
                />
              </div>

              {/* Region overlays – outside overflow:hidden so tooltips are never clipped */}
              {regions.length > 0 && thumbBounds !== null && (
                <div className="absolute inset-0 pointer-events-none">
                  {regions.map((region, i) => {
                    const left = thumbBounds.imgLeft + (region.x - region.w / 2) * thumbBounds.imgW;
                    const top  = thumbBounds.imgTop  + (region.y - region.h / 2) * thumbBounds.imgH;
                    const width  = region.w * thumbBounds.imgW;
                    const height = region.h * thumbBounds.imgH;
                    const tooltipText = [
                      region.name,
                      region.type ? `[${region.type}]` : null,
                      region.description,
                    ].filter(Boolean).join(' ') || '領域';
                    return (
                      <div
                        key={i}
                        className="absolute border-2 border-yellow-400 pointer-events-auto group"
                        style={{ left, top, width, height }}
                      >
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-black/80 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-10 pointer-events-none">
                          {tooltipText}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
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

      {/* Lightbox – full-size image viewer */}
      {lightboxOpen && imageUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          onClick={() => setLightboxOpen(false)}
        >
          {/* Close button */}
          <button
            className="absolute top-4 right-4 text-white text-3xl leading-none hover:text-gray-300 transition-colors z-10"
            onClick={(e) => { e.stopPropagation(); setLightboxOpen(false); }}
            aria-label="閉じる"
          >
            ✕
          </button>

          {/* Image + overlays (stop click from closing when clicking image) */}
          <div
            className="relative"
            onClick={(e) => e.stopPropagation()}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl}
              alt={imageName}
              className="block"
              style={{ maxWidth: '90vw', maxHeight: '90vh' }}
            />

            {/* Region overlays – percentage-based; container matches rendered image exactly */}
            {regions.length > 0 && (
              <div className="absolute inset-0 pointer-events-none">
                {regions.map((region, i) => {
                  const tooltipText = [
                    region.name,
                    region.type ? `[${region.type}]` : null,
                    region.description,
                  ].filter(Boolean).join(' ') || '領域';
                  return (
                    <div
                      key={i}
                      className="absolute border-2 border-yellow-400 pointer-events-auto group"
                      style={{
                        left:   `${(region.x - region.w / 2) * 100}%`,
                        top:    `${(region.y - region.h / 2) * 100}%`,
                        width:  `${region.w * 100}%`,
                        height: `${region.h * 100}%`,
                      }}
                    >
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-black/80 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-10 pointer-events-none">
                        {tooltipText}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
