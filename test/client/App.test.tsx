import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App";
import type { ApiClient } from "../../src/client/api";
import type { ReleaseSummary, SearchResponse, ServiceHealth } from "../../src/shared/contracts";

const first: ReleaseSummary = { id:"release-1", title:"Interstellar.2014.2160p.BluRay.x265", indexer:"TJUPT", protocol:"torrent", size:42*1024**3, seeders:28, leechers:3, grabs:4, ageDays:3, categories:[], resolution:"2160p", codec:"HEVC", freeleech:false };
const second: ReleaseSummary = {...first,id:"release-2",title:"Interstellar.2014.1080p.BluRay.x264",resolution:"1080p"};
function makeClient() {
  return {
    getSession:vi.fn().mockResolvedValue({paired:true,csrfToken:"test-csrf"}),
    getHealth:vi.fn().mockResolvedValue({status:"ok",version:"test",pairingRequired:false,capabilities:{grab:{enabled:true}}}),
    pair:vi.fn().mockResolvedValue({paired:true,csrfToken:"paired-csrf"}),
    search:vi.fn().mockResolvedValue({query:"Interstellar",intent:{searchTerm:"Interstellar"},total:2,elapsedMs:10,releases:[first,second]}),
    grabPreview:vi.fn().mockImplementation(async(id:string)=>({release:id===first.id?first:second,nasMounted:true,duplicate:false,destination:"/pt",initialState:"started"})),
    grab:vi.fn().mockResolvedValue({accepted:true,initialState:"started",message:"sent"}),
    getTorrents:vi.fn().mockResolvedValue([]),getStorage:vi.fn().mockResolvedValue({mounted:true,ready:true}),
    torrentAction:vi.fn().mockResolvedValue({ok:true}),
    getDiscoveryCollection:vi.fn(),createAssistantTurn:vi.fn(),getHistory:vi.fn(),
  };
}
async function mount(client=makeClient()) {
  render(<App client={client as unknown as ApiClient}/>);
  await screen.findByRole("searchbox");
  return client;
}
async function search() {
  const user=userEvent.setup();
  await user.type(screen.getByRole("searchbox"),"Interstellar");
  await user.click(within(screen.getByRole("search")).getByRole("button",{name:"搜索"}));
  await screen.findByText(first.title);
  return user;
}

describe("精简版片源助手",()=>{
  it("allows searches while the dependency check is still pending", async () => {
    const client = makeClient();
    let finishHealth!: (value: ServiceHealth) => void;
    client.getHealth.mockImplementationOnce(() => new Promise(resolve => { finishHealth = resolve; }));

    await mount(client);
    const user = await search();
    expect(screen.queryByText("正在连接片源服务…")).not.toBeInTheDocument();
    const indicator = screen.getByRole("button", { name: "服务状态：检查中" });
    await user.hover(indicator);
    const details = screen.getByRole("region", { name: "服务状态详情" });
    expect(within(details).getAllByText("未确认")).toHaveLength(3);

    await act(async () => finishHealth({
      status: "degraded", version: "test", pairingRequired: false,
      services: { prowlarr: true, qbittorrent: false, nasMounted: false },
    }));
    expect(indicator).toHaveAccessibleName("服务状态：部分服务异常");
    expect(within(details).getByText("未就绪")).toBeVisible();
    await user.unhover(indicator);
    expect(details).not.toBeVisible();

    client.getHealth.mockResolvedValueOnce({
      status: "ok", version: "test", pairingRequired: false,
      services: { prowlarr: true, qbittorrent: true, nasMounted: true },
    });
    await user.click(indicator);
    await user.click(within(details).getByRole("button", { name: "重新检查" }));
    await screen.findByRole("button", { name: "服务状态：正常" });
    expect(within(details).getAllByText("正常")).toHaveLength(4);
    await user.keyboard("{Escape}");
    expect(details).not.toBeVisible();
    expect(indicator).toHaveFocus();
  });

  it("reports a timed-out health check without hiding the search page", async () => {
    vi.useFakeTimers();
    try {
      const client = makeClient();
      client.getHealth.mockImplementationOnce((signal: AbortSignal) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
      render(<App client={client as unknown as ApiClient}/>);
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(screen.getByRole("searchbox")).toBeVisible();
      expect(screen.getByRole("button", { name: "服务状态：暂不可用" })).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("has only search/tasks and performs no discovery, AI or history requests",async()=>{
    const client=await mount();
    expect(within(screen.getByRole("navigation")).getAllByRole("button").map(button=>button.textContent)).toEqual(["搜索","任务"]);
    expect(client.getDiscoveryCollection).not.toHaveBeenCalled();expect(client.createAssistantTurn).not.toHaveBeenCalled();expect(client.getHistory).not.toHaveBeenCalled();
    expect(screen.getByText("输入片名或发布名开始搜索")).toBeVisible();
  });
  it("searches releases directly and selection alone makes no preview or grab requests",async()=>{
    const client=await mount();const user=await search();
    expect(client.search).toHaveBeenCalledWith({query:"Interstellar",limit:50},"test-csrf");
    await user.click(screen.getByLabelText(`选择 ${first.title}`));
    expect(screen.getByText("已选 1 个")).toBeVisible();expect(client.grabPreview).not.toHaveBeenCalled();expect(client.grab).not.toHaveBeenCalled();
  });
  it("preflights each checked release then explicitly downloads and clears accepted selections",async()=>{
    const client=await mount();const user=await search();
    await user.click(screen.getByLabelText("选择本页全部片源"));
    await user.click(screen.getByRole("button",{name:"下载所选（2）"}));
    await screen.findByText("已添加 2 个，未添加 0 个");
    expect(client.grab.mock.calls).toEqual([[{releaseId:first.id,confirm:true},"test-csrf"],[{releaseId:second.id,confirm:true},"test-csrf"]]);
    expect(client.grabPreview.mock.invocationCallOrder[0]).toBeLessThan(client.grab.mock.invocationCallOrder[0]);
    expect(screen.getByLabelText(`选择 ${first.title}`)).not.toBeChecked();
    expect(screen.getByRole("button",{name:"下载所选"})).toBeDisabled();
  });
  it.each(["nas","duplicate","expired"])("does not grab when preflight fails: %s",async(kind)=>{
    const client=makeClient();
    if(kind==="expired")client.grabPreview.mockRejectedValue(new Error("片源已过期"));
    else client.grabPreview.mockResolvedValue({...await client.grabPreview(first.id),nasMounted:kind!=="nas",duplicate:kind==="duplicate"});
    await mount(client);const user=await search();await user.click(screen.getByLabelText(`选择 ${first.title}`));await user.click(screen.getByRole("button",{name:"下载所选（1）"}));
    await screen.findByText("已添加 0 个，未添加 1 个");expect(client.grab).not.toHaveBeenCalled();expect(screen.getByLabelText(`选择 ${first.title}`)).toBeChecked();
  });
  it("preserves failed selections and never retries an already accepted item",async()=>{
    const client=makeClient();client.grab.mockResolvedValueOnce({accepted:true,initialState:"started",message:"sent"}).mockRejectedValueOnce(new Error("网络中断"));
    await mount(client);const user=await search();await user.click(screen.getByLabelText("选择本页全部片源"));await user.click(screen.getByRole("button",{name:"下载所选（2）"}));
    await screen.findByText("已添加 1 个，未添加 1 个");expect(screen.getByLabelText(`选择 ${first.title}`)).not.toBeChecked();expect(screen.getByLabelText(`选择 ${second.title}`)).toBeChecked();expect(screen.getByText(/请先到任务页核对/)).toBeVisible();
    await user.click(screen.getByRole("button",{name:"下载所选（1）"}));await screen.findByText("已添加 1 个，未添加 0 个");expect(client.grab.mock.calls.map(call=>call[0].releaseId)).toEqual([first.id,second.id,second.id]);
  });
  it("prevents double submission and locks search and selection throughout a batch",async()=>{
    const client=makeClient();let finish!:(value:unknown)=>void;client.grab.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    await mount(client);const user=await search();await user.click(screen.getByLabelText(`选择 ${first.title}`));const button=screen.getByRole("button",{name:"下载所选（1）"});await user.dblClick(button);
    await waitFor(()=>expect(client.grab).toHaveBeenCalledTimes(1));expect(screen.getByRole("searchbox")).toBeDisabled();expect(screen.getByLabelText("选择本页全部片源")).toBeDisabled();expect(screen.getByRole("status")).toHaveTextContent("正在提交下载请求（1 / 1）");
    await act(async()=>finish({accepted:true,initialState:"started",message:"sent"}));await screen.findByText("已添加 1 个，未添加 0 个");
  });
  it("clears hidden selections when changing resolution",async()=>{
    await mount();const user=await search();await user.click(screen.getByLabelText(`选择 ${second.title}`));await user.selectOptions(screen.getByLabelText("清晰度"),"2160p");
    expect(screen.queryByText(second.title)).not.toBeInTheDocument();expect(screen.getByText("已选 0 个")).toBeVisible();
  });
  it("paginates the returned resources and selects only the current page",async()=>{
    const client=makeClient();client.search.mockResolvedValue({query:"x",intent:{searchTerm:"x"},total:21,elapsedMs:1,releases:Array.from({length:21},(_,i)=>({...first,id:`r${i}`,title:i===0?first.title:`Release ${i}`}))});
    await mount(client);const user=await search();await user.click(screen.getByLabelText("选择本页全部片源"));expect(screen.getByText("已选 20 个")).toBeVisible();await user.click(screen.getByRole("button",{name:"下一页"}));expect(screen.getByText("Release 20")).toBeVisible();expect(screen.getByLabelText("选择本页全部片源")).not.toBeChecked();await user.click(screen.getByLabelText("选择本页全部片源"));expect(screen.getByText("已选 21 个")).toBeVisible();
  });
  it("invalidates prior selections as soon as the search term is edited",async()=>{
    const client=await mount();const user=await search();await user.click(screen.getByLabelText(`选择 ${first.title}`));await user.type(screen.getByRole("searchbox")," Dune");
    expect(screen.queryByText(first.title)).not.toBeInTheDocument();expect(screen.getByRole("button",{name:"下载所选"})).toBeDisabled();expect(client.grab).not.toHaveBeenCalled();
  });
  it("clears prior resources on a new failed search",async()=>{
    const client=await mount();const user=await search();client.search.mockRejectedValueOnce(new Error("搜索服务离线"));await user.click(within(screen.getByRole("search")).getByRole("button",{name:"搜索"}));await screen.findByText("搜索服务离线");expect(screen.queryByText(first.title)).not.toBeInTheDocument();
  });
  it("blocks downloads when the server disables grabs",async()=>{
    const client=makeClient();client.getHealth.mockResolvedValue({status:"ok",version:"test",pairingRequired:false,capabilities:{grab:{enabled:false}}});await mount(client);const user=await search();await user.click(screen.getByLabelText(`选择 ${first.title}`));expect(screen.getByRole("button",{name:"下载所选（1）"})).toBeDisabled();
  });
  it("shows unknown seeders instead of a fabricated zero",async()=>{
    const client=makeClient();client.search.mockResolvedValue({query:"x",intent:{searchTerm:"x"},total:1,elapsedMs:1,releases:[{...first,evidence:{resolution:"upstream",codec:"upstream",size:"unknown",seeders:"unknown",season:"unknown"}}]});await mount(client);await search();expect(within(screen.getByText(first.title).closest("tr")!).getAllByText("—")).toHaveLength(2);
  });
  it("keeps pairing available and loads tasks only after a valid session",async()=>{
    const client=makeClient();client.getSession.mockResolvedValue({paired:false,csrfToken:""});render(<App client={client as unknown as ApiClient}/>);await screen.findByRole("heading",{name:"输入配对码"});expect(client.getTorrents).not.toHaveBeenCalled();const user=userEvent.setup();await user.type(screen.getByLabelText("六位配对码"),"123456");await user.click(screen.getByRole("button",{name:"配对设备"}));await screen.findByRole("searchbox");expect(client.getTorrents).toHaveBeenCalledWith("paired-csrf");
  });

  it("shows an indeterminate search state until the real response arrives", async () => {
    const client = makeClient();
    let finishSearch!: (response: SearchResponse) => void;
    client.search.mockImplementationOnce(() => new Promise(resolve => { finishSearch = resolve; }));

    await mount(client);
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox"), "Interstellar");
    await user.click(within(screen.getByRole("search")).getByRole("button", { name: "搜索" }));

    expect(screen.getByText("正在搜索片源…")).toBeVisible();
    expect(screen.getByRole("button", { name: "搜索中…" })).toBeDisabled();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    await act(async () => finishSearch({
      query: "Interstellar",
      intent: { searchTerm: "Interstellar" },
      total: 2,
      elapsedMs: 10,
      releases: [first, second],
    }));
    expect(screen.getByText(first.title)).toBeVisible();
  });
});
