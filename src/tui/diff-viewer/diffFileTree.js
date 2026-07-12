// Diff viewer file tree utilities — straight ESM port of
// opencodeAX/packages/tui/src/feature-plugins/system/diff-viewer-file-tree-utils.ts.
//
// Builds a navigable directory tree from a flat list of changed files and
// exposes selection helpers used by the diff viewer. Kept framework-agnostic
// (no React) so it can be unit-tested directly like the other UI utilities
// (src/ui/commands.js, src/tui/contextViz.js).

/**
 * @typedef {{ file: string, status?: 'added'|'deleted'|'modified' }} FileTreeItem
 * @typedef {{ id: number, name: string, parent?: number, children: number[], depth: number, kind: 'directory'|'file', fileIndex?: number }} FileTreeNode
 * @typedef {{ roots: number[], nodes: FileTreeNode[] }} FileTree
 * @typedef {{ id: number, depth: number, kind: 'directory'|'file', name: string, fileIndex?: number }} FileTreeRow
 */

export function buildFileTree(files) {
  const roots = [];
  const nodes = [];
  const directoryByPath = new Map();

  files.forEach((file, fileIndex) => {
    const segments = (file.file || '').split('/').filter(Boolean);
    if (segments.length === 0) return;

    const parent = segments.slice(0, -1).reduce(
      (state, segment) => {
        const directoryPath = state.path ? `${state.path}/${segment}` : segment;
        const existing = directoryByPath.get(directoryPath);
        if (existing !== undefined) return { id: existing, path: directoryPath, depth: state.depth + 1 };

        const id = addFileTreeNode(nodes, roots, {
          name: segment,
          parent: state.id,
          depth: state.depth,
          kind: 'directory',
        });
        directoryByPath.set(directoryPath, id);
        return { id, path: directoryPath, depth: state.depth + 1 };
      },
      { id: undefined, path: '', depth: 0 },
    );

    addFileTreeNode(nodes, roots, {
      name: segments[segments.length - 1],
      parent: parent.id,
      depth: parent.depth,
      kind: 'file',
      fileIndex,
    });
  });

  const tree = { roots, nodes };
  tree.roots.sort((a, b) => compareFileTreeNodes(tree, a, b));
  tree.nodes.forEach((n) => n.children.sort((a, b) => compareFileTreeNodes(tree, a, b)));
  return tree;
}

export function flattenFileTree(tree, expanded) {
  const rows = [];
  const visit = (id, depth) => {
    const node = tree.nodes[id];
    if (!node) return;
    if (node.kind === 'file') {
      rows.push({ id: node.id, depth, kind: node.kind, name: node.name, fileIndex: node.fileIndex });
      return;
    }
    const chain = collapsedFileTreeDirectoryChain(tree, node.id);
    const last = chain[chain.length - 1];
    rows.push({
      id: node.id,
      depth,
      kind: node.kind,
      name: chain.map((c) => c.name).join('/'),
      fileIndex: node.fileIndex,
    });
    if (!expanded || expanded.has(node.id)) {
      for (const child of last.children) visit(child, depth + 1);
    }
  };
  for (const r of tree.roots) visit(r, 0);
  return rows;
}

function collapsedFileTreeDirectoryChain(tree, id) {
  const node = tree.nodes[id];
  if (!node) return [];
  const child = node.children.length === 1 ? tree.nodes[node.children[0]] : undefined;
  if (!child || child.kind !== 'directory') return [node];
  return [node, ...collapsedFileTreeDirectoryChain(tree, child.id)];
}

export function compareFileTreeNodes(tree, left, right) {
  const l = tree.nodes[left];
  const r = tree.nodes[right];
  if (!l || !r) return 0;
  if (l.kind !== r.kind) return l.kind === 'directory' ? -1 : 1;
  if (l.name < r.name) return -1;
  if (l.name > r.name) return 1;
  return left - right;
}

export function moveFileTreeSelection(rows, selected, offset) {
  if (rows.length === 0) return undefined;
  const index = selected === undefined ? -1 : rows.findIndex((r) => r.id === selected);
  if (index === -1) return rows[0].id;
  return rows[Math.max(0, Math.min(rows.length - 1, index + offset))].id;
}

export function toggleFileTreeDirectory(tree, expanded, selected) {
  if (selected === undefined) return expanded;
  const node = tree.nodes[selected];
  if (!node || node.kind !== 'directory') return expanded;
  const next = new Set(expanded);
  if (next.has(selected)) next.delete(selected);
  else next.add(selected);
  return next;
}

export function allExpandedFileTreeDirectories(tree) {
  return new Set(tree.nodes.filter((n) => n.kind === 'directory').map((n) => n.id));
}

export function orderedPatchFileIndexes(rows) {
  return rows.flatMap((r) => (r.fileIndex === undefined ? [] : [r.fileIndex]));
}

export function fileTreeFileSelection(tree, fileIndex) {
  const node = tree.nodes.find((n) => n.kind === 'file' && n.fileIndex === fileIndex);
  if (!node) return undefined;
  return { highlightedNode: node.id, expandedNodes: fileTreeParentDirectories(tree, node.id) };
}

function fileTreeParentDirectories(tree, id) {
  const result = new Set();
  for (let p = tree.nodes[id]?.parent; p !== undefined; p = tree.nodes[p]?.parent) {
    result.add(p);
  }
  return result;
}

function addFileTreeNode(nodes, roots, input) {
  const id = nodes.length;
  nodes.push({ ...input, id, children: [] });
  if (input.parent === undefined) roots.push(id);
  else nodes[input.parent].children.push(id);
  return id;
}