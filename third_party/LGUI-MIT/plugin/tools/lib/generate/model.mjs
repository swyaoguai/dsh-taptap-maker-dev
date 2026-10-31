// 把 ui/ 读成一份简单的结构：包 → 资源 → 组件（控件树、控制器、动效）。
// 生成控件类型、headless 描述、lgui ui list 和 lgui check 都用它。
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {LgCliError} from '../errors.mjs';

const require = createRequire(new URL('../../vendor/package.json', import.meta.url));

// XML → { tag, attrs, children, line }，保留顺序。root 是工程根目录（报错里的文件写成相对它的路径）。
function parseXml(file, root) {
  const {XMLParser} = require('fast-xml-parser');
  const text = fs.readFileSync(file, 'utf8');
  let tree;
  try {
    tree = new XMLParser({preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false, trimValues: true}).parse(text);
  } catch (error) {
    throw new LgCliError('LGUI-CLI-020', `XML 写错了：${error.message}`, {file: path.relative(root, file).split(path.sep).join('/'), fix: '按 UI 开发规范第 6 节的模板改。'});
  }
  const lines = text.split('\n');
  // 按 id 属性找行号（同一文件内元素 ID 唯一时准确；找不到就是 undefined）。
  const lineOf = id => {
    if (!id) return undefined;
    const index = lines.findIndex(line => line.includes(`id="${id}"`));
    return index >= 0 ? index + 1 : undefined;
  };
  const convert = node => {
    const tag = Object.keys(node).find(key => key !== ':@');
    const attrs = node[':@'] ?? {};
    const children = Array.isArray(node[tag]) ? node[tag].filter(child => !('#text' in child)).map(convert) : [];
    return {tag, attrs, children, line: lineOf(attrs.id)};
  };
  const roots = tree.filter(node => !('?xml' in node) && !('#text' in node)).map(convert);
  return {root: roots[0], file};
}

// 引用里的扩展类型 → 控件类型名（和接口层 UIKinds 一致）。
const extensionKinds = {Button: 'button', ProgressBar: 'progress', Label: 'label', Slider: 'slider', ComboBox: 'combobox'};
const tagKinds = {image: 'image', text: 'text', richtext: 'richtext', inputtext: 'input', graph: 'graph', loader: 'loader', list: 'list', tree: 'tree', movieclip: 'movieclip'};

// 解析 controller 的 pages="页ID,页名,页ID,页名…"。
export function parsePages(pages = '') {
  const parts = pages.split(',');
  const result = [];
  for (let i = 0; i + 1 < parts.length; i += 2) result.push({id: parts[i], name: parts[i + 1]});
  return result;
}

// 读整个 ui/：fairyPath 是 ui/UI.fairy。
export function readUiModel(fairyPath) {
  const assets = path.join(path.dirname(fairyPath), 'assets');
  const projectRoot = path.dirname(path.dirname(fairyPath));
  const packages = [];
  const byId = new Map();
  for (const dirName of fs.existsSync(assets) ? fs.readdirSync(assets).sort() : []) {
    const descriptor = path.join(assets, dirName, 'package.xml');
    if (!fs.existsSync(descriptor)) continue;
    const {root} = parseXml(descriptor, projectRoot);
    const pkg = {id: root.attrs.id, name: dirName, dir: path.join(assets, dirName), file: descriptor, line: 1, resources: [], components: []};
    const resources = root.children.find(child => child.tag === 'resources')?.children ?? [];
    for (const resource of resources) {
      const fileName = resource.attrs.name ?? '';
      const relPath = (resource.attrs.path ?? '/').replace(/^\/+/, '');
      pkg.resources.push({
        id: resource.attrs.id, type: resource.tag, fileName, path: resource.attrs.path ?? '/',
        name: fileName.replace(/\.[^.]+$/, ''), exported: resource.attrs.exported === 'true',
        file: path.join(pkg.dir, relPath, fileName), attrs: resource.attrs, line: undefined, descriptor
      });
    }
    packages.push(pkg);
    byId.set(pkg.id, pkg);
  }
  // 组件：读每个组件 XML。
  for (const pkg of packages) {
    for (const resource of pkg.resources.filter(item => item.type === 'component')) {
      if (!fs.existsSync(resource.file)) continue;
      const {root} = parseXml(resource.file, projectRoot);
      const displayList = root.children.find(child => child.tag === 'displayList')?.children ?? [];
      const extension = root.attrs.extention ?? root.attrs.extension ?? null;
      // 按钮的模式（Common / Check / Radio）：只有 Check、Radio 能保持选中，列表的选中项靠它显示。
      const buttonMode = extension === 'Button' ? (root.children.find(child => child.tag === 'Button')?.attrs.mode ?? 'Common') : null;
      // 滑动条是不是只取整数（用户拖动时取整）。
      const wholeNumbers = extension === 'Slider' ? root.children.find(child => child.tag === 'Slider')?.attrs.wholeNumbers === 'true' : null;
      pkg.components.push({
        pkg, resource, id: resource.id, name: resource.name, fullName: `${pkg.name}/${resource.name}`,
        exported: resource.exported, file: resource.file, size: root.attrs.size ?? '0,0', extension, buttonMode, wholeNumbers,
        controllers: root.children.filter(child => child.tag === 'controller').map(child => ({name: child.attrs.name, pages: parsePages(child.attrs.pages), selected: Number(child.attrs.selected ?? 0), line: lineIn(resource.file, `name="${child.attrs.name}"`)})),
        transitions: root.children.filter(child => child.tag === 'transition').map(child => child.attrs.name),
        children: displayList.map(node => ({...node, name: node.attrs.name, id: node.attrs.id})),
        root
      });
    }
  }
  const model = {fairyPath, packages, byId};
  // 子组件引用：给每个 component 子控件找到它引用的组件，并定下控件类型。
  for (const pkg of packages) {
    for (const component of pkg.components) {
      for (const child of component.children) {
        child.ref = ['component', 'list', 'tree'].includes(child.tag) ? resolveRef(model, pkg, child) : null;
        child.kind = kindOf(child);
      }
    }
  }
  return model;
}

function lineIn(file, needle) {
  const index = fs.readFileSync(file, 'utf8').split('\n').findIndex(line => line.includes(needle));
  return index >= 0 ? index + 1 : undefined;
}

// 组件实例的 src（同包资源 ID）+ pkg（跨包时的包 ID），或列表的 defaultItem（ui://包ID资源ID）。
function resolveRef(model, pkg, child) {
  let pkgId = child.attrs.pkg ?? pkg.id;
  let resId = child.attrs.src;
  if (child.tag === 'list' || child.tag === 'tree') {
    const url = child.attrs.defaultItem ?? '';
    if (!url.startsWith('ui://') || url.length < 'ui://'.length + 9) return null;
    pkgId = url.slice(5, url.length - 8);
    resId = url.slice(-8);
  }
  const target = model.byId.get(pkgId);
  return target?.components.find(component => component.id === resId) ?? null;
}

function kindOf(child) {
  if (child.tag === 'list' && child.attrs.treeView === 'true') return 'tree';
  if (tagKinds[child.tag]) return tagKinds[child.tag];
  if (child.tag === 'component') return extensionKinds[child.ref?.extension] ?? 'component';
  return null; // group 等不进类型
}

export function findComponent(model, fullName) {
  const [pkgName, compName] = fullName.split('/');
  return model.packages.find(pkg => pkg.name === pkgName)?.components.find(component => component.name === compName) ?? null;
}
