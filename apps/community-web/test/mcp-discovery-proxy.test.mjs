import assert from "node:assert/strict";
import {createServer as httpServer} from "node:http";
import {test} from "node:test";
import {fileURLToPath} from "node:url";
import {createServer as viteServer} from "vite";
test("public frontend origin forwards OAuth issuer discovery to the configured API",async t=>{
  const upstream=httpServer((req,res)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({issuer:"http://127.0.0.1:5173/api/auth",path:req.url}));});
  await new Promise(r=>upstream.listen(0,"127.0.0.1",r));t.after(()=>new Promise(r=>upstream.close(r)));
  const prior=process.env.API_PROXY_TARGET;process.env.API_PROXY_TARGET=`http://127.0.0.1:${upstream.address().port}`;t.after(()=>{if(prior===undefined)delete process.env.API_PROXY_TARGET;else process.env.API_PROXY_TARGET=prior;});
  const dev=await viteServer({configFile:fileURLToPath(new URL("../vite.config.ts",import.meta.url)),envFile:false,server:{host:"127.0.0.1",port:0,hmr:false,watch:null},optimizeDeps:{noDiscovery:true,entries:[],include:[]}});t.after(()=>dev.close());await dev.listen();const address=dev.httpServer.address();assert.ok(address&&typeof address!=="string");
  for(const path of ["/.well-known/oauth-authorization-server/api/auth","/.well-known/openid-configuration/api/auth"]){const response=await fetch(`http://127.0.0.1:${address.port}${path}`);assert.equal(response.status,200);assert.deepEqual(await response.json(),{issuer:"http://127.0.0.1:5173/api/auth",path});}
});
