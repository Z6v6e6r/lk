import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
/** Operational preimages/candidates must never become repository material. No writes. */
export function validatePrivatePreparationPaths(input, output) {
  const root=fs.realpathSync(fileURLToPath(new URL('../..',import.meta.url)));
  if (![input,output].every(p=>typeof p==='string' && path.isAbsolute(p) && p===path.resolve(p)) || input===output) throw new Error('PREPARATION_PATH_INVALID');
  for (const target of [input,output]) {
    const parent=path.dirname(target), stat=fs.lstatSync(parent);
    if (fs.realpathSync(parent)!==parent || !stat.isDirectory() || (stat.mode & 0o777)!==0o700 || target===root || target.startsWith(root+path.sep)) throw new Error('PREPARATION_PRIVATE_EXTERNAL_WORKSPACE_REQUIRED');
  }
  const stat=fs.lstatSync(input);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || (stat.mode & 0o777)!==0o600) throw new Error('PREPARATION_PRIVATE_SOURCE_REQUIRED');
  try { fs.lstatSync(output); } catch (error) { if(error.code==='ENOENT') return; throw error; }
  throw new Error('PREPARATION_NEW_OUTPUT_REQUIRED');
}
