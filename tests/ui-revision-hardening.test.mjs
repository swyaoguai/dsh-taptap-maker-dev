import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  createDemoDocument,
  createUiWorkspace,
  readUiWorkspace,
  saveUiRevision,
} from '../src/ui-workflow.mjs'

// Every mutation is confined to a fixture created here. Keep all temporary
// workspaces, commit records and documents for inspection; never remove them.
function committedFixture(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taptap-ui-revision-hardening-'))
  t.diagnostic(`Retained fixture (${label}): ${root}`)
  const initial = createUiWorkspace(root, { name: label, document: createDemoDocument() })
  const edited = createDemoDocument()
  edited.name = `${label} save 1`
  const previous = saveUiRevision(root, initial.workspaceId, edited, { baseRevision: initial.revisionId })
  const newest = createDemoDocument()
  newest.name = `${label} save 2`
  const latest = saveUiRevision(root, initial.workspaceId, newest, { baseRevision: previous.revisionId })
  const directory = path.resolve(root, initial.workspaceId)
  const file = path.join(directory, 'revisions', latest.revisionId, 'document.json')
  const recordFile = path.join(directory, 'revisions', latest.revisionId, 'revision.json')
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
  assert.equal(record.revisionId, latest.revisionId)
  assert.equal(record.baseRevision, previous.revisionId)
  assert.equal(record.sha256, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'))
  assert.equal(readUiWorkspace(root, initial.workspaceId).revisionId, latest.revisionId)
  return { root, initial, previous, latest, directory, file, recordFile, record }
}

function defaultRead(fixture) {
  try {
    return { loaded: readUiWorkspace(fixture.root, fixture.initial.workspaceId) }
  } catch (error) {
    return { error }
  }
}

test('default latest reports integrity when the newest committed document is changed', t => {
  const fixture = committedFixture(t, 'committed-document-tamper')
  // The revision.json commit exists and matched these bytes before corruption.
  fs.appendFileSync(fixture.file, '\n ')
  const result = defaultRead(fixture)
  t.diagnostic(result.error
    ? `Default latest error: ${result.error.code}`
    : `Default latest silently returned ${result.loaded.revisionId}; corrupted commit is ${fixture.latest.revisionId}`)
  assert.equal(result.error?.code, 'UI_INTEGRITY', 'A corrupt committed latest revision must not silently fall back to an older revision')
})

test('revision metadata cannot override trusted directory/file paths or legitimate lineage', t => {
  const failures = []
  // Independent fixtures let all three behaviors execute even if one fails.
  for (const field of ['directory', 'file', 'baseRevision']) {
    const fixture = committedFixture(t, `metadata-${field}`)
    const injected = field === 'directory'
      ? path.join(fixture.root, 'untrusted-directory')
      : field === 'file'
        ? path.join(fixture.root, 'untrusted-document.json')
        // This is an existing, well-formed ID in the SAME workspace, but it
        // illegally forks the initial revision instead of extending previous.
        : fixture.initial.revisionId
    fs.writeFileSync(fixture.recordFile, JSON.stringify({ ...fixture.record, [field]: injected }, null, 2) + '\n')
    const result = defaultRead(fixture)
    if (result.error?.code === 'UI_INTEGRITY') {
      t.diagnostic(`${field}: GREEN (tampered metadata rejected)`)
      continue
    }
    try {
      assert.ifError(result.error)
      assert.equal(result.loaded.revisionId, fixture.latest.revisionId, 'Do not hide a rejected committed revision by returning an older one')
      assert.equal(result.loaded.directory, fixture.directory, 'directory must be derived from root/workspaceId, never revision.json')
      assert.equal(result.loaded.file, fixture.file, 'file must be derived from the trusted directory/revisionId, never revision.json')
      assert.equal(result.loaded.baseRevision, fixture.previous.revisionId, 'A saved revision must retain its legitimate parent, not fork an older commit')
      t.diagnostic(`${field}: GREEN (trusted paths and lineage retained)`)
    } catch (error) {
      failures.push({ field, message: error.message })
      t.diagnostic(`${field}: RED (${error.message})`)
    }
  }
  assert.deepEqual(failures, [], 'Reject metadata tampering with UI_INTEGRITY or return only canonical paths and legitimate lineage')
})
