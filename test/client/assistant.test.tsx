import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe,it,expect,vi } from 'vitest';
import { defaultAssistantPreferences, type AssistantRecommendationCard, type AssistantTurnResponse } from '../../src/shared/assistant';
import { AssistantRecommendations } from '../../src/client/components/AssistantRecommendations';
import { AssistantPreferences } from '../../src/client/components/AssistantPreferences';
import { AssistantThread } from '../../src/client/components/AssistantThread';
import { useAssistant } from '../../src/client/hooks/useAssistant';
import { assistantReferenceIndex } from '../../src/client/App';
import { ApiError } from '../../src/client/api';
import type { ApiClient } from '../../src/client/api';
const card:AssistantRecommendationCard={cardId:'card_12345678',mediaId:'1292267',mediaType:'movie',title:'银河系漫游指南',genres:['科幻'],summary:'太空喜剧',reason:'适合轻松观看',evidenceIds:['metadata:movie:1292267'],constraintResults:[],availability:'available',actionableUntil:new Date(Date.now()+86400000).toISOString(),rankedReleases:[]};
const response:AssistantTurnResponse={conversationId:'11111111-1111-4111-8111-111111111111',turnId:'22222222-2222-4222-8222-222222222222',clientTurnId:'22222222-2222-4222-8222-222222222222',text:'推荐作品',preferences:defaultAssistantPreferences(),recommendations:[card],warnings:[]};
const rankedRelease:AssistantRecommendationCard['rankedReleases'][number]={id:'release_12345678',title:'银河系漫游指南.1080p',indexer:'TJUPT',protocol:'torrent',size:2*1024**3,seeders:12,leechers:1,grabs:2,ageDays:3,categories:['Movies'],resolution:'1080p',codec:'x264',freeleech:false,rank:1,reasonCodes:['PREFERRED_RESOLUTION'],matchStatus:'confirmed'};
describe('AI recommendation UI',()=>{
 it('opens a card without download and marks expired references',()=>{
  const select=vi.fn();render(<AssistantRecommendations cards={[{...card,actionableUntil:new Date(0).toISOString()}]} selectedCardId={null} onSelect={select} onFallback={()=>{}} error={null} loading={false}/>);
  expect(screen.getByText('引用已过期')).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'查看并刷新'}));expect(select).toHaveBeenCalledTimes(1);expect(screen.queryByRole('button',{name:'加入下载'})).not.toBeInTheDocument();
 });
 it('shows error fallback instead of empty-resource claims',()=>{
  const fallback=vi.fn();render(<AssistantRecommendations cards={[]} selectedCardId={null} onSelect={()=>{}} onFallback={fallback} error="PT 查询失败" loading={false}/>);
  expect(screen.getByRole('alert')).toHaveTextContent('PT 查询失败');fireEvent.click(screen.getByRole('button',{name:'按片名搜索'}));expect(fallback).toHaveBeenCalled();
 });
 it('keeps optional recommendation details collapsed until requested',()=>{
  const preferences={...defaultAssistantPreferences(),mediaType:'movie' as const,includeGenres:['科幻'],resolution:'1080p' as const};
  render(<><AssistantPreferences preferences={preferences}/><AssistantRecommendations cards={[{...card,rankedReleases:[rankedRelease]}]} selectedCardId={null} onSelect={()=>{}} onFallback={()=>{}} error={null} loading={false}/></>);
  const preferenceDetails=screen.getByText('已应用偏好').closest('details');
  const releaseDetails=screen.getByText('1 个优先片源').closest('details');
  expect(preferenceDetails).not.toHaveAttribute('open');
  expect(releaseDetails).not.toHaveAttribute('open');
  expect(document.querySelectorAll('.assistant-preference-chip')).toHaveLength(0);
  fireEvent.click(screen.getByText('1 个优先片源'));
  expect(releaseDetails).toHaveAttribute('open');
 });
 it('keeps supplementary warnings collapsed by default',()=>{
  render(<AssistantThread messages={[{id:'warning-message',role:'assistant',text:'推荐这 1 部。',createdAt:Date.now(),warnings:[{code:'SOURCE_UNAVAILABLE',message:'片源检查暂时不可用。'}]}]}/>);
  const details=screen.getByText('1 条补充说明').closest('details');
  expect(details).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText('1 条补充说明'));
  expect(details).toHaveAttribute('open');
  expect(screen.getByText('片源检查暂时不可用。')).toBeVisible();
 });

 it('shows safe sources and keeps an unverified variety card out of details',()=>{
  const select=vi.fn();
  const unverified={...card,identityStatus:'unverified' as const,contentKind:'variety' as const,sources:[{id:'douban',title:'豆瓣条目',url:'https://movie.douban.com/subject/1292267/'}],rankedReleases:[rankedRelease]};
  render(<AssistantRecommendations cards={[unverified]} selectedCardId={null} onSelect={select} onFallback={()=>{}} error={null} loading={false}/>);

  expect(screen.getByText('综艺')).toBeInTheDocument();
  const source=screen.getByRole('link',{name:'豆瓣条目'});
  expect(source).toHaveAttribute('target','_blank');
  expect(source).toHaveAttribute('rel','noreferrer noopener');
  const details=screen.getByRole('button',{name:'待核实，暂不可查看'});
  expect(details).toBeDisabled();
  expect(screen.queryByText('1 个优先片源')).not.toBeInTheDocument();
  fireEvent.click(details);
  expect(select).not.toHaveBeenCalled();
 });

 it('keeps onlyAvailable candidates in a separate pending verification area',()=>{
  const pending={...card,cardId:'pending_12345678',identityStatus:'unverified' as const,contentKind:'movie' as const,sources:[{id:'source',title:'来源',url:'https://example.com/movie'}]};
  render(<AssistantRecommendations cards={[card]} pendingRecommendations={[pending]} selectedCardId={null} onSelect={()=>{}} onFallback={()=>{}} error={null} loading={true} phase="checking"/>);

  expect(screen.getByRole('region',{name:'待核实推荐'})).toBeInTheDocument();
  expect(screen.getByRole('heading',{name:'待核实'})).toBeInTheDocument();
  expect(screen.getByText('正在检查片源…')).toBeInTheDocument();
  expect(screen.getByRole('link',{name:'来源'})).toHaveAttribute('href','https://example.com/movie');
 });

 it('uses the explicit series and documentary content kinds in card metadata',()=>{
  const cards=[{...card,cardId:'series_12345678',contentKind:'series' as const},{...card,cardId:'doc_12345678',contentKind:'documentary' as const}];
  render(<AssistantRecommendations cards={cards} selectedCardId={null} onSelect={()=>{}} onFallback={()=>{}} error={null} loading={false}/>);
  expect(screen.getByText('剧集')).toBeInTheDocument();
  expect(screen.getByText('纪录片')).toBeInTheDocument();
 });

 it('reuses conversation and replaces the displayed recommendation set on followup',async()=>{
  const submit=vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce({...response,recommendations:[],text:'已排除看过的作品'});
  const client={createAssistantTurn:submit} as unknown as ApiClient;
  const {result}=renderHook(()=>useAssistant(client,'csrf',true));
  await act(async()=>{await result.current.submit('科幻');});expect(result.current.cards).toHaveLength(1);
  await act(async()=>{await result.current.submit('看过了');});expect(result.current.cards).toHaveLength(0);
  expect(submit.mock.calls[1]?.[0].conversationId).toBe(response.conversationId);
 });
 it('cancels first pending turn even before conversation ID exists and ignores late output',async()=>{
  let resolve!:(value:AssistantTurnResponse)=>void;const cancel=vi.fn().mockResolvedValue(undefined);
  const client={createAssistantTurn:()=>new Promise<AssistantTurnResponse>(r=>{resolve=r;}),cancelAssistantTurn:cancel} as unknown as ApiClient;
  const {result}=renderHook(()=>useAssistant(client,'csrf',true));let pending!:Promise<unknown>;
  act(()=>{pending=result.current.submit('科幻');});
  await waitFor(()=>expect(result.current.loading).toBe(true));
  await act(async()=>{await result.current.clear();});
  expect(cancel).toHaveBeenCalledTimes(1);
  await act(async()=>{resolve(response);await pending;});expect(result.current.messages).toEqual([]);expect(result.current.cards).toEqual([]);
 });

 it('binds Chinese and numeric ordinals to the displayed card position',()=>{
  expect(assistantReferenceIndex('帮我下第二部')).toBe(1);
  expect(assistantReferenceIndex('只要第 3 个版本')).toBe(2);
  expect(assistantReferenceIndex('帮我下第4项')).toBe(3);
  expect(assistantReferenceIndex('帮我下这个')).toBeNull();
 });

 it('resets expired conversation state so stale cards cannot be reused',async()=>{
  const client={createAssistantTurn:vi.fn().mockRejectedValue(new ApiError('对话已过期，请清空后重新开始。',404,'CONVERSATION_EXPIRED'))} as unknown as ApiClient;
  const {result}=renderHook(()=>useAssistant(client,'csrf',true));
  await act(async()=>{await result.current.submit('继续推荐');});
  expect(result.current.conversationId).toBeNull();
  expect(result.current.cards).toEqual([]);
  expect(result.current.messages.at(-1)?.text).toContain('对话已过期');
 });

 it('renders the first stream snapshot in the existing assistant message until completion',async()=>{
  let resolveStream!:(value:AssistantTurnResponse)=>void;
  const verifying={...response,phase:'verifying' as const,text:'正在核实作品…'};
  const complete={...response,phase:'complete' as const,text:'推荐完成'};
  const stream=vi.fn((_request:unknown,_csrf:string,onSnapshot:(snapshot:AssistantTurnResponse)=>void,_signal?:AbortSignal)=>{
   onSnapshot(verifying);
   return new Promise<AssistantTurnResponse>((resolve)=>{resolveStream=resolve;});
  });
  const legacy=vi.fn();
  const client={createAssistantTurnStream:stream,createAssistantTurn:legacy} as unknown as ApiClient;
  const {result}=renderHook(()=>useAssistant(client,'csrf',true));
  let pending!:Promise<unknown>;
  act(()=>{pending=result.current.submit('科幻');});
  await waitFor(()=>expect(result.current.cards).toHaveLength(1));
  expect(result.current.loading).toBe(true);
  expect(result.current.phase).toBe('verifying');
  expect(result.current.conversationId).toBe(response.conversationId);
  expect(result.current.messages.filter((item)=>item.role==='assistant')).toHaveLength(1);
  expect(legacy).not.toHaveBeenCalled();

  await act(async()=>{resolveStream(complete);await pending;});
  expect(result.current.loading).toBe(false);
  expect(result.current.phase).toBe('complete');
  expect(result.current.messages.filter((item)=>item.role==='assistant')).toHaveLength(1);
  expect(result.current.messages.at(-1)?.text).toBe('推荐完成');
 });

 it('cancels a streamed check, keeps the first cards, and ignores a late snapshot',async()=>{
  let resolveStream!:(value:AssistantTurnResponse)=>void;
  let onSnapshot!: (snapshot:AssistantTurnResponse)=>void;
  let signal!: AbortSignal;
  const verifying={...response,phase:'checking' as const,text:'正在检查片源…'};
  const late={...response,phase:'complete' as const,text:'迟到的完成结果'};
  const stream=vi.fn((_request:unknown,_csrf:string,callback:(snapshot:AssistantTurnResponse)=>void,requestSignal?:AbortSignal)=>{
   onSnapshot=callback;
   signal=requestSignal!;
   callback(verifying);
   return new Promise<AssistantTurnResponse>((resolve)=>{resolveStream=resolve;});
  });
  const cancel=vi.fn().mockResolvedValue(undefined);
  const client={createAssistantTurnStream:stream,cancelAssistantTurn:cancel} as unknown as ApiClient;
  const {result}=renderHook(()=>useAssistant(client,'csrf',true));
  let pending!:Promise<unknown>;
  act(()=>{pending=result.current.submit('科幻');});
  await waitFor(()=>expect(result.current.cards).toHaveLength(1));
  await act(async()=>{await result.current.cancel();});
  expect(signal.aborted).toBe(true);
  expect(result.current.loading).toBe(false);
  expect(result.current.cards).toHaveLength(1);
  expect(result.current.messages.at(-1)?.text).toBe('已取消本轮推荐。');
  onSnapshot(late);
  resolveStream(late);
  await pending;
  expect(result.current.cards).toHaveLength(1);
  expect(result.current.messages.at(-1)?.text).toBe('已取消本轮推荐。');
  expect(cancel).toHaveBeenCalledWith(response.turnId,'csrf');
 });

 it('does not fall back to a paid JSON request when the stream method exists but fails',async()=>{
  const stream=vi.fn().mockRejectedValue(new ApiError('流式请求失败',502,'AI_TIMEOUT'));
  const legacy=vi.fn().mockResolvedValue(response);
  const client={createAssistantTurnStream:stream,createAssistantTurn:legacy} as unknown as ApiClient;
  const {result}=renderHook(()=>useAssistant(client,'csrf',true));
  await act(async()=>{await result.current.submit('科幻');});
  expect(stream).toHaveBeenCalledTimes(1);
  expect(legacy).not.toHaveBeenCalled();
  expect(result.current.error).toBe('流式请求失败');
 });

 it('ignores a late cancel failure after a newer turn starts',async()=>{
  let resolveFirst!:(value:AssistantTurnResponse)=>void;
  let rejectCancel!:(reason:unknown)=>void;
  const first = new Promise<AssistantTurnResponse>((resolve)=>{resolveFirst=resolve;});
  const cancel = new Promise<void>((_,reject)=>{rejectCancel=reject;});
  const secondResponse={...response,turnId:'33333333-3333-4333-8333-333333333333',clientTurnId:'33333333-3333-4333-8333-333333333333'};
  const create=vi.fn()
    .mockImplementationOnce((_request:unknown,_csrf:string,_signal?:AbortSignal)=>first)
    .mockResolvedValueOnce(secondResponse);
  const client={createAssistantTurn:create,cancelAssistantTurn:vi.fn().mockReturnValue(cancel)} as unknown as ApiClient;
  const {result}=renderHook(()=>useAssistant(client,'csrf',true));
  let firstRequest!:Promise<unknown>;
  act(()=>{firstRequest=result.current.submit('第一轮');});
  await waitFor(()=>expect(result.current.loading).toBe(true));
  act(()=>{void result.current.cancel();});
  await waitFor(()=>expect(result.current.loading).toBe(false));
  await act(async()=>{await result.current.submit('第二轮');});
  expect(result.current.error).toBeNull();
  await act(async()=>{rejectCancel(new ApiError('没有找到该轮推荐。',404,'TURN_NOT_FOUND')); await cancel.catch(()=>undefined);});
  expect(result.current.error).toBeNull();
  resolveFirst(response);
  await firstRequest;
 });
});
