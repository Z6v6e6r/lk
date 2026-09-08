import ts from 'typescript';

const declarationText = (sourceFile, declaration, flags) => {
  const keyword = flags & ts.NodeFlags.Let ? 'let' : flags & ts.NodeFlags.Var ? 'var' : 'const';
  return `${keyword} ${declaration.getText(sourceFile)};`;
};

const isTopLevelDeclarationName = node => ts.isIdentifier(node)
  && ((ts.isVariableDeclaration(node.parent) && node.parent.name === node)
    || (ts.isFunctionDeclaration(node.parent) && node.parent.name === node));

const isNonReferenceName = node => {
  const parent = node.parent;
  return isTopLevelDeclarationName(node)
    || (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || (ts.isPropertyAssignment(parent) && parent.name === node)
    || (ts.isPropertyDeclaration(parent) && parent.name === node)
    || (ts.isMethodDeclaration(parent) && parent.name === node)
    || (ts.isPropertySignature(parent) && parent.name === node)
    || (ts.isBindingElement(parent) && parent.name === node);
};

const bindingNames = (node, names = new Set()) => {
  if (ts.isIdentifier(node)) names.add(node.text);
  else if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    for (const element of node.elements) if (ts.isBindingElement(element)) bindingNames(element.name, names);
  } else if (ts.isBindingElement(node)) bindingNames(node.name, names);
  return names;
};

const hasParseErrors = file => file.parseDiagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);

const collectDeclarations = (source, label) => {
  const file = ts.createSourceFile(`${label}.js`, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  if (hasParseErrors(file)) throw new Error(`${label}: source parse diagnostics`);
  const declarations = new Map();
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.text;
      if (declarations.has(name)) throw new Error(`${label}: duplicate top-level declaration ${name}`);
      declarations.set(name, { name, node: statement, text: statement.getText(file) });
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      if (declarations.has(name)) throw new Error(`${label}: duplicate top-level declaration ${name}`);
      declarations.set(name, {
        name,
        node: declaration,
        text: declarationText(file, declaration, statement.declarationList.flags),
      });
    }
  }
  return { file, declarations };
};

const dependenciesFor = (record, declarations) => {
  const dependencies = new Set();
  const scope = parent => ({ bindings: new Set(), parent });
  const isBound = (current, name) => {
    for (let item = current; item; item = item.parent) if (item.bindings.has(name)) return true;
    return false;
  };
  const addStatementBindings = (node, current) => {
    if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
      for (const name of bindingNames(declaration.name)) current.bindings.add(name);
    }
    if (ts.isFunctionDeclaration(node) && node.name) current.bindings.add(node.name.text);
  };
  const visitList = (nodes, current) => {
    for (const node of nodes) addStatementBindings(node, current);
    for (const node of nodes) visit(node, current);
  };
  const visit = (node, current) => {
    if (ts.isIdentifier(node)) {
      if (!isNonReferenceName(node) && !isBound(current, node.text) && declarations.has(node.text)) dependencies.add(node.text);
      return;
    }
    if (ts.isFunctionLike(node)) {
      const inner = scope(current);
      if (node.name && ts.isIdentifier(node.name)) inner.bindings.add(node.name.text);
      for (const parameter of node.parameters) for (const name of bindingNames(parameter.name)) inner.bindings.add(name);
      if (node.body && ts.isBlock(node.body)) visitList(node.body.statements, inner);
      else if (node.body) visit(node.body, inner);
      return;
    }
    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      const inner = scope(current); visitList(node.statements, inner); return;
    }
    if (ts.isCatchClause(node)) {
      const inner = scope(current);
      if (node.variableDeclaration) for (const name of bindingNames(node.variableDeclaration.name)) inner.bindings.add(name);
      visit(node.block, inner); return;
    }
    ts.forEachChild(node, child => visit(child, current));
  };
  visit(record.node, scope(null));
  dependencies.delete(record.name);
  return [...dependencies].sort();
};

/**
 * Extracts an ordered, source-faithful top-level declaration closure.
 * It parses only; it never evaluates the supplied Node-RED function source.
 */
export function extractSubscriptionPricePreviewSource({ source, label = 'candidate', roots }) {
  if (typeof source !== 'string' || !source.length) throw new Error(`${label}: source is required`);
  if (!Array.isArray(roots) || roots.length === 0 || roots.some(root => typeof root !== 'string' || !root)) {
    throw new Error(`${label}: explicit root declarations are required`);
  }
  const { declarations } = collectDeclarations(source, label);
  for (const root of roots) if (!declarations.has(root)) throw new Error(`${label}: missing top-level declaration ${root}`);
  const needed = new Set();
  const visit = name => {
    if (needed.has(name)) return;
    const record = declarations.get(name);
    if (!record) throw new Error(`${label}: missing transitive declaration ${name}`);
    needed.add(name);
    for (const dependency of dependenciesFor(record, declarations)) visit(dependency);
  };
  for (const root of roots) visit(root);
  const ordered = [...declarations.keys()].filter(name => needed.has(name));
  return { source: ordered.map(name => declarations.get(name).text).join('\n\n'), names: ordered };
}

/** Keeps equal declaration names in different candidates in separate closures. */
export function extractSubscriptionPricePreviewSources(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('At least one named source is required');
  const seen = new Set();
  return inputs.map(input => {
    if (!input || typeof input.name !== 'string' || !input.name || seen.has(input.name)) throw new Error('Source names must be unique');
    seen.add(input.name);
    return { name: input.name, ...extractSubscriptionPricePreviewSource(input) };
  });
}
