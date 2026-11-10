import {isDeepStrictEqual} from 'node:util';

/** Ignore only validated top-level editor positions, never runtime fields or nested wiring. */
export function sameRuntimeNode(actual,expected) {
  const runtime=node=>{
    if(!node || typeof node!=='object' || Array.isArray(node)) return null;
    for(const key of ['x','y']) if(Object.hasOwn(node,key) && !Number.isFinite(node[key])) return null;
    const copy={...node};delete copy.x;delete copy.y;return copy;
  };
  const left=runtime(actual),right=runtime(expected);
  return left!==null && right!==null && isDeepStrictEqual(left,right);
}
