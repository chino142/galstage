/**
 * 极小的 ZIP 读写（只用 node:zlib，零依赖）。
 *
 * 为什么不用 tar.gz：备份是给用户"一个压缩包带走所有数据"的，ZIP 在
 * Windows 资源管理器里双击就能看，tar.gz 不行。为什么不用现成的 zip 库：
 * 硬约束是零第三方依赖。
 *
 * 只实现自己用得到的部分：deflate 压缩（method 8）、不加密、没有 ZIP64
 * （单文件 > 4GB 或条目 > 65535 会抛错，自用场景够）。
 * 读写都按 PKZIP APPNOTE 的字段顺序来，可以拿 7-Zip / Windows 自带工具校验。
 */

import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function dosDateTime(date = new Date()) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date: day };
}

/**
 * @param {Array<{name:string, data:Buffer|string, mtime?:Date}>} entries
 * @returns {Buffer} 一个完整的 .zip
 */
export function createZip(entries = []) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = String(entry.name ?? '').replace(/\\/g, '/');
    if (!name) continue;
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data);
    // 太小或者压不动就不压，省的比原文件还大
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(data) >>> 0;
    const { time, date } = dosDateTime(entry.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

/**
 * 解开一个 zip，返回 [{name, data, size}]。
 * 只认 deflate / store 两种压缩方式。
 */
export function readZip(buffer) {
  const eocdOffset = findEocd(buffer);
  if (eocdOffset < 0) throw new Error('这不是一个 zip 文件（找不到结尾记录）');
  const total = buffer.readUInt16LE(eocdOffset + 10);
  let pointer = buffer.readUInt32LE(eocdOffset + 16);
  const out = [];
  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(pointer) !== CENTRAL_SIG) throw new Error('zip 中央目录坏了');
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');

    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`zip 条目 ${name} 的本地头坏了`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? Buffer.from(payload) : inflateRawSync(payload);
    if (data.length !== uncompressedSize) throw new Error(`zip 条目 ${name} 解出来大小对不上`);
    out.push({ name, data, size: data.length });

    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

function findEocd(buffer) {
  const minimum = Math.max(0, buffer.length - 65557);
  for (let index = buffer.length - 22; index >= minimum; index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD_SIG) return index;
  }
  return -1;
}
