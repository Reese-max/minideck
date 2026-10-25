import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {resolve,relative,sep} from 'node:path';
assert.ok(process.env.RUNNER_TEMP?.startsWith('/'));
const parent=resolve(process.env.RUNNER_TEMP),path=resolve(parent,'minideck-pr44-stored-qa'),rel=relative(parent,path);
assert.equal(rel,'minideck-pr44-stored-qa');assert.ok(rel!=='..'&&!rel.startsWith('..'+sep));
rmSync(path,{recursive:true,force:true});
