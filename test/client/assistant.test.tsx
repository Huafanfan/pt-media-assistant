import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe,it,expect,vi } from 'vitest';
import { defaultAssistantPreferences, type AssistantRecommendationCard, type AssistantTurnResponse } from '../../src/shared/assistant';
import { AssistantRecommendations } from '../../src/client/components/AssistantRecommendations';
import { useAssistant } from '../../src/client/hooks/useAssistant';
import { assistantReferenceIndex } from '../../src/client/App';
import { ApiError } from '../../src/client/api';
import type { ApiClient } from '../../src/client/api';
const card:AssistantRecommendationCard={cardId:'card_12345678',mediaId:'1292267',mediaType:'movie',title:'银河系漫游指南',genres:['科幻'],summary:'太空喜剧',reason:'适合轻松观看',evidenceIds:['metadata:movie:1292267'],constraintResults:[],availability:'available',actionableUntil:new Date(Date.now()+86400000).toISOString(),rankedReleases:[]};
const response:AssistantTurnResponse={conversationId:'11111111-1111-4111-8111-111111111111',turnId:'22222222-2222-4222-8222-222222222222',clientTurnId:'22222222-2222-4222-8222-222222222222',text:'推荐作品',preferences:defaultAssistantPreferences(),recommendations:[card],warnings:[]};
describe('AI recommendation UI',()=>{
 it('opens a card without download and marks expired references',()=>{
  const select=vi.fn();render(<AssistantRecommendations cards={[{...card,actionableUntil:new Date(0).toISOString()}]} selectedCardId={null} onSelect={select} onFallback={()=>{}} error={null} loading={false}/>);
  expect(screen.getByText('引用已过期')).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'查看并刷新'}));expect(select).toHaveBeenCalledTimes(1);expect(screen.queryByRole('button',{name:'加入下载'})).not.toBeInTheDocument();
 });
 it('shows error fallback instead of empty-resource claims',()=>{
  const fallback=vi.fn();render(<AssistantRecommendations cards={[]} selectedCardId={null} onSelect={()=>{}} onFallback={fallback} error="PT 查询失败" loading={false}/>);
  expect(screen.getByRole('alert')).toHaveTextContent('PT 查询失败');fireEvent.click(screen.getByRole('button',{name:'按片名搜索'}));expect(fallback).toHaveBeenCalled();
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
