'use strict';

const SAFE_CATALOG_HOSTS = new Set(['github.com', 'raw.githubusercontent.com', 'h6rd.github.io']);

const CATALOG_SOURCES = Object.freeze([
  Object.freeze({
    id: 'd2pfx',
    name: 'D2PFX',
    kind: 'verified',
    repositoryUrl: 'https://github.com/h6rd/Dota2PornFxWeb',
    catalogUrl: 'https://raw.githubusercontent.com/h6rd/Dota2PornFxWeb/main/assets/data/mods.json',
    adapter: 'd2pfx',
    enabledByDefault: true,
  }),
]);

function sourceById(id) {
  return CATALOG_SOURCES.find(source => source.id === String(id || '')) || null;
}

function createAuthorSource(catalogUrl) {
  const url = validateCatalogUrl(catalogUrl);
  const parsed = new URL(url);
  const pathParts = parsed.pathname.split('/').filter(Boolean);
  const repositoryUrl = parsed.hostname === 'raw.githubusercontent.com' && pathParts.length >= 2
    ? `https://github.com/${pathParts[0]}/${pathParts[1]}`
    : url;
  const id = `author-${Buffer.from(url).toString('base64url').slice(0, 48)}`;
  return { id, name: repositoryUrl.replace(/^https:\/\/github\.com\//, ''), kind: 'author', repositoryUrl, catalogUrl: url, adapter: 'author-json', enabledByDefault: false };
}

function validateCatalogUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error('Некорректный URL каталога'); }
  if (url.protocol !== 'https:' || !SAFE_CATALOG_HOSTS.has(url.hostname))
    throw new Error('Каталог должен находиться на разрешённом HTTPS-домене');
  return url.toString();
}

function validateCatalogDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document))
    throw new Error('Каталог должен быть JSON-объектом');
  const list = Array.isArray(document.mods) ? document.mods : Array.isArray(document.items) ? document.items : null;
  if (!list) throw new Error('В каталоге отсутствует массив mods или items');
  if (list.length > 10000) throw new Error('Каталог превышает допустимый размер');
  return list;
}

function normalizeAuthorCatalog(document, source, normalize) {
  const list = validateCatalogDocument(document);
  return list.map((entry, index) => {
    const raw = { ...entry };
    for (const key of ['downloadUrl', 'download_url', 'url', 'link', 'fileUrl', 'previewUrl', 'preview_url']) {
      if (raw[key]) raw[key] = validateCatalogUrl(raw[key]);
    }
    return normalize({
      ...raw,
      id: `${source.id}-${entry.id || entry.slug || entry.name || index}`,
      source: source.name,
      sourceId: entry.id || entry.slug || String(index),
      sourceRepository: source.repositoryUrl,
    }, index);
  });
}

module.exports = {
  CATALOG_SOURCES,
  SAFE_CATALOG_HOSTS,
  sourceById,
  createAuthorSource,
  validateCatalogUrl,
  validateCatalogDocument,
  normalizeAuthorCatalog,
};
