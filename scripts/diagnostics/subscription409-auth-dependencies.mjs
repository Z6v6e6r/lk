// Deliberately narrow, fail-closed syntax attestation for the reviewed auth layout.
// parse is a pinned offline parser supplied by the preparation tool. No eval/import
// of production settings/helper code and no reading of credential values here.
const check = (ok, code) => { if (!ok) throw Error(code); };
const builtins = new Set(["crypto", "fs", "os", "path"]);
function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node, ancestors);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit, [...ancestors, node]));
    else if (value && typeof value === "object") walk(value, visit, [...ancestors, node]);
  }
}
const property = node => node?.type === "MemberExpression" && !node.computed ? node.property.name : null;
const moduleExports = node => node?.type === "MemberExpression" && node.object.name === "module" && property(node) === "exports";
function patternIds(node) {
  if (!node) return [];
  if (node.type === "Identifier") return [node];
  if (node.type === "AssignmentPattern") return patternIds(node.left);
  if (node.type === "RestElement") return patternIds(node.argument);
  if (node.type === "ArrayPattern") return node.elements.flatMap(patternIds);
  if (node.type === "ObjectPattern") return node.properties.flatMap(p => patternIds(p.type === "RestElement" ? p.argument : p.value));
  return [];
}
function bindingIndex(tree) {
  const bindings = new Map(), parents = new Map();
  const add = node => { for (const id of patternIds(node)) bindings.set(id.name, [...(bindings.get(id.name) || []), id]); };
  walk(tree, (n, ancestors) => {
    parents.set(n, ancestors.at(-1));
    if (n.type === "VariableDeclarator") add(n.id);
    if (/Function/.test(n.type)) { if (n.id) add(n.id); n.params.forEach(add); }
    if (["ClassDeclaration", "ClassExpression"].includes(n.type) && n.id) add(n.id);
    if (n.type === "CatchClause") add(n.param);
  });
  return { bindings, parents };
}
export function inspectAuthDependencySyntax({ settingsSource, helperSource, helperPath, parse }) {
  const parseSource = source => parse(source, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true });
  const settings = parseSource(settingsSource), helper = parseSource(helperSource), modules = new Set(), imports = [];
  const indexes = new Map([settings, helper].map(tree => [tree, bindingIndex(tree)]));
  const fsCalls = new Map();
  const isFsRequire = n => n?.type === "CallExpression" && n.callee.name === "require"
    && n.arguments[0]?.type === "Literal" && ["fs", "node:fs"].includes(n.arguments[0].value);
  for (const tree of [settings, helper]) {
    const aliases = new Set(), calls = [];
    const globalBuiltin = (node, ancestors) => {
      const [p, object, context, rootObject, assignment] = ancestors.slice(-5).reverse();
      return tree === settings && p?.type === "Property" && !p.computed && p.key.name === "fs" && p.value === node
        && object?.type === "ObjectExpression" && context?.type === "Property" && !context.computed
        && context.key.name === "functionGlobalContext" && context.value === object && rootObject?.type === "ObjectExpression"
        && assignment?.type === "AssignmentExpression" && assignment.right === rootObject && moduleExports(assignment.left);
    };
    walk(tree, (n, ancestors) => {
      if (isFsRequire(n)) {
        const parent = ancestors.at(-1);
        if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") aliases.add(parent.id.name);
        else check((parent?.type === "MemberExpression" && parent.object === n) || globalBuiltin(n, ancestors), "AUTH_FS_IMPORT_ESCAPE");
      }
    });
    for (const alias of aliases) check(indexes.get(tree).bindings.get(alias)?.length === 1, "AUTH_FS_SHADOWING");
    walk(tree, (n, ancestors) => {
      if (n.type === "Identifier" && aliases.has(n.name)) {
        const p = ancestors.at(-1);
        check((p?.type === "VariableDeclarator" && p.id === n) || (p?.type === "MemberExpression" && p.object === n && !p.computed)
          || globalBuiltin(n, ancestors), "AUTH_FS_ALIAS_ESCAPE");
      }
      if (n.type === "UpdateExpression" && n.argument.type === "Identifier" && aliases.has(n.argument.name)) throw Error("AUTH_FS_ESCAPE");
      if (n.type === "MemberExpression" && (isFsRequire(n.object) || (n.object.type === "Identifier" && aliases.has(n.object.name)))) {
        check(!n.computed && ["lstatSync", "realpathSync", "openSync", "fstatSync", "readFileSync", "closeSync", "constants"].includes(property(n)), "AUTH_FS_OPERATION_UNSUPPORTED");
        if (property(n) !== "constants") {
          const p = ancestors.at(-1); check(p?.type === "CallExpression" && p.callee === n, "AUTH_FS_ESCAPE"); calls.push(p);
        }
      }
    });
    fsCalls.set(tree, calls);
  }
  for (const [role, tree] of [["settings", settings], ["helper", helper]]) walk(tree, (node, ancestors) => {
    const forbidden = ["eval", "Function", "constructor", "createRequire", "getBuiltinModule", "_load", "mainModule", "binding", "dlopen"];
    if (node.type === "MemberExpression") {
      const name = node.computed ? node.property.type === "Literal" ? node.property.value : null : node.property.name;
      check(!forbidden.includes(name), "AUTH_DYNAMIC_LOADER_UNSUPPORTED");
      if (node.object.type === "Identifier" && ["process", "module"].includes(node.object.name)) {
        check(!node.computed && (node.object.name === "module" ? name === "exports"
          : ["env", "getuid", "getgid", "versions", "version", "platform", "pid", "execPath"].includes(name)), "AUTH_DYNAMIC_LOADER_UNSUPPORTED");
      }
      if (moduleExports(node)) {
        const p = ancestors.at(-1);
        const adminConfiguration = tree === settings && p?.type === "MemberExpression" && p.object === node
          && !p.computed && property(p) === "adminAuth";
        check((p?.type === "AssignmentExpression" && p.left === node && p.right.type === "ObjectExpression")
          || adminConfiguration, "AUTH_EXPORTED_CAPABILITY_READBACK");
      }
    }
    if (node.type === "Identifier" && ["global", "globalThis", "eval", "Function"].includes(node.name)) throw Error("AUTH_DYNAMIC_LOADER_UNSUPPORTED");
    if (node.type === "Identifier" && ["process", "module"].includes(node.name)) {
      const p = ancestors.at(-1); check(p?.type === "MemberExpression" && (p.object === node
        || (!p.computed && p.property === node)), "AUTH_DYNAMIC_LOADER_UNSUPPORTED");
    }
    if (node.type === "Identifier" && node.name === "exports") {
      const p = ancestors.at(-1); check(moduleExports(p) && p.property === node, "AUTH_EXPORTED_CAPABILITY_READBACK");
    }
    if (/^Import|^Export/.test(node.type)) throw Error("AUTH_DYNAMIC_MODULE_UNSUPPORTED");
    if (["CallExpression", "NewExpression"].includes(node.type)) {
      const callee = node.callee, member = property(callee);
      check(!(callee.type === "Identifier" && ["eval", "Function"].includes(callee.name))
        && !["eval", "Function", "constructor", "createRequire", "getBuiltinModule", "_load", "binding", "dlopen"].includes(member), "AUTH_DYNAMIC_LOADER_UNSUPPORTED");
      if (callee.type === "Identifier" && callee.name === "require") {
        check(node.arguments.length === 1 && node.arguments[0].type === "Literal" && typeof node.arguments[0].value === "string", "AUTH_NON_LITERAL_REQUIRE");
        const specifier = node.arguments[0].value, builtin = specifier.replace(/^node:/, "");
        if (builtins.has(builtin)) modules.add(builtin);
        else {
          check(role === "settings" && specifier === helperPath, "AUTH_UNRESOLVED_MODULE");
          imports.push({ node, ancestors });
        }
      }
      if (member === "require" || (callee.type === "MemberExpression" && callee.object.name === "require")) throw Error("AUTH_DYNAMIC_LOADER_UNSUPPORTED");
    }
    if (node.type === "Identifier" && node.name === "require") {
      const parent = ancestors.at(-1);
      check(parent?.type === "CallExpression" && parent.callee === node, "AUTH_REQUIRE_ESCAPE");
    }
  });
  check(imports.length === 1, "AUTH_HELPER_IMPORT_COUNT");
  const opens = [], reads = [], defaults = [], declarations = [], exportObjects = [];
  walk(helper, (node, ancestors) => {
    if (fsCalls.get(helper).includes(node) && property(node.callee) === "openSync") opens.push(node);
    if (fsCalls.get(helper).includes(node) && property(node.callee) === "readFileSync") reads.push(node);
    if (node.type === "AssignmentPattern") defaults.push({ node, ancestors });
    if (node.type === "VariableDeclarator") declarations.push(node);
    if (node.type === "AssignmentExpression" && node.left.type === "MemberExpression"
      && node.left.object.name === "module" && property(node.left) === "exports") exportObjects.push(node.right);
  });
  check(opens.length === 1 && reads.length === 1 && opens[0].arguments[0]?.type === "Identifier"
    && reads[0].arguments[0]?.type === "Identifier", "AUTH_FILE_READ_LAYOUT_UNSUPPORTED");
  const pathName = opens[0].arguments[0].name;
  const matchingDefaults = defaults.filter(d => d.node.left.type === "Identifier" && d.node.left.name === pathName);
  check(matchingDefaults.length === 1 && matchingDefaults[0].node.right.type === "Identifier", "AUTH_PATH_DEFAULT_UNSUPPORTED");
  const parameter = matchingDefaults[0], factory = [...parameter.ancestors].reverse().find(n => /Function/.test(n.type || ""));
  check(factory?.type === "FunctionDeclaration" && factory.params.length === 1 && factory.params[0] === parameter.node, "AUTH_FACTORY_LAYOUT_UNSUPPORTED");
  const constants = declarations.filter(d => d.id.name === parameter.node.right.name);
  check(constants.length === 1 && constants[0].init?.type === "Literal" && typeof constants[0].init.value === "string"
    && constants[0].init.value.startsWith("/"), "AUTH_DEFAULT_FILE_UNSUPPORTED");
  const index = indexes.get(helper), constantName = parameter.node.right.name;
  check(index.bindings.get(pathName)?.length === 1 && index.bindings.get(pathName)[0] === parameter.node.left
    && index.bindings.get(constantName)?.length === 1 && index.parents.get(constants[0])?.kind === "const"
    && index.bindings.get(factory.id.name)?.length === 1, "AUTH_PATH_BINDING_UNSUPPORTED");
  check(exportObjects.length === 1 && exportObjects[0].type === "ObjectExpression", "AUTH_EXPORT_LAYOUT_UNSUPPORTED");
  const factoryExports = exportObjects[0].properties.filter(p => p.type === "Property" && !p.computed
    && p.value.type === "Identifier" && p.value.name === factory.id.name);
  check(factoryExports.length === 1, "AUTH_FACTORY_EXPORT_UNSUPPORTED");
  const importSite = imports[0], member = importSite.ancestors.at(-1), call = importSite.ancestors.at(-2);
  check(member?.type === "MemberExpression" && member.object === importSite.node && !member.computed
    && property(member) === factoryExports[0].key.name && call?.type === "CallExpression"
    && call.callee === member && call.arguments.length === 0, "AUTH_FACTORY_OVERRIDE_UNSUPPORTED");
  const fdName = reads[0].arguments[0].name, fdAssignments = [];
  const fdBindings = index.bindings.get(fdName);
  check(fdBindings?.length === 1 && index.parents.get(fdBindings[0])?.type === "VariableDeclarator"
    && index.parents.get(fdBindings[0]).init === null, "AUTH_FD_PROVENANCE_UNSUPPORTED");
  walk(helper, (node, ancestors) => {
    if (node.type === "AssignmentExpression" && node.left.type === "Identifier" && node.left.name === fdName) fdAssignments.push(node);
    if (node.type === "AssignmentExpression" && patternIds(node.left).some(id => [pathName, constantName].includes(id.name))) throw Error("AUTH_PATH_REASSIGNMENT");
    if (node.type === "UpdateExpression" && patternIds(node.argument).some(id => [pathName, constantName, fdName].includes(id.name))) throw Error("AUTH_PATH_REASSIGNMENT");
    if (["ForInStatement", "ForOfStatement"].includes(node.type)
      && patternIds(node.left).some(id => [pathName, constantName, fdName, factory.id.name].includes(id.name))) throw Error("AUTH_PATH_REASSIGNMENT");
    if (node.type === "Identifier" && node.name === factory.id.name && node !== factory.id) {
      const p = ancestors.at(-1);
      check(p?.type === "Property" && exportObjects[0].properties.includes(p) && !p.computed
        && (p.value === node || (p.key === node && p.value.type === "Identifier" && p.value.name === factory.id.name)), "AUTH_FACTORY_ESCAPE");
    }
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === factory.id.name) throw Error("AUTH_EXTRA_FACTORY_CALL");
  });
  check(fdAssignments.length === 1 && fdAssignments[0].right === opens[0], "AUTH_FD_PROVENANCE_UNSUPPORTED");
  for (const call of fsCalls.get(helper)) {
    const operation = property(call.callee), arg = call.arguments[0];
    let isParentDirectory = false;
    if (["lstatSync", "realpathSync"].includes(operation) && arg?.type === "Identifier") {
      const defs = declarations.filter(d => d.id.name === arg.name), init = defs[0]?.init;
      const pathImport = init?.callee?.object?.type === "Identifier" ? declarations.filter(d => d.id.name === init.callee.object.name) : [];
      isParentDirectory = defs.length === 1 && init?.type === "CallExpression" && property(init.callee) === "dirname"
        && init.arguments.length === 1 && init.arguments[0].name === pathName && pathImport.length === 1
        && pathImport[0].init?.callee?.name === "require" && ["path", "node:path"].includes(pathImport[0].init.arguments[0]?.value);
      if (isParentDirectory) check(index.bindings.get(arg.name)?.length === 1 && index.bindings.get(init.callee.object.name)?.length === 1
        && index.parents.get(defs[0])?.kind === "const" && index.parents.get(pathImport[0])?.kind === "const", "AUTH_PATH_BINDING_UNSUPPORTED");
    }
    const expected = ["lstatSync", "realpathSync", "openSync"].includes(operation) ? pathName : fdName;
    check((arg?.type === "Identifier" && arg.name === expected) || isParentDirectory, "AUTH_EXTRA_FILE_INPUT");
  }
  const settingsReads = [];
  for (const call of fsCalls.get(settings)) { check(property(call.callee) === "readFileSync", "AUTH_SETTINGS_FILE_UNSUPPORTED"); settingsReads.push(call); }
  check(settingsReads.length === 1 && settingsReads[0].arguments[0]?.type === "Literal"
    && typeof settingsReads[0].arguments[0].value === "string" && settingsReads[0].arguments[0].value.startsWith("/"), "AUTH_SETTINGS_FILE_UNSUPPORTED");
  return { builtinModules: [...modules].sort(), helperPaths: [helperPath],
    privateInputPaths: [...new Set([constants[0].init.value, settingsReads[0].arguments[0].value])],
    factoryUsesDefaultPath: true, externalPackageCount: 0, unresolvedModuleCount: 0 };
}
