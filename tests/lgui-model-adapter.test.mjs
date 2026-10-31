import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateUiDocument } from '../src/ui-document.mjs'

const moduleUrl = new URL('../src/lgui-import.mjs', import.meta.url)
let importer = {}
try { importer = await import(moduleUrl) } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || error.url !== moduleUrl.href) throw error
}
function call(name, ...args) {
  assert.equal(typeof importer[name], 'function', `Safe historical LGUI adapter missing: ${name}`)
  return importer[name](...args)
}
function fixture({ packageId = 'PKG00001', descriptor, main, button, extraPackages } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lgui-ui-test-'))
  const ui = path.join(root, 'ui'); const directory = path.join(ui, 'assets', 'Camp')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(ui, 'UI.fairy'), '<project/>', { flag: 'wx' })
  fs.writeFileSync(path.join(directory, 'package.xml'), descriptor ?? `<packageDescription id="${packageId}"><resources><component id="MAIN0001" name="Shop.xml" path="/" exported="true"/><component id="BTN00001" name="Buy.xml" path="/"/></resources></packageDescription>`, { flag: 'wx' })
  fs.writeFileSync(path.join(directory, 'Shop.xml'), main ?? '<component size="640,360"><displayList><graph id="frame" name="frame" xy="20,20" size="600,320" type="rect" fillColor="#243D4A"/><text id="title" name="title" xy="32,44" size="400,50" text="营地 &amp; 商店" fontSize="24" color="#EEEEEE"/><component id="buy" name="buy" src="BTN00001" xy="400,220" size="120,44"><Button title="购买"/></component></displayList></component>', { flag: 'wx' })
  fs.writeFileSync(path.join(directory, 'Buy.xml'), button ?? '<component size="120,44" extention="Button"><Button mode="Common"/><displayList><text id="button-title" name="title" xy="0,0" size="120,44" text="购买" fontSize="18" align="center" color="#FFFFFF"/></displayList></component>', { flag: 'wx' })
  for (const extra of extraPackages ?? []) {
    const dir = path.join(ui, 'assets', extra.name); fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'package.xml'), extra.descriptor, { flag: 'wx' })
  }
  return { root, ui, directory, fairy: path.join(ui, 'UI.fairy') }
}
// All fixtures are newly authored and retained; no cleanup/deletion occurs.

test('stdlib XML decoding preserves element order, string attrs and escaped text', () => {
  const decoded = call('decodeLguiXml', '<?xml version="1.0"?><component id="007"><displayList><text id="a" text="A &amp; B"/>ignored<graph id="b"/></displayList></component>')
  assert.equal(decoded.tag, 'component')
  assert.equal(decoded.attrs.id, '007')
  assert.deepEqual(decoded.children[0].children.map(child => child.tag), ['text', 'graph'])
  assert.equal(decoded.children[0].children[0].attrs.text, 'A & B')
})

test('DTD, entities, namespaces, deep and oversized XML fail closed', () => {
  for (const text of ['<!DOCTYPE component [<!ENTITY a "x">]><component/>', '<!ENTITY a SYSTEM "file:///secret"><component/>', '<x:component xmlns:x="urn:test"/>', '<component>', '<component>' + '<a>'.repeat(40) + '</a>'.repeat(40) + '</component>', '<component text="' + 'x'.repeat(1_100_000) + '"/>']) {
    assert.throws(() => call('decodeLguiXml', text), error => /^UI_XML/.test(error.code))
  }
})

test('the adapted historical model keeps packages, Maps, extensions and refs', () => {
  const files = fixture()
  const model = call('readLguiModel', files.fairy)
  assert.equal(model.packages.length, 1)
  assert.ok(model.byId instanceof Map)
  const component = model.packages[0].components.find(component => component.name === 'Shop')
  const button = component.children.find(child => child.id === 'buy')
  assert.equal(button.kind, 'button')
  assert.equal(button.ref.buttonMode, 'Common')
  assert.equal(button.ref.extension, 'Button')
  assert.equal(component.children[1].attrs.text, '营地 & 商店')
})

test('historical pages pairing and extention precedence are kept by the source adapter', () => {
  const files = fixture({ button: '<component size="120,44" extention="Button" extension="Slider"><controller name="mode" pages="zero,默认,one,打开,dangling" selected="1"/><Button mode="Check"/><displayList/></component>' })
  const model = call('readLguiModel', files.fairy)
  const button = model.packages[0].components.find(component => component.name === 'Buy')
  assert.equal(button.extension, 'Button')
  assert.equal(button.buttonMode, 'Check')
  assert.deepEqual(button.controllers[0].pages, [{ id: 'zero', name: '默认' }, { id: 'one', name: '打开' }])
  assert.equal(button.controllers[0].selected, 1)
})

test('basic graphs, text and Common buttons project into a stable acyclic document', () => {
  const files = fixture()
  const a = call('importLguiComponent', files.fairy, 'Camp/Shop')
  const b = call('importLguiComponent', files.fairy, 'Camp/Shop')
  assert.equal(validateUiDocument(a.document).ok, true)
  assert.deepEqual(a.document.nodes.map(node => node.id), b.document.nodes.map(node => node.id))
  assert.equal(a.document.nodes.find(node => node.type === 'button').props.text, '购买')
  assert.ok(a.document.nodes.some(node => node.type === 'label' && node.props.text === '营地 & 商店'))
  assert.doesNotThrow(() => JSON.stringify(a.document))
  assert.equal(a.document.source.commit, 'e962aa3617aaad5a2fd5ddf2c80ace4bb1551240')
  assert.equal(a.document.assets.length, 0)
})

test('original source attributes cannot become extra live props or executable callbacks', () => {
  const files = fixture({ main: '<component size="640,360"><displayList><text id="label" xy="0,0" size="600,100" text="&lt;script&gt;alert(1)&lt;/script&gt;" onClick="evil()"/></displayList></component>' })
  assert.throws(() => call('importLguiComponent', files.fairy, 'Camp/Shop'), error => error.code === 'UI_IMPORT_UNSUPPORTED')
})

test('controller, relation, transition, rich text and virtual lists are not silently downgraded', () => {
  for (const addition of ['<controller name="mode" pages="a,A"/>', '<transition name="fade"/>', '<relation target="x" sidePair="width-width"/>']) {
    const files = fixture({ main: `<component size="640,360">${addition}<displayList/></component>` })
    assert.throws(() => call('importLguiComponent', files.fairy, 'Camp/Shop'), error => error.code === 'UI_IMPORT_UNSUPPORTED')
  }
  for (const tag of ['richtext', 'inputtext', 'list', 'movieclip', 'tree']) {
    const files = fixture({ main: `<component size="640,360"><displayList><${tag} id="unsupported" xy="0,0" size="100,100"/></displayList></component>` })
    assert.throws(() => call('importLguiComponent', files.fairy, 'Camp/Shop'), error => error.code === 'UI_IMPORT_UNSUPPORTED')
  }
})

test('resource traversal, Windows drive/UNC and backslash paths are rejected before reads', () => {
  for (const resourcePath of ['../', '/../../', 'C:/Users/', '//server/share/', 'folder\\..\\']) {
    const files = fixture({ descriptor: `<packageDescription id="PKG00001"><resources><component id="MAIN0001" name="Shop.xml" path="${resourcePath}"/></resources></packageDescription>` })
    assert.throws(() => call('readLguiModel', files.fairy), error => error.code === 'UI_IMPORT_PATH')
  }
  const invalidName = fixture({ descriptor: '<packageDescription id="PKG00001"><resources><component id="MAIN0001" name="../secret.xml" path="/"/></resources></packageDescription>' })
  assert.throws(() => call('readLguiModel', invalidName.fairy), error => error.code === 'UI_IMPORT_PATH')
})

test('duplicate package/resource/element IDs and missing component files are diagnosed', () => {
  const duplicatePackage = fixture({ extraPackages: [{ name: 'Other', descriptor: '<packageDescription id="PKG00001"><resources/></packageDescription>' }] })
  assert.throws(() => call('readLguiModel', duplicatePackage.fairy), error => error.code === 'UI_IMPORT_DUPLICATE')
  const duplicateResource = fixture({ descriptor: '<packageDescription id="PKG00001"><resources><component id="MAIN0001" name="Shop.xml" path="/"/><component id="MAIN0001" name="Buy.xml" path="/"/></resources></packageDescription>' })
  assert.throws(() => call('readLguiModel', duplicateResource.fairy), error => error.code === 'UI_IMPORT_DUPLICATE')
  const duplicateElement = fixture({ main: '<component size="640,360"><displayList><text id="a"/><text id="a"/></displayList></component>' })
  assert.throws(() => call('readLguiModel', duplicateElement.fairy), error => error.code === 'UI_IMPORT_DUPLICATE')
  const missing = fixture({ descriptor: '<packageDescription id="PKG00001"><resources><component id="MAIN0001" name="Missing.xml" path="/"/></resources></packageDescription>' })
  assert.throws(() => call('readLguiModel', missing.fairy), error => error.code === 'UI_IMPORT_RESOURCE')
})

test('malformed package roots and unresolved component refs are errors, not partial success', () => {
  const wrong = fixture({ descriptor: '<notPackage/>' })
  assert.throws(() => call('readLguiModel', wrong.fairy), error => error.code === 'UI_IMPORT_SCHEMA')
  const unresolved = fixture({ main: '<component size="640,360"><displayList><component id="missing" src="UNKNOWN1" xy="0,0" size="100,100"/></displayList></component>' })
  assert.throws(() => call('readLguiModel', unresolved.fairy), error => error.code === 'UI_IMPORT_REFERENCE')
  assert.throws(() => call('importLguiComponent', fixture().fairy, 'Camp/Missing'), error => error.code === 'UI_IMPORT_COMPONENT')
})

test('component recursion is rejected when projecting rather than serializing the cyclic model', () => {
  const files = fixture({ main: '<component size="640,360"><displayList><component id="self" src="MAIN0001" xy="0,0" size="640,360"/></displayList></component>' })
  assert.throws(() => call('importLguiComponent', files.fairy, 'Camp/Shop'), error => error.code === 'UI_IMPORT_UNSUPPORTED')
})

test('images require an explicit reviewed resource-rights record, never LGUI example licensing', () => {
  const files = fixture({ descriptor: '<packageDescription id="PKG00001"><resources><component id="MAIN0001" name="Shop.xml" path="/"/><image id="ICON0001" name="icon.png" path="/"/></resources></packageDescription>', main: '<component size="640,360"><displayList><image id="icon" src="ICON0001" xy="0,0" size="32,32"/></displayList></component>' })
  fs.writeFileSync(path.join(files.directory, 'icon.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), { flag: 'wx' })
  assert.throws(() => call('importLguiComponent', files.fairy, 'Camp/Shop'), error => error.code === 'UI_IMPORT_LICENSE')
})
