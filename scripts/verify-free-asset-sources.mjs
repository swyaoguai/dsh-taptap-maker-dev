/**
 * Offline tests for documented free-asset evidence (no network, files, installs or Git).
 * Fixtures below are fictitious reviewer records, NOT assertions about actual rights.
 * Run: node --test scripts/verify-free-asset-sources.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FREE_ASSET_SOURCES, assessFreeAssetCandidate } from '../src/free-asset-sources.mjs'

function documentedCandidate() {
  return {
    sourceId: 'kenney',
    assetName: 'Fictitious test pack',
    assetUrl: 'https://creator.example/packs/test-pack',
    creator: 'Fictitious test creator',
    version: 'test-version-1',
    kind: 'image',
    checkedAt: '2026-10-30',
    cost: {
      amount: 0,
      verified: true,
      evidenceUrl: 'https://creator.example/packs/test-pack#price',
    },
    original: {
      url: 'https://creator.example/packs/test-pack',
      evidenceUrl: 'https://creator.example/packs/test-pack#ownership',
      authoritative: true,
    },
    license: {
      id: 'CC0-1.0',
      termsUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      evidenceUrl: 'https://creator.example/packs/test-pack#license',
      authoritative: true,
      scopeVerified: true,
      commercial: true,
      modification: true,
      gameEmbedding: true,
      gameRedistribution: true,
      noticesSatisfied: true,
      noticeEvidence: 'Reviewer recorded the applicable notice obligations for this fixture.',
      obligationsSatisfied: true,
    },
    checks: {
      dependencies: true,
      ip: true,
      provenance: true,
      ripped: false,
      disputed: false,
    },
    dependencies: [],
  }
}

function editedCandidate(field, value, remove = false) {
  const record = documentedCandidate()
  const parts = field.split('.')
  const key = parts.pop()
  const owner = parts.reduce((object, part) => object[part], record)
  if (remove) delete owner[key]
  else owner[key] = value
  return record
}

function expectDecision(candidate, decision, reason) {
  const result = assessFreeAssetCandidate(candidate)
  assert.equal(result.decision, decision)
  assert.equal(result.eligible, decision === 'allow')
  assert.ok(Array.isArray(result.reasons))
  assert.ok(result.reasons.every((item) => typeof item === 'string' && item.length > 0))
  if (decision !== 'allow') assert.ok(result.reasons.length > 0)
  if (reason) assert.ok(result.reasons.some((item) => item.includes(reason)), result.reasons.join(', '))
  return result
}

function documentedFont() {
  const record = documentedCandidate()
  record.sourceId = 'enotsixlm-game-ui-kits'
  record.assetName = 'Fictitious licensed font'
  record.kind = 'font'
  record.license.id = 'OFL-1.1'
  record.license.termsUrl = 'https://openfontlicense.org/open-font-license-official-text/'
  record.fontCompliance = {
    licensePreserved: true,
    standaloneSale: false,
    reservedNamesSatisfied: true,
  }
  return record
}

test('registry preserves the six supplied sources in the exact user order', () => {
  assert.deepEqual(FREE_ASSET_SOURCES.map((source) => source.id), [
    'gameui', 'interfaceingame', 'enotsixlm-game-ui-kits', 'lemooui', 'pixlab24', 'kenney',
  ])
  assert.deepEqual(FREE_ASSET_SOURCES.map((source) => source.suppliedUrl), [
    'https://gameui.net/',
    'https://interfaceingame.com/',
    'https://enotsixlm.github.io/game-ui-kits/',
    'https://lemooui.com/',
    'https://pixlab24.com/',
    'https://kenney.nl/games',
  ])
  for (const source of FREE_ASSET_SOURCES) {
    assert.equal(typeof source.kind, 'string')
    assert.equal(typeof source.checkedAt, 'string')
    assert.ok(Array.isArray(source.uncertainties))
    assert.ok(Array.isArray(source.policyUrls))
    assert.ok(source.evidenceUrls.length > 0)
    assert.ok(Array.isArray(source.candidateAccessLinks))
    assert.equal(source.free, undefined, 'a source must not inherit a blanket free flag')
    assert.equal(source.license, undefined, 'a source must not supply an inherited asset license')
    for (const url of [...source.policyUrls, ...source.evidenceUrls]) {
      assert.match(url, /^https:\/\//)
    }
  }
})

test('registry keeps reference/catalog URLs distinct from candidate access URLs', () => {
  const byId = Object.fromEntries(FREE_ASSET_SOURCES.map((source) => [source.id, source]))
  assert.equal(byId.gameui.searchUrl, null)
  assert.equal(byId.gameui.referenceUrl, 'https://gameui.net/')
  assert.equal(byId.interfaceingame.searchUrl, null)
  assert.equal(byId.kenney.searchUrl, 'https://kenney.nl/assets')
  assert.equal(byId.kenney.referenceUrl, 'https://kenney.nl/games')
  assert.ok(byId.kenney.candidateAccessLinks.some((item) => item.url === 'https://kenney.nl/assets/ui-pack'))
  assert.ok(!byId.kenney.candidateAccessLinks.some((item) => item.url === byId.kenney.searchUrl))
  assert.ok(!byId['enotsixlm-game-ui-kits'].suppliedUrl.includes('\u2011'))
})

test('automation remains unknown except the explicitly forbidden Interface scraper', () => {
  for (const source of FREE_ASSET_SOURCES) {
    assert.equal(source.automation, source.id === 'interfaceingame' ? 'forbidden' : 'unknown')
    assert.deepEqual(source.lookupModes, ['metadata-search', 'manual-browse'])
    assert.equal(source.automaticDownload, false)
  }
})

test('registry and its nested records are immutable', () => {
  assert.ok(Object.isFrozen(FREE_ASSET_SOURCES))
  assert.ok(Object.isFrozen(FREE_ASSET_SOURCES[0]))
  assert.ok(Object.isFrozen(FREE_ASSET_SOURCES[0].candidateAccessLinks))
  assert.throws(() => FREE_ASSET_SOURCES[0].policyUrls.push('https://other.example/'), TypeError)
})

test('complete explicit fictitious evidence can pass without certifying real-world rights', () => {
  assert.deepEqual(expectDecision(documentedCandidate(), 'allow'), {
    eligible: true, decision: 'allow', reasons: [],
  })
})

test('source discovery preference does not grant rights or authorize crawling', () => {
  for (const source of FREE_ASSET_SOURCES) {
    expectDecision({ sourceId: source.id, assetUrl: 'https://creator.example/packs/test-pack', free: true }, 'hold')
    const completeOriginalRecord = documentedCandidate()
    completeOriginalRecord.sourceId = source.id
    expectDecision(completeOriginalRecord, 'allow')
  }
})

for (const field of [
  'assetName', 'assetUrl', 'creator', 'version', 'kind', 'checkedAt',
  'cost.amount', 'cost.verified', 'cost.evidenceUrl',
  'original.url', 'original.evidenceUrl', 'original.authoritative',
  'license.id', 'license.termsUrl', 'license.evidenceUrl', 'license.authoritative',
  'license.scopeVerified', 'license.commercial', 'license.modification',
  'license.gameEmbedding', 'license.gameRedistribution', 'license.noticesSatisfied',
  'license.noticeEvidence', 'license.obligationsSatisfied',
  'checks.dependencies', 'checks.ip', 'checks.provenance', 'checks.ripped', 'checks.disputed',
  'dependencies',
]) {
  test(`missing required evidence holds: ${field}`, () => {
    expectDecision(editedCandidate(field, undefined, true), 'hold')
  })
}

for (const field of [
  'cost.verified', 'original.authoritative', 'license.authoritative',
  'license.scopeVerified', 'license.noticesSatisfied', 'license.obligationsSatisfied',
  'checks.dependencies', 'checks.ip', 'checks.provenance',
]) {
  test(`unverified evidence holds rather than being coerced: ${field}`, () => {
    expectDecision(editedCandidate(field, false), 'hold')
    expectDecision(editedCandidate(field, 'true'), 'hold')
  })
}

for (const value of ['0', null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`zero cost must be an explicit finite number: ${String(value)}`, () => {
    expectDecision(editedCandidate('cost.amount', value), 'hold')
  })
}

test('a free marketing label cannot replace a verified zero price', () => {
  const record = documentedCandidate()
  delete record.cost
  record.free = true
  expectDecision(record, 'hold', 'COST_NOT_VERIFIED_ZERO')
})

for (const flag of ['paid', 'vipOnly', 'requiresPurchase', 'requiresPaidSubscription']) {
  test(`paid access is rejected even when a record claims a zero download price: ${flag}`, () => {
    const record = documentedCandidate()
    record.cost[flag] = true
    expectDecision(record, 'reject', 'PAID_OR_VIP_ACCESS')
  })
}

test('positive price is rejected', () => {
  expectDecision(editedCandidate('cost.amount', 0.01), 'reject', 'PAID_OR_VIP_ACCESS')
})

for (const id of ['CC-BY-NC-4.0', 'cc-by-nc-sa-4.0', 'CC_BY_ND_4.0', 'CC-BY-NC-ND-4.0', 'NC', 'ND']) {
  test(`NC/ND grant is rejected even with contradictory positive permission flags: ${id}`, () => {
    expectDecision(editedCandidate('license.id', id), 'reject', 'NC_OR_ND_LICENSE')
  })
}

for (const permission of ['commercial', 'modification', 'gameEmbedding', 'gameRedistribution']) {
  test(`an explicit denial of an intended use is rejected: ${permission}`, () => {
    expectDecision(editedCandidate(`license.${permission}`, false), 'reject', 'INTENDED_USE_DENIED')
    expectDecision(editedCandidate(`license.${permission}`, 'true'), 'hold')
  })
}

test('ripped and disputed materials are rejected, including incomplete records', () => {
  expectDecision({ checks: { ripped: true } }, 'reject', 'RIPPED_OR_DISPUTED')
  expectDecision({ checks: { disputed: true } }, 'reject', 'RIPPED_OR_DISPUTED')
  expectDecision(editedCandidate('checks.ripped', true), 'reject', 'RIPPED_OR_DISPUTED')
  expectDecision(editedCandidate('checks.disputed', true), 'reject', 'RIPPED_OR_DISPUTED')
})

for (const field of ['assetUrl', 'cost.evidenceUrl', 'original.url', 'original.evidenceUrl', 'license.termsUrl', 'license.evidenceUrl']) {
  test(`evidence URLs must be real HTTP(S) document references: ${field}`, () => {
    expectDecision(editedCandidate(field, 'javascript:alert(1)'), 'hold')
    expectDecision(editedCandidate(field, 'file:///C:/private/file'), 'hold')
    expectDecision(editedCandidate(field, 'https://user:secret@creator.example/'), 'hold')
  })
}

for (const evidenceUrl of [
  'https://kenney.nl/assets', 'https://kenney.nl/support', 'https://kenney.nl/games',
  'https://www.lemooui.com/about/12', 'https://pixlab24.com/vip-prices',
  'https://opensource.org/license/mit', 'https://creativecommons.org/publicdomain/zero/1.0/',
]) {
  test(`a catalog/site policy/standard license text is not an item-specific grant: ${evidenceUrl}`, () => {
    expectDecision(editedCandidate('license.evidenceUrl', evidenceUrl), 'hold', 'ITEM_LICENSE_EVIDENCE_REQUIRED')
  })
}

for (const [sourceId, assetUrl] of [
  ['gameui', 'https://www.gameui.net/images/fictitious-test'],
  ['interfaceingame', 'https://interfaceingame.com/screenshots/fictitious-test/'],
  ['lemooui', 'https://www.lemooui.com/works/show/id/fictitious-test'],
]) {
  test(`reference screenshots/portfolio imagery are not importable: ${sourceId}`, () => {
    const record = documentedCandidate()
    record.sourceId = sourceId
    record.assetUrl = assetUrl
    record.kind = 'game-screenshot'
    expectDecision(record, 'reject', 'REFERENCE_CONTENT_NOT_IMPORTABLE')
  })
}

test('a generic image label cannot bypass reference/mirror provenance checks', () => {
  for (const assetUrl of [
    'https://www.gameui.net/works/fictitious-test',
    'https://interfaceingame.com/fictitious-test',
    'https://www.lemooui.com/resource/show/id/fictitious-test',
    'https://pixlab24.com/icons/fictitious-test/',
  ]) {
    expectDecision(editedCandidate('assetUrl', assetUrl), 'hold', 'ORIGINAL_CREATOR_ACCESS_REQUIRED')
  }
})

test('Kenney games are not licensed asset access links', () => {
  expectDecision(editedCandidate('assetUrl', 'https://kenney.nl/games'), 'reject', 'KENNEY_GAMES_NOT_ASSET_SOURCE')
  expectDecision(editedCandidate('assetUrl', 'https://www.kenney.nl/games/fictitious-test'), 'reject')
  const assetRecord = editedCandidate('assetUrl', 'https://kenney.nl/assets/ui-pack')
  expectDecision(assetRecord, 'allow')
})

test('MIT source code still requires satisfied copyright and license notices', () => {
  const record = documentedCandidate()
  record.kind = 'ui-code'
  record.sourceId = 'enotsixlm-game-ui-kits'
  record.license.id = 'MIT'
  record.license.termsUrl = 'https://opensource.org/license/mit'
  record.license.evidenceUrl = 'https://github.com/enotsixlm/game-ui-kits/blob/main/README.md'
  expectDecision(record, 'allow')
  record.license.noticesSatisfied = false
  expectDecision(record, 'hold')
  record.license.noticesSatisfied = true
  record.license.noticeEvidence = ''
  expectDecision(record, 'hold')
})

test('custom/share-alike terms require an additional documented review', () => {
  for (const id of ['custom-creator-grant', 'CC-BY-SA-4.0']) {
    const record = editedCandidate('license.id', id)
    expectDecision(record, 'hold', 'ADDITIONAL_LICENSE_REVIEW_REQUIRED')
    record.license.additionalReviewSatisfied = true
    expectDecision(record, 'allow')
  }
})

test('declared dependencies must each have original evidence, rights and satisfied notices', () => {
  const record = documentedCandidate()
  record.dependencies = [documentedFont()]
  expectDecision(record, 'allow')
  record.dependencies[0].license.noticesSatisfied = false
  expectDecision(record, 'hold')
  record.dependencies[0].license.noticesSatisfied = true
  record.dependencies[0].original.authoritative = false
  expectDecision(record, 'hold')
  record.dependencies[0].original.authoritative = true
  record.dependencies[0].license.id = 'CC-BY-NC-4.0'
  expectDecision(record, 'reject', 'NC_OR_ND_LICENSE')
})

for (const field of ['licensePreserved', 'standaloneSale', 'reservedNamesSatisfied']) {
  test(`OFL font-file obligations cannot be inferred from MIT code: ${field}`, () => {
    const record = documentedFont()
    delete record.fontCompliance[field]
    expectDecision(record, 'hold', 'FONT_OBLIGATIONS_UNVERIFIED')
  })
}

test('selling an OFL font alone is rejected, not confused with selling an embedding game', () => {
  const record = documentedFont()
  expectDecision(record, 'allow')
  record.fontCompliance.standaloneSale = true
  expectDecision(record, 'reject', 'FONT_STANDALONE_SALE_FORBIDDEN')
})

test('malformed, empty and cyclic input holds without mutating or throwing', () => {
  for (const value of [undefined, null, '', 0, [], {}, { dependencies: 'not an array' }]) {
    expectDecision(value, 'hold')
  }
  const cycle = documentedCandidate()
  cycle.dependencies = [cycle]
  expectDecision(cycle, 'hold', 'CYCLIC_OR_TOO_DEEP_EVIDENCE')
  const deep = documentedCandidate()
  let cursor = deep
  for (let i = 0; i < 12; i += 1) {
    const child = documentedCandidate()
    cursor.dependencies = [child]
    cursor = child
  }
  expectDecision(deep, 'hold', 'CYCLIC_OR_TOO_DEEP_EVIDENCE')
})

test('assessment is deterministic, non-mutating and performs no fetch', () => {
  const record = documentedCandidate()
  const before = structuredClone(record)
  const previousFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = () => { requests += 1; throw new Error('Network must not be attempted') }
  try {
    const first = assessFreeAssetCandidate(record)
    const second = assessFreeAssetCandidate(record)
    assert.deepEqual(first, second)
    assert.deepEqual(record, before)
    assert.equal(requests, 0)
  } finally {
    globalThis.fetch = previousFetch
  }
})
