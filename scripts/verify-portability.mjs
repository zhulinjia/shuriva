import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, rename } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { releaseFiles } from "./release-files.mjs";

const [directory] = process.argv.slice(2);
if (!directory || process.argv.length !== 3) throw Error("Explicit candidate directory required");
const root = resolve(directory);
const releaseCache = resolve(fileURLToPath(new URL("..", import.meta.url)), ".cache/releases");
if (
  dirname(root).toLowerCase() !== releaseCache.toLowerCase() ||
  !/^shuriva-community-[a-f0-9]{32}$/.test(basename(root)) ||
  basename(dirname(root)) !== "releases" ||
  basename(dirname(dirname(root))) !== ".cache"
)
  throw Error("Only newly built owned candidates may be relocated");
await releaseFiles(root);
const moved = `${root}-relocated-${randomUUID()}`;
await rename(root, moved);
try {
  await lstat(root);
  throw Error("Original candidate remains accessible");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const run = promisify(execFile);
await run(process.execPath, [join(moved, "tools/verify-release.mjs"), moved], {
  windowsHide: true,
});
// A separate Node process may resolve neither workspace nor build-cache code.
// Hooks cover ESM and require(), including the native optional package loader.
const loader = `
import {registerHooks} from 'node:module';
import {relative,isAbsolute,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=process.cwd();
registerHooks({resolve(specifier,context,next){const resolved=next(specifier,context);if(resolved.url.startsWith('file:')){const p=relative(root,fileURLToPath(resolved.url));if(p==='..'||p.startsWith('..\\\\')||p.startsWith('../')||isAbsolute(p))throw Error('Dependency resolved outside relocated package');}return resolved;}});
await import(pathToFileURL(join(root,'dist/src/app.js')).href);
for(const name of ['express','better-auth','@shuriva/core-contracts','parse5','@napi-rs/keyring','koffi']){const url=import.meta.resolve(name),p=fileURLToPath(url);const rel=relative(root,p);if(rel==='..'||rel.startsWith('..\\\\')||rel.startsWith('../')||isAbsolute(rel))throw Error('Direct dependency escaped package');await import(url);}
console.log('Relocated API imports and native optional dependencies loaded without workspace fallback');
const {default:express}=await import('express');
const {mountWebAssets}=await import(pathToFileURL(join(root,'dist/src/web-assets.js')).href);
const app=express(),server=app.listen(0,'127.0.0.1');
try {
await new Promise((yes,no)=>{server.once('listening',yes);server.once('error',no);});
const origin='http://127.0.0.1:'+server.address().port;
await mountWebAssets(app,join(root,'../web'),origin);
const response=await fetch(origin,{signal:AbortSignal.timeout(10000)});
if(response.status!==200)throw Error('Relocated web index failed');await response.arrayBuffer();
const {readdir}=await import('node:fs/promises');
for(const name of await readdir(join(root,'../web/assets'))){const result=await fetch(origin+'/assets/'+name,{signal:AbortSignal.timeout(10000)});if(result.status!==200)throw Error('Relocated web asset failed');await result.arrayBuffer();}
console.log('Relocated built index and all packaged web assets served successfully');
}finally{server.closeAllConnections();await new Promise((yes,no)=>server.close(error=>error?no(error):yes()));}
`;
const child = await run(process.execPath, ["--input-type=module", "--eval", loader], {
  cwd: join(moved, "platform"),
  env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
  windowsHide: true,
  timeout: 60000,
});
console.log(child.stdout.trim());
for (const flag of ["help", "version"])
  await run(join(moved, "connector.exe"), [flag], {
    cwd: moved,
    windowsHide: true,
    timeout: 15000,
  });
console.log(`Relocated release verified: ${moved}`);
