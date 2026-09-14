'use strict';

const MAX_ENTRIES = 2000;
const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;

function validateArchiveEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Архив пуст');
  if (entries.length > MAX_ENTRIES) throw new Error(`Архив содержит слишком много файлов (максимум ${MAX_ENTRIES})`);
  let total = 0;
  for (const entry of entries) {
    const name = String(entry.name || '').replace(/\\/g, '/');
    if (!name || name.startsWith('/') || /^[a-z]:\//i.test(name) ||
      name.split('/').some(part => part === '..')) {
      throw new Error(`Небезопасный путь в архиве: ${entry.name}`);
    }
    const attrs = Number(entry.externalAttributes || 0);
    if ((((attrs >>> 16) & 0xf000) === 0xa000))
      throw new Error(`Символическая ссылка в архиве запрещена: ${entry.name}`);
    const size = Number(entry.size);
    if (!Number.isFinite(size) || size < 0 || size > MAX_ENTRY_BYTES)
      throw new Error(`Слишком большой файл в архиве: ${entry.name}`);
    total += size;
    if (total > MAX_UNCOMPRESSED_BYTES)
      throw new Error(`Распакованный архив слишком большой (максимум ${MAX_UNCOMPRESSED_BYTES} байт)`);
  }
  return { count: entries.length, uncompressedBytes: total };
}

module.exports = { validateArchiveEntries };
