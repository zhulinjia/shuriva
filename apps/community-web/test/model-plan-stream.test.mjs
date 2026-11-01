import assert from "node:assert/strict";
import {test} from "node:test";
import {createUIMessageStream,createUIMessageStreamResponse} from "ai";
import {receiveModelPlan} from "../src/models/model-plan-stream.ts";
import {ApiError} from "../src/api.ts";

function response(chunks){return createUIMessageStreamResponse({stream:createUIMessageStream({execute:({writer})=>{for(const chunk of chunks)writer.write(chunk);}})});}
const start={type:"start"},finish={type:"finish"};
test("SDK stream delivers observed progress before a complete terminal plan without retrying",async()=>{
  const original=globalThis.fetch;let calls=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const progress=[];
  globalThis.fetch=async(_url,init)=>{
    calls++;assert.equal(new Headers(init.headers).get("accept"),"text/event-stream");
    assert.deepEqual(JSON.parse(init.body),{question:"虚构问题"});
    return createUIMessageStreamResponse({stream:createUIMessageStream({execute:async({writer})=>{
      writer.write(start);writer.write({type:"data-progress",data:{stage:"awaiting_model"},transient:true});await gate;
      writer.write({type:"data-plan",data:{plan:{kind:"clarification",question:"补充信息"}}});writer.write(finish);
    }})});
  };
  try{
    const task=receiveModelPlan("/plan",{question:"虚构问题"},new AbortController().signal,stage=>{progress.push(stage);release();});
    assert.deepEqual(await task,{plan:{kind:"clarification",question:"补充信息"}});
    assert.deepEqual(progress,["awaiting_model"]);assert.equal(calls,1);
  }finally{release();globalThis.fetch=original;}
});

test("interrupted, failed and malformed streams cannot produce a successful plan",async()=>{
  const original=globalThis.fetch;
  try{
    for(const chunks of [
      [start,{type:"data-progress",data:{stage:"awaiting_model"}}],
      [start,{type:"data-plan",data:{plan:{kind:"query"}}}],
      [start,{type:"data-progress",data:{stage:"invented"}},finish],
    ]){
      globalThis.fetch=async()=>response(chunks);
      await assert.rejects(receiveModelPlan("/plan",{},new AbortController().signal,()=>{}));
    }
    globalThis.fetch=async()=>response([start,{type:"data-failure",data:{status:409,error:"STALE"}},finish]);
    await assert.rejects(receiveModelPlan("/plan",{},new AbortController().signal,()=>{}),error=>error instanceof ApiError&&error.status===409);
  }finally{globalThis.fetch=original;}
});

test("cancelling a stalled model stream settles and never resubmits",async()=>{
  const original=globalThis.fetch;let calls=0;
  let received;const progress=new Promise(resolve=>{received=resolve;});
  globalThis.fetch=async()=>{calls++;return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: {"type":"data-progress","data":{"stage":"awaiting_model"}}\n\n'));}}),{headers:{'content-type':'text/event-stream'}});};
  try{
    const controller=new AbortController();
    const pending=receiveModelPlan("/plan",{},controller.signal,()=>received());
    await progress;controller.abort();
    await assert.rejects(pending,/cancelled/);assert.equal(calls,1);
  }finally{globalThis.fetch=original;}
});
