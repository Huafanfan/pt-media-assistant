/** Opt-in paid, fixed-data evaluation. No real PT or download calls. */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/server/config.js';
import { providerFromConfig } from '../src/server/ai/provider.js';
import { AssistantService } from '../src/server/ai/orchestrator.js';
import { sanitizeRelease } from '../src/server/prowlarr.js';
if(process.env.PT_MEDIA_AI_SMOKE!=='1') throw new Error('Set PT_MEDIA_AI_SMOKE=1 to authorize paid evaluation');
const provider=providerFromConfig(loadConfig());if(!provider)throw new Error('Missing model config');
const catalog=[
 ['101','银河系漫游指南','The Hitchhiker\'s Guide to the Galaxy','2005',['科幻','喜剧','冒险'],'荒诞的星际旅行。'],
 ['102','黑衣人','Men in Black','1997',['科幻','喜剧','动作'],'探员处理外星人在地球上的事务。'],
 ['103','机器人总动员','WALL-E','2008',['科幻','动画','爱情'],'机器人相遇并踏上太空之旅。'],
 ['104','盗梦空间','Inception','2010',['科幻','悬疑','动作'],'通过梦境执行任务的团队。'],
 ['105','星际穿越','Interstellar','2014',['科幻','剧情','冒险'],'宇航员跨越星际，为人类寻找未来。'],
 ['106','海蒂和爷爷','Heidi','2015',['剧情','家庭'],'女孩与爷爷生活在阿尔卑斯山区。'],
 ['107','飞屋环游记','Up','2009',['动画','冒险','喜剧'],'老人和男孩展开飞屋冒险。'],
 ['108','致命魔术','The Prestige','2006',['悬疑','剧情'],'两位魔术师之间的竞争。'],
 ['109','黑客帝国','The Matrix','1999',['科幻','动作'],'程序员发现现实世界背后的秘密。'],
 ['110','千与千寻','Spirited Away','2001',['动画','奇幻','冒险'],'女孩进入神秘世界并努力救回父母。'],
] as const;
const media=catalog.map(([id,title,originalTitle,year,genres,summary])=>({id,title,originalTitle,year,genres:[...genres],summary,mediaType:'movie' as const,sourceUrl:''}));
const cases=[
 {name:'轻松科幻',text:'周末想放松，推荐科幻喜剧，不要恐怖。候选范围是银河系漫游指南和黑衣人，请查片源。',ids:['101','102']},
 {name:'家庭动画',text:'一家人想看动画电影，从机器人总动员和飞屋环游记里选，请核实片源。',ids:['103','107']},
 {name:'悬疑',text:'想看有悬念的电影，朋友推荐致命魔术，查一下是否合适及片源。',ids:['108']},
 {name:'年代',text:'想看2000年以前的科幻动作片，从黑客帝国和黑衣人中推荐，并检查片源。',ids:['109','102']},
 {name:'烧脑科幻',text:'想看需要思考的科幻，候选星际穿越和盗梦空间，推荐并查资源。',ids:['105','104']},
 {name:'只要免费',text:'银河系漫游指南和黑衣人都可以，但只要免费资源且有做种，请推荐。',ids:['101']},
 {name:'软免费',text:'请推荐黑衣人，最好免费，但不免费也可以，查一下资源。',ids:['102']},
 {name:'只要可用',text:'只考虑海蒂和爷爷，而且只要有资源；没资源就不推荐。',ids:[]},
 {name:'大小限制',text:'推荐机器人总动员，我只要1080p且5GB以内，查片源。',ids:['103']},
 {name:'奇幻动画',text:'今晚想看奇幻动画，千与千寻合适吗？核实作品和片源后推荐。',ids:['110']},
];
function normalize(s:string){return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');}
const names=process.env.PT_MEDIA_AI_EVAL_CASES?.split(',').filter(Boolean);
const selected=names?cases.filter(c=>names.includes(c.name)):cases;
if(!selected.length) throw new Error('No evaluation cases selected');
const concurrency=process.env.PT_MEDIA_AI_EVAL_CONCURRENCY==='1'?1:2;
const results:Array<Record<string,unknown>>=[];
for(let start=0;start<selected.length;start+=concurrency){
 await Promise.all(selected.slice(start,start+concurrency).map(async(c)=>{
  let checks=0;const began=Date.now();
  const service=new AssistantService(provider!,{
   searchMedia:async query=>({query,total:media.length,items:media.filter(m=>[m.title,m.originalTitle].some(title=>normalize(query).includes(normalize(title))||normalize(title).includes(normalize(query))))}),
   getMedia:async(_type,id)=>{const found=media.find(m=>m.id===id);if(!found)throw new Error('unknown fixture');return found;},
   getMediaDetails:async(_type,id)=>({itemId:id,actors:[],directors:[]}),
   getMediaReleases:async(_type,id,_limit,options)=>{options?.beforeSearch?.();checks++;const m=media.find(x=>x.id===id)!;const releases=id==='106'?[]:[sanitizeRelease({title:`${m.title} ${m.year} 1080p`,protocol:'torrent',size:(id==='103'?4:8)*1024**3,seeders:20,freeleech:id!=='102'},`eval_release_${id}`)];return {itemId:id,query:m.title,status:releases.length?'available':'unavailable',checkedAt:new Date().toISOString(),snapshotId:randomUUID(),total:releases.length,releases};},
  },{timeoutMs:120_000});
  try {const r=await service.run('eval',{clientTurnId:randomUUID(),message:c.text});const ids=r.recommendations.map(x=>x.mediaId);
   const pass=c.ids.length?ids.length>0&&ids.every(id=>c.ids.includes(id))&&r.recommendations.every(x=>x.availability==='available'&&x.reason.length>0):ids.length===0&&r.preferences.onlyAvailable;
   const result={name:c.name,pass,seconds:Math.round((Date.now()-began)/1000),checks,cards:r.recommendations.map(x=>({id:x.mediaId,title:x.title,reason:x.reason,availability:x.availability})),preferences:r.preferences,warnings:r.warnings.map(x=>x.code),usage:r.usage};results.push(result);console.log(JSON.stringify(result));
  }catch(e){const result={name:c.name,pass:false,error:(e as {code?:string}).code??'EVAL_FAILED',seconds:Math.round((Date.now()-began)/1000)};results.push(result);console.log(JSON.stringify(result));}
  finally{service.close();}
 }));
}
const passed=results.filter(r=>r.pass).length;console.log(JSON.stringify({summary:{passed,total:results.length}}));if(passed<Math.ceil(results.length*0.8))process.exitCode=1;
