/** Explicit paid smoke: PT_MEDIA_AI_SMOKE=1 node --import tsx scripts/ai-smoke.ts.
 * Uses the configured model and synthetic metadata/releases only. Never reaches PT/grab.
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/server/config.js';
import { providerFromConfig } from '../src/server/ai/provider.js';
import { AssistantService } from '../src/server/ai/orchestrator.js';
import { sanitizeRelease } from '../src/server/prowlarr.js';
if(process.env.PT_MEDIA_AI_SMOKE!=='1') throw new Error('Set PT_MEDIA_AI_SMOKE=1 to authorize paid model calls');
const config=loadConfig(),provider=providerFromConfig(config);
if(!provider) throw new Error('Model configuration missing');
const chat=provider.chat.bind(provider);
provider.chat=async(...args)=>{try{return await chat(...args);}catch(e){const x=e as {code?:string,cause?:{name?:string,message?:string,statusCode?:number}};console.log(JSON.stringify({providerError:x.code,cause:x.cause?.name,status:x.cause?.statusCode}));throw e;}};
const media={id:'1292267',title:'银河系漫游指南',originalTitle:"The Hitchhiker's Guide to the Galaxy",year:'2005',mediaType:'movie' as const,genres:['科幻','喜剧','冒险'],summary:'地球人被带上太空旅行，带有荒诞喜剧元素。',sourceUrl:''};
const release=sanitizeRelease({title:'银河系漫游指南 2005 1080p',protocol:'torrent',size:8*1024**3,seeders:10,freeleech:true},'smoke_release_001');
let queries=0;
const service=new AssistantService(provider,{
 searchMedia:async(query)=>({query,total:1,items:query.includes('银河')||/hitchhiker/i.test(query)?[media]:[]}),
 getMedia:async()=>media,getMediaDetails:async()=>({itemId:media.id,actors:[],directors:[]}),
 getMediaReleases:async(_type,id,_limit,options)=>{options?.beforeSearch?.();queries++;return {itemId:id,query:media.title,status:'available',checkedAt:new Date().toISOString(),snapshotId:randomUUID(),expiresAt:new Date(Date.now()+86400000).toISOString(),actionableUntil:new Date(Date.now()+86400000).toISOString(),total:1,releases:[release]};}
},{timeoutMs:120_000});
try {
 const first=await service.run('smoke',{clientTurnId:randomUUID(),message:'我想看轻松的科幻，不要恐怖，1080p、15GB以内。朋友提到银河系漫游指南，请核实这部的片源并推荐。'});
 console.log(JSON.stringify({phase:'recommend',cards:first.recommendations.map(c=>({title:c.title,availability:c.availability,ranked:c.rankedReleases.length})),preferences:first.preferences,warnings:first.warnings.map(w=>w.code),usage:first.usage,fixturePtQueries:queries}));
 if(first.recommendations[0]?.availability!=='available'||first.preferences.resolution!=='1080p') throw new Error('Recommendation smoke did not meet expectations');
 const second=await service.run('smoke',{conversationId:first.conversationId,clientTurnId:randomUUID(),message:'这部我看过了，请把它排除，其他偏好保持。'});
 console.log(JSON.stringify({phase:'followup',cards:second.recommendations.length,excluded:second.preferences.seenMediaIds.length,resolution:second.preferences.resolution,usage:second.usage}));
 if(second.preferences.seenMediaIds.length===0||second.recommendations.some(c=>c.mediaId===media.id)||second.preferences.resolution!=='1080p') throw new Error('Followup smoke did not meet expectations');
} finally {service.close();}
