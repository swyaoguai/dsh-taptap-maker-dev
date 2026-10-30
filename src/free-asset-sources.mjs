/**
 * Preferred discovery sources, not a free/CC0 allowlist and not crawler permissions.
 * Research checked 2026-10-30. This module has no I/O and makes no legal verification.
 */
const CHECKED_AT = '2026-10-30'

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export const FREE_ASSET_SOURCES = deepFreeze([
  {
    id: 'gameui',
    name: 'GameUI',
    suppliedUrl: 'https://gameui.net/',
    searchUrl: null,
    referenceUrl: 'https://gameui.net/',
    kind: 'reference',
    automation: 'unknown',
    lookupModes: ['metadata-search', 'manual-browse'],
    automaticDownload: false,
    importPolicy: 'reference-only-default',
    licenseScope: 'No blanket commercial/modification permission verified for screenshots or portfolios.',
    policyUrls: [],
    evidenceUrls: ['https://gameui.net/', 'https://www.gameui.net/works/15066'],
    candidateAccessLinks: [{
      url: 'https://www.gameui.net/works/15066',
      status: 'reference-only',
      notes: 'Inspected designer portfolio; no reusable-asset license verified.',
    }],
    checkedAt: CHECKED_AT,
    uncertainties: [
      'No site-wide reuse terms were located in inspected pages; do not infer that no separately licensed item could ever exist.',
      'A portfolio credit or downloadable screenshot is not commercial/modification permission.',
      'Automated access permissions were not verified.',
    ],
  },
  {
    id: 'interfaceingame',
    name: 'Interface In Game',
    suppliedUrl: 'https://interfaceingame.com/',
    searchUrl: null,
    referenceUrl: 'https://interfaceingame.com/',
    kind: 'reference',
    automation: 'forbidden',
    lookupModes: ['metadata-search', 'manual-browse'],
    automaticDownload: false,
    importPolicy: 'reference-only-no-scraping',
    licenseScope: 'Game pictures and third-party IP retain their owners; no blanket image reuse grant.',
    policyUrls: [
      'https://interfaceingame.com/terms-and-conditions/',
      'https://interfaceingame.com/copyright-complaints/',
    ],
    evidenceUrls: [
      'https://interfaceingame.com/',
      'https://interfaceingame.com/terms-and-conditions/',
    ],
    candidateAccessLinks: [],
    checkedAt: CHECKED_AT,
    uncertainties: [
      'Terms prohibit spider/crawl/scrape; metadata search or user manual browsing is not permission to automate this site.',
      'Occasional resource links require original creator licensing, not the screenshot library terms.',
      'Attribution alone does not clear game pictures or trademarks.',
    ],
  },
  {
    id: 'enotsixlm-game-ui-kits',
    name: 'enotsixlm Game UI Kits',
    suppliedUrl: 'https://enotsixlm.github.io/game-ui-kits/',
    searchUrl: 'https://enotsixlm.github.io/game-ui-kits/',
    referenceUrl: 'https://enotsixlm.github.io/game-ui-kits/',
    kind: 'ui-code-kit',
    automation: 'unknown',
    lookupModes: ['metadata-search', 'manual-browse'],
    automaticDownload: false,
    importPolicy: 'per-item-license-gate',
    licenseScope: 'README declares MIT for HTML/CSS code; third-party fonts, emoji artwork and IP need separate checks.',
    policyUrls: [
      'https://github.com/enotsixlm/game-ui-kits/blob/main/README.md',
      'https://opensource.org/license/mit',
      'https://developers.google.com/fonts/faq',
    ],
    evidenceUrls: [
      'https://enotsixlm.github.io/game-ui-kits/',
      'https://github.com/enotsixlm/game-ui-kits',
      'https://raw.githubusercontent.com/enotsixlm/game-ui-kits/main/README.md',
      'https://raw.githubusercontent.com/enotsixlm/game-ui-kits/main/pixel-ui-kit.html',
      'https://raw.githubusercontent.com/google/fonts/main/ofl/pressstart2p/OFL.txt',
      'https://raw.githubusercontent.com/google/fonts/main/ofl/vt323/OFL.txt',
    ],
    candidateAccessLinks: [{
      url: 'https://github.com/enotsixlm/game-ui-kits',
      status: 'conditional-code-source',
      notes: 'Seven single-file HTML/CSS kits, not sliced art or Maker Lua UI; MIT notices and every dependency remain item-level gates.',
    }],
    checkedAt: CHECKED_AT,
    uncertainties: [
      'No standalone full LICENSE appeared in the inspected repository root; do not invent copyright notices.',
      'The pixel source loads both Press Start 2P and VT323; their OFL-1.1 licenses were inspected, not all other fonts.',
      'MIT does not authorize Nintendo/Diablo/Supercell marks, protected imagery or rendered vendor emoji artwork.',
      'Code licensing is not automated-scraping permission; automated access was not verified.',
    ],
  },
  {
    id: 'lemooui',
    name: 'LemoUI',
    suppliedUrl: 'https://lemooui.com/',
    searchUrl: 'https://www.lemooui.com/resource',
    referenceUrl: 'https://lemooui.com/',
    kind: 'mixed-restricted',
    automation: 'unknown',
    lookupModes: ['metadata-search', 'manual-browse'],
    automaticDownload: false,
    importPolicy: 'separate-rightsholder-grant',
    licenseScope: 'User-uploaded art is for learning/exchange; commercial use requires the original rights-holder authorization.',
    policyUrls: ['https://www.lemooui.com/about/12', 'https://www.lemooui.com/about/13'],
    evidenceUrls: [
      'https://lemooui.com/',
      'https://www.lemooui.com/about/12',
      'https://www.lemooui.com/about/13',
      'https://www.lemooui.com/resource/show/id/1159',
    ],
    candidateAccessLinks: [{
      url: 'https://www.lemooui.com/resource/show/id/1159',
      status: 'restricted-example',
      notes: 'Inspected PSD costs 100积分 to unlock and prohibits direct use/reposting without authorization; not a free reusable candidate.',
    }],
    checkedAt: CHECKED_AT,
    uncertainties: [
      'Mixed marketplace/reference site: not every item is paid and not every item has identical terms.',
      'Free access or earned points are not proof of commercial/modification permission.',
      'Copied/fan-work prototypes remain owned by their original creators.',
      'Automated access permissions were not verified.',
    ],
  },
  {
    id: 'pixlab24',
    name: 'Pixlab24',
    suppliedUrl: 'https://pixlab24.com/',
    searchUrl: 'https://pixlab24.com/',
    referenceUrl: null,
    kind: 'aggregator',
    automation: 'unknown',
    lookupModes: ['metadata-search', 'manual-browse'],
    automaticDownload: false,
    importPolicy: 'original-source-required',
    licenseScope: 'User-collected internet uploads and mixed free/VIP access; no inherited license or verified author authority.',
    policyUrls: ['https://pixlab24.com/vip-prices'],
    evidenceUrls: [
      'https://pixlab24.com/',
      'https://pixlab24.com/icons/1386/',
      'https://pixlab24.com/character/62452/',
      'https://pixlab24.com/tilesets/font/24822/',
      'https://pixlab24.com/vip-prices',
    ],
    candidateAccessLinks: [
      {
        url: 'https://pixlab24.com/icons/1386/',
        status: 'uncleared-example',
        notes: 'Free-labelled, login-gated and user-aggregated; original author/full licensing not verified.',
      },
      {
        url: 'https://pixlab24.com/tilesets/font/24822/',
        status: 'uncleared-example',
        notes: 'Darinia repeats commercial/modification terms, but full original authority and bundled license were not verified.',
      },
    ],
    checkedAt: CHECKED_AT,
    uncertainties: [
      'Some items repeat individual license terms; neither every item is CC0 nor every item should be called infringing.',
      'VIP free-download benefits are not necessarily zero-cost access.',
      'Trace and acquire the verified original instead of assuming the mirror owns licensing rights.',
      'Automated access permissions were not verified.',
    ],
  },
  {
    id: 'kenney',
    name: 'Kenney Assets',
    suppliedUrl: 'https://kenney.nl/games',
    searchUrl: 'https://kenney.nl/assets',
    referenceUrl: 'https://kenney.nl/games',
    kind: 'asset-library',
    automation: 'unknown',
    lookupModes: ['metadata-search', 'manual-browse'],
    automaticDownload: false,
    importPolicy: 'per-pack-license-gate',
    licenseScope: 'Official support scopes CC0 to asset-page game assets, not games, tools, logos or every linked product.',
    policyUrls: [
      'https://kenney.nl/support',
      'https://creativecommons.org/publicdomain/zero/1.0/',
      'https://creativecommons.org/publicdomain/zero/1.0/legalcode.en',
    ],
    evidenceUrls: [
      'https://kenney.nl/games',
      'https://kenney.nl/assets',
      'https://kenney.nl/support',
      'https://kenney.nl/assets/ui-pack',
    ],
    candidateAccessLinks: [{
      url: 'https://kenney.nl/assets/ui-pack',
      status: 'per-pack-candidate',
      notes: 'Inspected page states CC0 and free download without donating; per-file/dependency checks are still required.',
    }],
    checkedAt: CHECKED_AT,
    uncertainties: [
      'The supplied /games URL is valid but is a games catalog, not reusable asset permission.',
      'Attribution is optional for verified asset-page assets; studio logo use is reserved.',
      'Paid All-in-1 access and other products do not inherit a free price flag.',
      'CC0 does not guarantee noninfringement or clear third-party trademark/patent/publicity rights.',
      'Automated access permissions were not verified.',
    ],
  },
])

const MAX_EVIDENCE_DEPTH = 8
const STANDARD_REVIEWED_LICENSES = new Set(['CC0', 'CC0-1.0', 'MIT', 'APACHE-2.0', 'OFL-1.1', 'CC-BY-4.0'])
const UNKNOWN_LICENSE_LABELS = new Set(['UNKNOWN', 'UNVERIFIED', 'UNCLEAR', 'FREE', 'ROYALTY-FREE', 'NONE', 'UNLICENSED'])
const REFERENCE_DOMAINS = ['gameui.net', 'gameuiux.cn', 'interfaceingame.com', 'lemooui.com']
const ORIGINAL_ACCESS_DOMAINS = [...REFERENCE_DOMAINS, 'pixlab24.com']
const PAID_FLAGS = ['paid', 'vipOnly', 'requiresPurchase', 'requiresPaidSubscription']
const REQUIRED_PERMISSIONS = ['commercial', 'modification', 'gameEmbedding', 'gameRedistribution']
const NON_ITEM_GRANT_URLS = new Set([
  ...FREE_ASSET_SOURCES.flatMap((source) => [source.suppliedUrl, source.searchUrl, source.referenceUrl]),
  'https://kenney.nl/support',
  'https://www.lemooui.com/about/12',
  'https://www.lemooui.com/about/13',
  'https://pixlab24.com/vip-prices',
  'https://interfaceingame.com/terms-and-conditions/',
  'https://interfaceingame.com/copyright-complaints/',
].filter(Boolean).map((value) => urlKey(documentUrl(value))))

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function documentUrl(value) {
  if (!hasText(value)) return null
  try {
    const parsed = new URL(value.trim())
    if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return null
    return parsed
  } catch {
    return null
  }
}

function urlKey(parsed) {
  if (!parsed) return ''
  return `${parsed.hostname.toLowerCase().replace(/^www\./, '')}${parsed.pathname.replace(/\/+$/, '')}`
}

function matchesDomain(parsed, domain) {
  return parsed && (parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))
}

function itemPermissionEvidence(parsed) {
  if (!parsed) return false
  if (NON_ITEM_GRANT_URLS.has(urlKey(parsed))) return false
  if (matchesDomain(parsed, 'creativecommons.org') && /^\/(licenses|publicdomain)\//.test(parsed.pathname)) return false
  if (matchesDomain(parsed, 'opensource.org') && /^\/licenses?\//.test(parsed.pathname)) return false
  if (matchesDomain(parsed, 'openfontlicense.org')) return false
  return true
}

function inspectAccess(record, hold, reject) {
  const asset = documentUrl(record.assetUrl)
  const original = documentUrl(record.original?.url)
  if (matchesDomain(asset, 'kenney.nl') && /^\/games(?:\/|$)/.test(asset.pathname)) {
    reject('KENNEY_GAMES_NOT_ASSET_SOURCE')
  }
  if (REFERENCE_DOMAINS.some((domain) => matchesDomain(asset, domain)) && /screenshot|portfolio|reference|game-extract/i.test(record.kind ?? '')) {
    reject('REFERENCE_CONTENT_NOT_IMPORTABLE')
  }
  if (ORIGINAL_ACCESS_DOMAINS.some((domain) => matchesDomain(asset, domain) || matchesDomain(original, domain))) {
    hold('ORIGINAL_CREATOR_ACCESS_REQUIRED')
  }
  if (!itemPermissionEvidence(documentUrl(record.license?.evidenceUrl))) hold('ITEM_LICENSE_EVIDENCE_REQUIRED')
}

function inspectFont(record, id, hold, reject) {
  // OFL governs font files/derivatives, not ordinary documents or text images made with them.
  if (record.kind !== 'font' || id !== 'OFL-1.1') return
  const compliance = isRecord(record.fontCompliance) ? record.fontCompliance : {}
  if (compliance.standaloneSale === true) reject('FONT_STANDALONE_SALE_FORBIDDEN')
  if (compliance.licensePreserved !== true || compliance.standaloneSale !== false || compliance.reservedNamesSatisfied !== true) {
    hold('FONT_OBLIGATIONS_UNVERIFIED')
  }
}

function inspectRecord(record, path, state, depth) {
  const hold = (code) => state.holds.push(path ? `${path}:${code}` : code)
  const reject = (code) => state.rejects.push(path ? `${path}:${code}` : code)
  if (!isRecord(record)) {
    hold('MISSING_OR_MALFORMED_RECORD')
    return
  }
  if (depth > MAX_EVIDENCE_DEPTH || state.ancestors.has(record)) {
    hold('CYCLIC_OR_TOO_DEEP_EVIDENCE')
    return
  }
  state.ancestors.add(record)

  const cost = isRecord(record.cost) ? record.cost : {}
  const original = isRecord(record.original) ? record.original : {}
  const license = isRecord(record.license) ? record.license : {}
  const checks = isRecord(record.checks) ? record.checks : {}
  const id = hasText(license.id) ? license.id.trim().toUpperCase().replace(/_/g, '-') : ''

  if ([checks.ripped, checks.disputed, record.ripped, record.disputed].some((flag) => flag === true)) reject('RIPPED_OR_DISPUTED')
  if (checks.ripped !== false || checks.disputed !== false) hold('PROVENANCE_CONFLICT_CHECKS_UNVERIFIED')
  if ((Number.isFinite(cost.amount) && cost.amount > 0) || PAID_FLAGS.some((flag) => cost[flag] === true || record[flag] === true)) reject('PAID_OR_VIP_ACCESS')
  if (PAID_FLAGS.some((flag) => cost[flag] !== undefined && typeof cost[flag] !== 'boolean')) hold('PAID_ACCESS_UNVERIFIED')
  if (cost.amount !== 0 || cost.verified !== true || !documentUrl(cost.evidenceUrl)) hold('COST_NOT_VERIFIED_ZERO')

  for (const field of ['assetName', 'creator', 'version', 'kind', 'checkedAt']) {
    if (!hasText(record[field])) hold(`MISSING_IDENTITY_${field.toUpperCase()}`)
  }
  if (!documentUrl(record.assetUrl)) hold('ASSET_URL_UNVERIFIED')
  if (original.authoritative !== true || !documentUrl(original.url) || !documentUrl(original.evidenceUrl)) hold('ORIGINAL_AUTHORITY_UNVERIFIED')
  if (!id || UNKNOWN_LICENSE_LABELS.has(id)) hold('LICENSE_ID_UNVERIFIED')
  if (/(?:^|-)(?:NC|ND)(?:-|$)/.test(id) || license.nonCommercial === true || license.noDerivatives === true) reject('NC_OR_ND_LICENSE')
  if (!STANDARD_REVIEWED_LICENSES.has(id) && license.additionalReviewSatisfied !== true) hold('ADDITIONAL_LICENSE_REVIEW_REQUIRED')
  if (!documentUrl(license.termsUrl) || !documentUrl(license.evidenceUrl) || license.authoritative !== true || license.scopeVerified !== true) hold('LICENSE_AUTHORITY_OR_SCOPE_UNVERIFIED')
  for (const permission of REQUIRED_PERMISSIONS) {
    if (license[permission] === false) reject(`INTENDED_USE_DENIED_${permission.toUpperCase()}`)
    if (license[permission] !== true) hold(`INTENDED_USE_UNVERIFIED_${permission.toUpperCase()}`)
  }
  if (license.noticesSatisfied !== true || !hasText(license.noticeEvidence)) hold('LICENSE_NOTICES_UNSATISFIED')
  if (license.obligationsSatisfied !== true) hold('LICENSE_OBLIGATIONS_UNVERIFIED')
  for (const check of ['dependencies', 'ip', 'provenance']) {
    if (checks[check] !== true) hold(`REVIEW_UNVERIFIED_${check.toUpperCase()}`)
  }

  inspectAccess(record, hold, reject)
  inspectFont(record, id, hold, reject)
  if (!Array.isArray(record.dependencies)) hold('DEPENDENCY_RECORDS_UNVERIFIED')
  else record.dependencies.forEach((dependency, index) => inspectRecord(dependency, `${path ? `${path}.` : ''}dependencies[${index}]`, state, depth + 1))
  state.ancestors.delete(record)
}

/**
 * Assess a reviewer's documented record; never fetch, download, inspect a real license,
 * certify legal rights, authorize scraping or infer permissions from a source entry.
 *
 * Mandatory fields (also on every declared dependency):
 * assetName, assetUrl, creator, version, kind, checkedAt;
 * cost { amount: 0, verified: true, evidenceUrl };
 * original { url, evidenceUrl, authoritative: true };
 * license { id, termsUrl, evidenceUrl, authoritative: true, scopeVerified: true,
 *   commercial: true, modification: true, gameEmbedding: true, gameRedistribution: true,
 *   noticesSatisfied: true, noticeEvidence: string, obligationsSatisfied: true };
 * checks { dependencies: true, ip: true, provenance: true, ripped: false, disputed: false };
 * dependencies [] (only after checking none exist) or fully documented material records.
 *
 * sourceId is an optional discovery hint, not the copyright owner or an inherited license.
 * Known paid/VIP flags, NC/ND, ripped/disputed evidence and explicitly denied use reject.
 * Missing, malformed, unverified or unsatisfied evidence holds. Custom/share-alike/other
 * terms need license.additionalReviewSatisfied === true. OFL-1.1 font files additionally
 * need fontCompliance { licensePreserved: true, standaloneSale: false,
 * reservedNamesSatisfied: true }. MIT notice obligations cannot be replaced by font terms.
 *
 * @param {unknown} candidate A documented reviewer record, not untrusted site claims.
 * @returns {{eligible: boolean, decision: 'allow'|'hold'|'reject', reasons: string[]}}
 */
export function assessFreeAssetCandidate(candidate) {
  const state = { holds: [], rejects: [], ancestors: new Set() }
  inspectRecord(candidate, '', state, 0)
  const decision = state.rejects.length > 0 ? 'reject' : state.holds.length > 0 ? 'hold' : 'allow'
  return {
    eligible: decision === 'allow',
    decision,
    reasons: [...new Set([...state.rejects, ...state.holds])],
  }
}
