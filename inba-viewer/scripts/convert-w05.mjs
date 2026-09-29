#!/usr/bin/env node
/**
 * 国土数値情報「河川データ（W05）」千葉県分を取得し、印旛沼周辺だけを
 * GeoJSON（EPSG:4326相当）へ変換する。外部パッケージは使わない。
 *
 * 使い方（リポジトリのルートで実行）:
 *   node inba-viewer/scripts/convert-w05.mjs
 *   node inba-viewer/scripts/convert-w05.mjs --zip ./W05-08_12_GML.zip   # 手元のzipを使う
 *
 * 出力: inba-viewer/data/w05-inba.geojson（.gitignoreで除外。再配布しない）
 *
 * ライセンス: W05の使用許諾条件は「非商用」。生成物をリポジトリへコミットしたり、
 * 公開サーバーへ置いたりしないこと。利用条件は次を確認する。
 *   https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-W05.html
 *
 * 変換の中身:
 *   1. W05-08_12_GML.zip（2008年度・千葉県、約2.9 MB）を取得する。
 *   2. zip内の W05-08_12-g_Stream.shp（河川中心線、PolyLine）と .dbf（属性）を読む。
 *      DBFの文字コードはShift_JIS（language driver 0x13）。
 *   3. バウンディングボックスと交差する流路だけを残す（線は切らずに丸ごと残す）。
 *   4. 属性はW05の元のキー（W05_001〜W05_006）のまま出力する。
 *
 * 座標系: 元データはJGD2000の緯度経度（EPSG:4612）。WGS84との差は数十cm程度で、
 * 1/25,000レベルの河川中心線には影響しないため、座標変換は行わない。
 *
 * GDALを使う場合の同等手順（本スクリプトの代わりに使える）:
 *   unzip W05-08_12_GML.zip
 *   ogr2ogr -f GeoJSON -s_srs EPSG:4612 -t_srs EPSG:4326 \
 *     -oo ENCODING=CP932 -spat 139.95 35.60 140.40 35.95 \
 *     -lco COORDINATE_PRECISION=6 \
 *     inba-viewer/data/w05-inba.geojson W05-08_12-g_Stream.shp
 * GML（W05-08_12-g.xml）はJPGIS準拠の独自構造で、そのままではogr2ogrで扱いにくい。
 * 同じzipに入っているShapefileを変換元にする。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const SOURCE_URL = "https://nlftp.mlit.go.jp/ksj/gml/data/W05/W05-08/W05-08_12_GML.zip";
const STREAM_BASENAME = "W05-08_12-g_Stream";
// 印旛沼、新川、花見川（東京湾河口まで）、印旛放水路、長門川・将監川を含む範囲 [west, south, east, north]
export const DEFAULT_BBOX = [139.95, 35.6, 140.4, 35.95];
const MAX_ZIP_BYTES = 64 * 1024 * 1024;
const COORDINATE_DIGITS = 6;

const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(here, "../data/w05-inba.geojson");

// ---- zip -----------------------------------------------------------------

/** Returns a map of entry name to uncompressed bytes for the requested names. */
export function extractZipEntries(zip, wantedNames) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let offset = zip.byteLength - 22; offset >= Math.max(0, zip.byteLength - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("zipの終端レコードが見つかりません");
  }

  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const result = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error("zipの中央ディレクトリが壊れています");
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(zip.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    const baseName = name.split("/").at(-1);
    if (!wantedNames.includes(baseName)) {
      continue;
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) {
      result.set(baseName, data);
    } else if (method === 8) {
      result.set(baseName, inflateRawSync(data));
    } else {
      throw new Error(`未対応の圧縮方式です: ${method}`);
    }
  }
  return result;
}

// ---- shapefile -----------------------------------------------------------

/** Parses PolyLine (type 3) records. Null shapes become null. */
export function parsePolylineShp(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getInt32(0, false) !== 9994) {
    throw new Error("Shapefileのヘッダーが不正です");
  }
  const records = [];
  let offset = 100;
  while (offset + 8 <= bytes.byteLength) {
    const contentBytes = view.getInt32(offset + 4, false) * 2;
    const start = offset + 8;
    const shapeType = view.getInt32(start, true);
    if (shapeType === 0) {
      records.push(null);
    } else if (shapeType === 3) {
      const numParts = view.getInt32(start + 36, true);
      const numPoints = view.getInt32(start + 40, true);
      const partStarts = [];
      for (let part = 0; part < numParts; part += 1) {
        partStarts.push(view.getInt32(start + 44 + part * 4, true));
      }
      const pointsStart = start + 44 + numParts * 4;
      const parts = partStarts.map((partStart, part) => {
        const partEnd = part + 1 < numParts ? partStarts[part + 1] : numPoints;
        const coordinates = [];
        for (let point = partStart; point < partEnd; point += 1) {
          coordinates.push([
            view.getFloat64(pointsStart + point * 16, true),
            view.getFloat64(pointsStart + point * 16 + 8, true),
          ]);
        }
        return coordinates;
      });
      records.push({
        bbox: [
          view.getFloat64(start + 4, true),
          view.getFloat64(start + 12, true),
          view.getFloat64(start + 20, true),
          view.getFloat64(start + 28, true),
        ],
        parts,
      });
    } else {
      throw new Error(`未対応の図形種別です: ${shapeType}`);
    }
    offset = start + contentBytes;
  }
  return records;
}

/** Parses dBASE III records as strings, decoded with the given encoding. */
export function parseDbf(bytes, encoding = "shift_jis") {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const recordCount = view.getUint32(4, true);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);
  const decoder = new TextDecoder(encoding);
  const fields = [];
  for (let offset = 32; offset < headerLength - 1 && bytes[offset] !== 0x0d; offset += 32) {
    const rawName = bytes.subarray(offset, offset + 11);
    const nameEnd = rawName.indexOf(0);
    fields.push({
      name: new TextDecoder("ascii").decode(rawName.subarray(0, nameEnd < 0 ? 11 : nameEnd)),
      type: String.fromCharCode(bytes[offset + 11]),
      length: bytes[offset + 16],
    });
  }

  const rows = [];
  for (let index = 0; index < recordCount; index += 1) {
    const recordStart = headerLength + index * recordLength;
    if (bytes[recordStart] === 0x2a) {
      rows.push(null); // deleted
      continue;
    }
    let cursor = recordStart + 1;
    const row = {};
    for (const field of fields) {
      row[field.name] = decoder.decode(bytes.subarray(cursor, cursor + field.length)).trim();
      cursor += field.length;
    }
    rows.push(row);
  }
  return rows;
}

// ---- conversion ----------------------------------------------------------

function intersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function round(value) {
  const factor = 10 ** COORDINATE_DIGITS;
  return Math.round(value * factor) / factor;
}

export function toFeatureCollection(shapes, rows, bbox = DEFAULT_BBOX) {
  if (shapes.length !== rows.length) {
    throw new Error(`SHPとDBFの件数が一致しません（${shapes.length} / ${rows.length}）`);
  }
  const features = [];
  shapes.forEach((shape, index) => {
    const row = rows[index];
    if (shape === null || row === null || !intersects(shape.bbox, bbox)) {
      return;
    }
    const lines = shape.parts
      .map((part) => part.map(([lon, lat]) => [round(lon), round(lat)]))
      .filter((part) => part.length >= 2);
    if (lines.length === 0) {
      return;
    }
    features.push({
      type: "Feature",
      properties: row,
      geometry:
        lines.length === 1
          ? { type: "LineString", coordinates: lines[0] }
          : { type: "MultiLineString", coordinates: lines },
    });
  });
  return {
    type: "FeatureCollection",
    // 出典表示に使う。変更しない。
    source: "国土数値情報（河川データ W05、2008年度・千葉県）国土交通省",
    sourceUrl: "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-W05.html",
    license: "非商用（国土数値情報の使用許諾条件による）",
    bbox,
    features,
  };
}

async function loadZip(zipPath) {
  if (zipPath) {
    return new Uint8Array(await readFile(zipPath));
  }
  process.stdout.write(`取得中: ${SOURCE_URL}\n`);
  const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`取得に失敗しました: HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_ZIP_BYTES) {
    throw new Error("zipが想定より大きいため中止しました");
  }
  return bytes;
}

async function main() {
  const zipFlag = process.argv.indexOf("--zip");
  const zipPath = zipFlag >= 0 ? process.argv[zipFlag + 1] : undefined;
  const zip = await loadZip(zipPath);
  const entries = extractZipEntries(zip, [`${STREAM_BASENAME}.shp`, `${STREAM_BASENAME}.dbf`]);
  const shp = entries.get(`${STREAM_BASENAME}.shp`);
  const dbf = entries.get(`${STREAM_BASENAME}.dbf`);
  if (!shp || !dbf) {
    throw new Error(`zipに ${STREAM_BASENAME}.shp / .dbf がありません`);
  }

  const collection = toFeatureCollection(parsePolylineShp(shp), parseDbf(dbf));
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(collection)}\n`);
  const names = new Set(collection.features.map((feature) => feature.properties.W05_004));
  process.stdout.write(
    `出力: ${OUTPUT_PATH}\n流路 ${collection.features.length} 件、河川名 ${names.size} 種\n`,
  );
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
