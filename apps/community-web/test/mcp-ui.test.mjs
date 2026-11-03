import assert from "node:assert/strict";
import {after,afterEach,test} from "node:test";
import React from "react";
import {JSDOM} from "jsdom";
import {createServer} from "vite";
import {act,cleanup,render,fireEvent} from "@testing-library/react";

const dom=new JSDOM("<!doctype html><html><body></body></html>",{url:"http://localhost/"});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const originalFetch=globalThis.fetch;
const loader=await createServer({configFile:false,esbuild:{jsx:"automatic"},server:{middlewareMode:true,watch:null,hmr:false},optimizeDeps:{noDiscovery:true,entries:[],include:[]},appType:"custom"});
const{McpManager}=await loader.ssrLoadModule("/src/mcp/McpManager.tsx");
const{McpApproval}=await loader.ssrLoadModule("/src/mcp/Approval.tsx");
afterEach(()=>{cleanup();globalThis.fetch=originalFetch;});
after(async()=>{await loader.close();dom.window.close();});
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});
test("failed management loads never claim that existing grants or calls are absent",async()=>{
  globalThis.fetch=async path=>String(path).endsWith("/capability")?json({enabled:true}):json({error:"synthetic unavailable"},503);
  let view;await act(async()=>{view=render(React.createElement(McpManager,{onBack(){}}));});
  assert.match(view.container.textContent,/记录读取失败/);
  assert.equal(view.container.textContent.includes("尚未授予任何访问权限"),false);
  assert.equal(view.container.textContent.includes("当前没有调用记录"),false);
});
test("initial capability failure exposes a usable retry",async()=>{
  let failed=true;
  globalThis.fetch=async()=>failed?json({error:"unavailable"},503):json({enabled:false});
  let view;await act(async()=>{view=render(React.createElement(McpManager,{onBack(){}}));});
  assert.match(view.container.textContent,/记录读取失败/);assert.equal(view.container.textContent.includes("MCP 尚未启用"),false);
  failed=false;await act(async()=>{fireEvent.click(view.getByText("重新读取"));});assert.match(view.container.textContent,/MCP 尚未启用/);
});
test("query review is text-only, shows local trust domain and posts only an explicit decision",async()=>{
  const id=crypto.randomUUID(),requests=[];
  const sql="SELECT '<img src=https://unapproved.example/canary>' AS text";
  globalThis.fetch=async(path,init)=>{requests.push({path:String(path),init});return init?.method==="POST"?json({ok:true}):json({id,commitment:"a".repeat(64),query:{sql,parameters:[{kind:"string",value:"synthetic-sensitive"}],maxRows:10,workspaceId:crypto.randomUUID(),sourceId:crypto.randomUUID()},recipient:{mode:"local_domain",clientId:"fixture"},grant:{}});};
  let view;await act(async()=>{view=render(React.createElement(McpApproval,{id,kind:"invocations",done(){}}));});
  assert.equal(requests.length,1);assert.equal(view.container.querySelector("img"),null);
  assert.ok(view.container.textContent.includes(sql));assert.match(view.container.textContent,/同一操作系统用户信任域/);
  await act(async()=>{fireEvent.click(view.getByText("批准查询并允许返回结果"));});
  assert.equal(requests.length,2);assert.deepEqual(JSON.parse(requests[1].init.body),{accept:true,commitment:"a".repeat(64)});
  assert.match(view.container.textContent,/已批准/);
});
