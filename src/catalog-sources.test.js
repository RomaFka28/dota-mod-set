'use strict';

const assert = require('node:assert/strict');
const {
  CATALOG_SOURCES,
  sourceById,
  createAuthorSource,
  validateCatalogUrl,
  validateCatalogDocument,
  normalizeAuthorCatalog,
} = require('./catalog-sources');

assert.equal(sourceById('d2pfx').name, 'D2PFX');
assert.equal(sourceById('missing'), null);
assert.equal(createAuthorSource('https://raw.githubusercontent.com/example/catalog/main/catalog.json').repositoryUrl, 'https://github.com/example/catalog');
assert.throws(() => createAuthorSource('https://example.com/catalog.json'));
assert.equal(validateCatalogUrl('https://raw.githubusercontent.com/example/catalog.json').startsWith('https://'), true);
assert.throws(() => validateCatalogUrl('http://raw.githubusercontent.com/example/catalog.json'));
assert.throws(() => validateCatalogUrl('https://example.com/catalog.json'));
assert.deepEqual(validateCatalogDocument({ mods: [{ name: 'A' }] }), [{ name: 'A' }]);
assert.throws(() => validateCatalogDocument({}));
const normalized = normalizeAuthorCatalog(
  { mods: [{ id: 'axe-blue', name: 'Axe Blue', downloadUrl: 'https://github.com/a/b/releases/download/v1/a.zip' }] },
  CATALOG_SOURCES[0],
  (entry) => entry,
);
assert.equal(normalized[0].id, 'd2pfx-axe-blue');
assert.equal(normalized[0].sourceRepository, CATALOG_SOURCES[0].repositoryUrl);
console.log('catalog-sources: ok');
