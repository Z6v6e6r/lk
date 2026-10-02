import ts from 'typescript';
import { proTrainingExclusionSource } from './eventPaymentSources.mjs';

// Function declarations are hoisted, but their const dependencies are not. Move
// the complete reviewed module before any booking step can call its predicates.
export function initializeProTrainingBeforeSteps(source) {
  const reviewed = proTrainingExclusionSource();
  const module = reviewed.slice(reviewed.indexOf('const PRO_TRAINING_DIRECTION_IDS =')).trimEnd();
  if (source.split(module).length !== 2) throw new Error('PRO initialization module drift');
  const parse = text => ts.createSourceFile('booking.js', text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const names = statement => ts.isFunctionDeclaration(statement) ? [statement.name?.text]
    : ts.isVariableStatement(statement) ? statement.declarationList.declarations.map(item => item.name.getText()) : [];
  const expectedNames = parse(module).statements.flatMap(names);
  const ast = parse(source);
  const start = source.indexOf(module);
  for (const name of expectedNames) {
    const declarations = ast.statements.filter(statement => names(statement).includes(name));
    if (declarations.length !== 1 || declarations[0].getStart(ast) < start
      || declarations[0].getEnd() > start + module.length) {
      throw new Error('PRO initialization declaration drift: ' + name);
    }
  }
  // Keep a possible directive prologue (e.g. "use strict") in force.
  let insertion = 0;
  for (const statement of ast.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    insertion = statement.getEnd();
  }
  const first = ast.statements.find(statement => statement.getStart(ast) >= insertion);
  if (first?.getStart(ast) === start) return source;
  const remainder = source.slice(0, start) + source.slice(start + module.length);
  const patched = remainder.slice(0, insertion) + '\n' + module + '\n' + remainder.slice(insertion);
  new Function('msg', 'node', 'global', patched);
  return patched;
}
