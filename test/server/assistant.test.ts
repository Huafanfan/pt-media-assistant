import { randomUUID } from 'node:crypto';
import { describe,it,expect,vi } from 'vitest';
import { AssistantService } from '../../src/server/ai/orchestrator.js';
import { ConversationStore } from '../../src/server/ai/conversation-store.js';
import { ToolRunner } from '../../src/server/ai/tools.js';
import { FetchCompatibleProvider, AiSdkCompatibleProvider, type CompatibleChatProvider, type AssistantMessage } from '../../src/server/ai/provider.js';
import { rankReleases, availabilityForMediaSnapshot, filterCandidateForPreferences } from '../../src/server/ai/recommendation.js';
import { defaultAssistantPreferences, assistantPreferencesPatchSchema } from '../../src/shared/assistant.js';
import { loadConfig } from '../../src/server/config.js';
import { createApp } from '../../src/server/app.js';
import { sanitizeRelease } from '../../src/server/prowlarr.js';

const media={id:'1292267',title:'银河系漫游指南',originalTitle:"The Hitchhiker's Guide to the Galaxy",year:'2005',mediaType:'movie' as const,genres:['喜剧','科幻'],summary:'地球人跟随朋友乘飞船旅行。',sourceUrl:'https://movie.douban.com/subject/1292267/'};
const release=sanitizeRelease({title:'银河系漫游指南 2005 1080p',protocol:'torrent',size:8*1024**3,seeders:20,freeleech:true},'abcdefgh12345678');
const snapshot={itemId:media.id,query:media.title,status:'available' as const,checkedAt:new Date().toISOString(),snapshotId:randomUUID(),expiresAt:new Date(Date.now()+86400000).toISOString(),actionableUntil:new Date(Date.now()+86400000).toISOString(),total:1,releases:[release]};
function discovery() {return {searchMedia:vi.fn(async()=>({query:'',total:1,items:[media]})),getMedia:vi.fn(async()=>media),getMediaDetails:vi.fn(async()=>({itemId:media.id,actors:[],directors:[]})),getMediaReleases:vi.fn(async()=>snapshot)};}
function tool(name:string,args:unknown):AssistantMessage{return {role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]};}
function provider(messages:AssistantMessage[]):CompatibleChatProvider {return {chat:vi.fn(async()=>({message:messages.shift()??{role:'assistant',content:'{}'},usage:{promptTokens:10,completionTokens:10,totalTokens:20}}))};}
function scripted() {return provider([tool('resolve_media',{query:media.title,preferences:{includeGenres:['科幻'],excludeGenres:['恐怖'],resolution:'1080p',maxSizeBytes:15*1024**3}}),tool('check_pt_availability',{mediaId:media.id,mediaType:'movie'}),{role:'assistant',content:JSON.stringify({recommendations:[{mediaId:media.id,reason:'科幻冒险题材，带有喜剧元素。'}]})}]);}

describe('AI turns and boundaries',()=>{
 it('does not inject defaults into a preference patch',()=>{expect(assistantPreferencesPatchSchema.parse({mood:'轻松'})).toEqual({mood:'轻松'});});
 it('resolves, verifies, ranks and remembers with deduplication',async()=>{
  const p=scripted(),d=discovery(),s=new AssistantService(p,d),request={clientTurnId:randomUUID(),message:'轻松科幻，不要恐怖，1080p 15GB以内'};
  const result=await s.run('owner',request);
  expect(result.recommendations[0]?.availability).toBe('available');
  expect(result.recommendations[0]?.rankedReleases[0]?.id).toBe(release.id);
  expect(result.turnId).not.toBe(result.clientTurnId);
  expect(result.preferences.resolution).toBe('1080p');
  expect(await s.run('owner',request)).toEqual(result);
  expect(p.chat).toHaveBeenCalledTimes(3);
  const next=await s.run('owner',{conversationId:result.conversationId,clientTurnId:randomUUID(),message:'继续'});
  expect(next.preferences.resolution).toBe('1080p');
 });
 it('rejects forged IDs and tools before reaching services',async()=>{
  const store=new ConversationStore(),c=store.start('owner',randomUUID()).turn.conversation,d=discovery();
  const r=new ToolRunner(d,c,new AbortController().signal);
  await expect(r.execute('grab',{confirm:true})).rejects.toThrow();
  await expect(r.execute('check_pt_availability',{mediaId:'9999',mediaType:'movie'})).rejects.toThrow();
  expect(d.getMediaReleases).not.toHaveBeenCalled();
 });
 it('distinguishes upstream error from empty snapshot',async()=>{
  const d=discovery();d.getMediaReleases.mockRejectedValue(new Error('private upstream'));
  const result=await new AssistantService(scripted(),d).run('owner',{clientTurnId:randomUUID(),message:'科幻'});
  expect(result.recommendations[0]?.availability).toBe('error');
  expect(JSON.stringify(result)).not.toContain('private upstream');
 });
 it('filters onlyAvailable and empty results without false positives',async()=>{
  const d=discovery();d.getMediaReleases.mockResolvedValue({...snapshot,total:0,releases:[]});
  const p=provider([tool('resolve_media',{query:media.title,preferences:{onlyAvailable:true}}),tool('check_pt_availability',{mediaId:media.id,mediaType:'movie'}),{role:'assistant',content:JSON.stringify({recommendations:[{mediaId:media.id}]})}]);
  expect((await new AssistantService(p,d).run('o',{clientTurnId:randomUUID(),message:'只要有资源'})).recommendations).toEqual([]);
 });
 it('does not accept invented final resource facts or evidence',async()=>{
  const p=provider([tool('resolve_media',{query:media.title}),{role:'assistant',content:JSON.stringify({text:'有9999个免费资源',recommendations:[{mediaId:media.id,reason:'含中文字幕和免费资源',evidenceIds:['forged']},{mediaId:'999'}]})}]);
  const result=await new AssistantService(p,discovery()).run('o',{clientTurnId:randomUUID(),message:'科幻'});
  expect(result.recommendations).toHaveLength(1);expect(JSON.stringify(result)).not.toContain('forged');expect(JSON.stringify(result)).not.toContain('9999');expect(result.recommendations[0]?.reason).not.toContain('中文字幕');
 });
 it('falls back to deterministic reasons for English release and numeric claims',async()=>{
  const p=provider([tool('resolve_media',{query:media.title}),{role:'assistant',content:JSON.stringify({recommendations:[{mediaId:media.id,reason:'A torrent has 12 seeders, free subtitles, and HDR.'}]})}]);
  const result=await new AssistantService(p,discovery()).run('o',{clientTurnId:randomUUID(),message:'科幻'});
  expect(result.recommendations).toHaveLength(1);
  expect(result.recommendations[0]?.reason).not.toMatch(/torrent|seeders|字幕|HDR/iu);
 });
 it('automatically checks selected candidates when the model omits the PT tool',async()=>{
  const d=discovery();
  const p=provider([tool('resolve_media',{query:media.title}),{role:'assistant',content:JSON.stringify({recommendations:[{mediaId:media.id,reason:'轻松的科幻喜剧。'}]})}]);
  const result=await new AssistantService(p,d).run('o',{clientTurnId:randomUUID(),message:'科幻'});
  expect(d.getMediaReleases).toHaveBeenCalledTimes(1);
  expect(result.recommendations[0]?.availability).toBe('available');
 });
 it('overlaps automatic PT checks and preserves recommendation order',async()=>{
  const second={...media,id:'1292268',title:'另一部科幻'};
  const waiting=new Map<string,()=>void>();
  const d={...discovery(),
   searchMedia:vi.fn(async()=>({query:'',total:2,items:[media,second]})),
   getMedia:vi.fn(async (_type:string,id:string)=>id===second.id?second:media),
   getMediaReleases:vi.fn(async (_type:string,id:string)=>{
    await new Promise<void>(resolve=>waiting.set(id,resolve));
    return {...snapshot,itemId:id,releases:[{...release,title:`${id===second.id?second.title:media.title} 2005 1080p`}]};
   })};
  const p=provider([tool('resolve_media',{query:media.title}),{role:'assistant',content:JSON.stringify({recommendations:[{mediaId:media.id},{mediaId:second.id}]})}]);
  const s=new AssistantService(p,d);
  try {
   const pending=s.run('o',{clientTurnId:randomUUID(),message:'科幻'});
   await vi.waitFor(()=>expect(waiting.size).toBe(2));
   waiting.get(second.id)!();
   waiting.get(media.id)!();
   const result=await pending;
   expect(result.recommendations.map(card=>card.mediaId)).toEqual([media.id,second.id]);
   expect(result.recommendations.every(card=>card.availability==='available')).toBe(true);
   expect(result.usage.modelRequests).toBe(2);
  } finally {s.close();}
 });
 it('uses a no-tool final pass when the transcript fits alone but not with tool schemas',async()=>{
  const longSummary='这是一段来自服务端的公开作品简介，用于验证多候选上下文边界。'.repeat(50).slice(0,220);
  const longOriginalTitle='The International Candidate Original Title '.repeat(20).slice(0,240);
  const candidates=Array.from({length:6},(_,index)=>({...media,id:String(1292268+index),title:`候选喜剧${index+1}`,originalTitle:longOriginalTitle,summary:longSummary}));
  const d={...discovery(),
   searchMedia:vi.fn(async(query:string)=>{const index=Math.max(0,Number(query.replace('候选喜剧',''))-1);const items=candidates.slice(index,index+2);return {query,total:items.length,items};}),
   getMedia:vi.fn(async(_type:string,id:string)=>candidates.find(candidate=>candidate.id===id)??candidates[0]!),
   getMediaReleases:vi.fn(async(_type:string,id:string)=>({...snapshot,itemId:id,total:0,releases:[]}))};
  const firstToolCalls=candidates.filter((_,index)=>index%2===0).map((candidate,index)=>({id:randomUUID(),type:'function' as const,function:{name:'resolve_media',arguments:JSON.stringify({query:candidate.title,...(index===0?{preferences:{mood:'轻松'}}:{})})}}));
  const responses:AssistantMessage[]=[
   {role:'assistant',content:null,tool_calls:firstToolCalls},
   {role:'assistant',content:JSON.stringify({recommendations:candidates.slice(0,3).map(candidate=>({mediaId:candidate.id,reason:'轻松的喜剧题材。'}))})}
  ];
  const calls:Array<{messages:AssistantMessage[];tools:unknown[]}> = [];
  const p:CompatibleChatProvider={chat:vi.fn(async(messages,tools)=>{calls.push({messages:structuredClone(messages),tools:structuredClone(tools)});return {message:responses.shift()!,usage:{promptTokens:10,completionTokens:10,totalTokens:20}};})};
  const result=await new AssistantService(p,d).run('o',{clientTurnId:randomUUID(),message:'轻松的喜剧电影'});
  expect(calls).toHaveLength(2);
  expect(calls[1]?.tools).toEqual([]);
  const finalMessages=calls[1]?.messages??[];
  expect(Buffer.byteLength(JSON.stringify(finalMessages),'utf8')).toBeLessThan(12_000);
  expect(Buffer.byteLength(JSON.stringify(finalMessages)+JSON.stringify(calls[0]?.tools??[]),'utf8')).toBeGreaterThan(12_000);
  expect(result.recommendations).toHaveLength(3);
  expect(result.recommendations[0]?.summary).toBe(longSummary);
  expect(result.warnings.some(w=>w.code==='AI_BUDGET_EXCEEDED'||w.code==='AI_INVALID_OUTPUT')).toBe(false);
 });
 it('deduplicates failed PT checks within one turn',async()=>{
  const d=discovery();
  const store=new ConversationStore(),c=store.start('o',randomUUID()).turn.conversation;
  const r=new ToolRunner(d,c,new AbortController().signal);
  await r.execute('resolve_media',{query:media.title});
  d.getMediaReleases.mockRejectedValue(new Error('private upstream'));
  const first=await r.execute('check_pt_availability',{mediaId:media.id,mediaType:'movie'});
  const second=await r.execute('check_pt_availability',{mediaId:media.id,mediaType:'movie'});
  expect(d.getMediaReleases).toHaveBeenCalledTimes(1);
  expect(first).toMatchObject({availability:'error'});
  expect(second).toMatchObject({availability:'error'});
 });
 it('does not publish a late PT snapshot after cancellation',async()=>{
  const d=discovery();
  let resolveSnapshot!: (value: typeof snapshot) => void;
  d.getMediaReleases.mockImplementation(() => new Promise((resolve) => { resolveSnapshot=resolve; }));
  const store=new ConversationStore(),c=store.start('o',randomUUID()).turn.conversation;
  const controller=new AbortController(),r=new ToolRunner(d,c,controller.signal);
  await r.execute('resolve_media',{query:media.title});
  const pending=r.execute('check_pt_availability',{mediaId:media.id,mediaType:'movie'});
  controller.abort();
  resolveSnapshot(snapshot);
  await expect(pending).rejects.toThrow();
  expect(c.candidates.get(`movie:${media.id}`)?.snapshot).toBeUndefined();
 });
 it('limits invalid output repair and returns safe warnings',async()=>{
  const p=provider([{role:'assistant',content:'not json'},{role:'assistant',content:'still invalid'}]);
  const r=await new AssistantService(p,discovery()).run('o',{clientTurnId:randomUUID(),message:'test'});
  expect(p.chat).toHaveBeenCalledTimes(2);expect(r.warnings.some(x=>x.code==='AI_INVALID_OUTPUT')).toBe(true);
 });
 it('prevents cross-session access, overlaps, and enforces explicit cancellation',async()=>{
  let resolve!: (value:any)=>void;
  const p:CompatibleChatProvider={chat:vi.fn(()=>new Promise(r=>{resolve=r;}))};
  const s=new AssistantService(p,discovery()),id=randomUUID();
  const promise=s.run('one',{clientTurnId:id,message:'test'});
  const rejected=expect(promise).rejects.toMatchObject({code:'AI_CANCELLED'});
  expect(()=>s.cancel('two',id)).toThrow();
  await expect(s.run('one',{clientTurnId:id,message:'test'})).rejects.toMatchObject({code:'TURN_IN_PROGRESS'});
  s.cancel('one',id);await rejected;
  resolve({message:{role:'assistant',content:'{}'},usage:{promptTokens:0,completionTokens:0,totalTokens:0}});
 });
 it('times out a non-cooperative provider and limits request rate',async()=>{
  const s=new AssistantService({chat:()=>new Promise(()=>{})},discovery(),{timeoutMs:5});
  await expect(s.run('o',{clientTurnId:randomUUID(),message:'test'})).rejects.toMatchObject({code:'AI_TIMEOUT'});
  const store=new ConversationStore();for(let i=0;i<3;i++){const t=store.start('o',randomUUID()).turn;t.conversation.active=undefined;}
  expect(()=>store.start('o',randomUUID())).toThrow();
 });
 it('enforces tool/search budget without a batch bypass',async()=>{
  const store=new ConversationStore(),c=store.start('o',randomUUID()).turn.conversation,d=discovery();
  const r=new ToolRunner(d,c,new AbortController().signal);
  for(let i=0;i<5;i++) await r.execute('resolve_media',{query:media.title});
  await expect(r.execute('resolve_media',{query:'sixth'})).rejects.toMatchObject({code:'AI_BUDGET_EXCEEDED'});
  expect(d.searchMedia).toHaveBeenCalledTimes(5);
 });
});
describe('deterministic recommendation rules',()=>{
 const prefs=defaultAssistantPreferences();
 it.each([
  ['wrong year',{...release,title:'银河系漫游指南 2006 1080p'}],
  ['partial English title',{...release,title:'The Galaxy 2005 1080p'}],
  ['wrong movie',{...release,title:'Other Movie 2005 1080p'}],
  ['missing year',{...release,title:'银河系漫游指南 1080p'}],
 ])('does not confirm %s',(_,r)=>{expect(availabilityForMediaSnapshot(media,{...snapshot,releases:[r]},prefs)).not.toBe('available');});
 it('keeps ambiguous TV seasons possible',()=>{expect(availabilityForMediaSnapshot({...media,mediaType:'tv'},{...snapshot,releases:[release]},prefs)).toBe('possible');});
 it('distinguishes hard freeleech from soft preference and respects unknown data',()=>{
  const unknown={...release,freeleech:false,freeleechState:'unknown' as const,evidence:{...release.evidence!,size:'unknown' as const}};
  expect(rankReleases(media,{...snapshot,releases:[unknown]},{...prefs,freeleechRequired:true})).toHaveLength(0);
  expect(rankReleases(media,{...snapshot,releases:[unknown]},{...prefs,maxSizeBytes:15*1024**3})).toHaveLength(0);
  expect(rankReleases(media,{...snapshot,releases:[unknown]},{...prefs,freeleechPreferred:true})).toHaveLength(1);
 });
 it('excludes seen, missing hard metadata, excluded genre and wrong size',()=>{
  expect(filterCandidateForPreferences(media,{...prefs,seenMediaIds:[media.id]})).toBe(false);
  expect(filterCandidateForPreferences({...media,genres:[]},{...prefs,excludeGenres:['恐怖']})).toBe(false);
  expect(filterCandidateForPreferences({...media,year:undefined},{...prefs,yearFrom:2000})).toBe(false);
  expect(filterCandidateForPreferences({...media,genres:['恐怖']},{...prefs,excludeGenres:['恐怖']})).toBe(false);
  expect(rankReleases(media,snapshot,{...prefs,maxSizeBytes:1})).toHaveLength(0);
 });
});
describe('AI HTTP and provider failures',()=>{
 it('requires auth/origin/CSRF and keeps disabled AI independent of liveness',async()=>{
  const app=await createApp({config:loadConfig({PT_MEDIA_TRUST_LAN:'1',TRANS_STATION_BASE_URL:'not-a-url'}),staticRoot:'/missing'});
  expect((await app.inject({method:'GET',url:'/api/live'})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:'/api/assistant/turns',payload:{}})).statusCode).toBe(403);
  const session=await app.inject({method:'GET',url:'/api/session',remoteAddress:'127.0.0.1',headers:{host:'localhost:4178'}});
  const headers={host:'localhost:4178',origin:'http://localhost:4178',cookie:String(session.headers['set-cookie']).split(';')[0]!,'x-csrf-token':session.json().csrfToken};
  expect((await app.inject({method:'POST',url:'/api/assistant/turns',headers,payload:{clientTurnId:randomUUID(),message:'hello'}})).json().code).toBe('AI_DISABLED');
  await app.close();
 });
 it('serves authenticated AI turns, isolates owners and preserves CSRF on cancellation',async()=>{
  const d=discovery(),p=scripted();
  const app=await createApp({config:{...loadConfig({}),aiEnabled:true},aiProvider:p,discovery:{...d,list:vi.fn(),getReleases:vi.fn()},staticRoot:'/missing'});
  const paired=await app.inject({method:'GET',url:'/api/session',remoteAddress:'127.0.0.1',headers:{host:'localhost:4178'}});
  const headers={host:'localhost:4178',origin:'http://localhost:4178',cookie:String(paired.headers['set-cookie']).split(';')[0]!,'x-csrf-token':paired.json().csrfToken};
  const id=randomUUID();const result=await app.inject({method:'POST',url:'/api/assistant/turns',headers,payload:{clientTurnId:id,message:'科幻'}});
  expect(result.statusCode).toBe(200);expect(result.json().recommendations).toHaveLength(1);
  const bad=await app.inject({method:'POST',url:`/api/assistant/turns/${id}/cancel`,headers:{...headers,'x-csrf-token':'bad'}});expect(bad.statusCode).toBe(403);
  const another=await app.inject({method:'GET',url:'/api/session',remoteAddress:'127.0.0.1',headers:{host:'localhost:4178'}});
  const otherHeaders={...headers,cookie:String(another.headers['set-cookie']).split(';')[0]!,'x-csrf-token':another.json().csrfToken};
  expect((await app.inject({method:'DELETE',url:`/api/assistant/conversations/${result.json().conversationId}`,headers:otherHeaders})).statusCode).toBe(404);
  expect((await app.inject({method:'DELETE',url:`/api/assistant/conversations/${result.json().conversationId}`,headers})).statusCode).toBe(200);
  await app.close();
 });
 it('encodes system instructions through AI SDK and preserves the exact gateway base path',async()=>{
  const calls:Array<{url:string,body:any}>=[];
  const p=new AiSdkCompatibleProvider({baseUrl:'https://example.invalid/custom',apiKey:'fixture',model:'gpt-5.6-luna',fetchImpl:async(url,init)=>{
    calls.push({url:String(url),body:JSON.parse(String(init?.body))});
    return Response.json({id:'fixture',created:1,model:'fixture',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:'{}'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}});
  }});
  const result=await p.chat([{role:'system',content:'test instruction'},{role:'user',content:'test'}],[]);
  expect(calls[0]?.url).toBe('https://example.invalid/custom/chat/completions');
  expect(calls[0]?.body.messages[0].content).toBe('test instruction');expect(calls[0]?.body.stream).toBe(false);expect(calls[0]?.body.temperature).toBe(0.2);expect(result.usage.totalTokens).toBe(3);
 });
 it.each([
  ['AI SDK', AiSdkCompatibleProvider],
  ['fetch', FetchCompatibleProvider],
 ])('sets reasoning_effort=none for the default Luna model through %s',async(_,Provider)=>{
  const calls:Array<{body:any}> = [];
 const p=new Provider({baseUrl:'https://example.invalid/v1',model:'gpt-5.6-luna',fetchImpl:async(url,init)=>{
   calls.push({body:JSON.parse(String(init?.body))});
   return Response.json({id:'fixture',created:1,model:'fixture',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:'{}'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}});
  }});
  const tools=[{type:'function' as const,function:{name:'fixture',description:'fixture',parameters:{type:'object'}}}];
  await p.chat([{role:'user',content:'test'}],tools);
  await p.chat([{role:'user',content:'test'}],[]);
  expect(calls.map(call=>call.body.model)).toEqual(['gpt-5.6-luna','gpt-5.6-luna']);
  expect(calls.map(call=>call.body.reasoning_effort)).toEqual(['none','none']);
 });
 it.each([
  ['AI SDK', AiSdkCompatibleProvider],
  ['fetch', FetchCompatibleProvider],
 ])('does not set Luna reasoning_effort for a custom model through %s',async(_,Provider)=>{
  const calls:Array<{body:any}> = [];
 const p=new Provider({baseUrl:'https://example.invalid/v1',model:'custom-model',fetchImpl:async(url,init)=>{
   calls.push({body:JSON.parse(String(init?.body))});
   return Response.json({id:'fixture',created:1,model:'custom-model',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:'{}'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}});
  }});
  const tools=[{type:'function' as const,function:{name:'fixture',description:'fixture',parameters:{type:'object'}}}];
  await p.chat([{role:'user',content:'test'}],tools);
  await p.chat([{role:'user',content:'test'}],[]);
  expect(calls.map(call=>call.body.model)).toEqual(['custom-model','custom-model']);
  expect(calls[0]?.body).not.toHaveProperty('reasoning_effort');
  expect(calls[1]?.body).not.toHaveProperty('reasoning_effort');
 });
 it('redacts provider body errors and honors rate limit without retries',async()=>{
  const fetchImpl=vi.fn(async()=>new Response('private-token',{status:429,headers:{'Retry-After':'12'}}));
  const p=new FetchCompatibleProvider({baseUrl:'https://example.invalid/v1',fetchImpl});
  await expect(p.chat([{role:'user',content:'test'}],[])).rejects.toMatchObject({code:'AI_RATE_LIMITED',retryAfterSeconds:12});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
 });
});
