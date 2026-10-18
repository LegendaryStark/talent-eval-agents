import { useEffect, useState } from 'react';
import './evaluation.css';

export const moduleLabels: Record<string, string> = {request_understanding: '人才要求理解', job_matching: '岗位名称匹配', dimension_generation: '动态维度生成', fact_extraction: '事实抽取'};
type CaseRow = {case_id: string; source_run_id: string; turn_no: number; module_key: string; invocation_no: number; status: string; created_at: string; identity: Record<string, string>; has_feedback: boolean; run_has_feedback: boolean};
async function api(url: string, options?: RequestInit) {
  const r = await fetch(url, options);
  const body = await r.json();
  if (!r.ok) throw new Error(typeof body.detail === 'string' ? body.detail : '请求失败');
  return body;
}
export function FeedbackButton({apiBase, runId, caseId}: {apiBase: string; runId: string; caseId?: string}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [state, setState] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await api(`${apiBase}/evaluation/feedback`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({source_run_id: runId, case_id: caseId || null, feedback_scope: caseId ? 'module' : 'run', note})});
      setState('已提交用户反馈'); setOpen(false);
    } catch (e) { setState(String(e)); } finally { setBusy(false); }
  }
  return <div className="feedbackForm"><button onClick={() => setOpen(!open)}>问题反馈</button>{state && <small role="status">{state}</small>}{open && <div><textarea aria-label="反馈说明" placeholder="简短说明（可选）" value={note} maxLength={2000} onChange={e => setNote(e.target.value)} /><button disabled={busy} onClick={submit}>{busy ? '提交中' : '提交反馈'}</button></div>}</div>;
}
export function StepCaseFeedback({apiBase, runId, stepId}: {apiBase: string; runId: string; stepId: string}) {
  const [rows, setRows] = useState<CaseRow[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    setRows([]); setError('');
    async function loadCases() {
      const modules = stepId === 'understand_request' ? ['request_understanding', 'job_matching'] : stepId === 'build_dimensions' ? ['dimension_generation'] : stepId === 'parallel_assessment' ? ['fact_extraction'] : [];
      if (!modules.length) return;
      const collected: CaseRow[] = [];
      let offset = 0;
      while (current) {
        const data = await api(`${apiBase}/evaluation/cases?source_run_id=${encodeURIComponent(runId)}&limit=200&offset=${offset}`);
        collected.push(...data.items);
        if (!data.has_more) break;
        offset += 200;
      }
      if (current) setRows(collected.filter(row => modules.includes(row.module_key)));
    }
    loadCases().catch(e => { if (current) setError(String(e)); });
    return () => {current = false;};
  }, [apiBase, runId, stepId]);
  return <section><h3>模块调用反馈</h3>{error && <p role="alert">{error}</p>}{rows.map(row => <div key={row.case_id}><b>{moduleLabels[row.module_key]} · 调用 {row.invocation_no}</b><small>{Object.values(row.identity).join(' / ')} · {row.case_id.slice(0, 8)}</small><FeedbackButton apiBase={apiBase} runId={runId} caseId={row.case_id} /></div>)}{!rows.length && !error && <p>该步骤暂无可反馈的模块调用</p>}</section>;
}
export function EvaluationCenter({apiBase, onChat, onRecords}: {apiBase: string; onChat: () => void; onRecords: () => void}) {
  const [view, setView] = useState('run');
  const [module, setModule] = useState('');
  const [status, setStatus] = useState('');
  const [signal, setSignal] = useState(false);
  const [run, setRun] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{items: CaseRow[]; has_more: boolean}>({items: [], has_more: false});
  const [detail, setDetail] = useState<any>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let current = true;
    setError(''); setData({items: [], has_more: false});
    const q = new URLSearchParams({offset: String(offset), limit: '100'});
    if (module) q.set('module_key', module);
    if (status) q.set('status', status);
    if (signal) q.set('has_feedback', 'true');
    if (run) q.set('source_run_id', run);
    api(`${apiBase}/evaluation/cases?${q}`).then(d => {if (current) setData(d);}).catch(e => {if (current) setError(String(e));});
    return () => {current = false;};
  }, [apiBase, module, status, signal, run, offset, refresh]);
  const groups = view === 'run' ? [...new Set(data.items.map(r => r.source_run_id))] : ['模块记录'];
  return <div className="app evaluationApp"><aside className="side"><div className="brand"><img src="/talentos-favicon.png" alt="TalentOS"/><div><b>智鉴 TalentOS</b><small>多 AGENT 人才决策平台</small></div></div><nav><button>工作台</button><button onClick={onRecords}>人才档案</button><button onClick={onChat}>评估与推荐</button><button className="active">评测中心</button></nav></aside><main className="evaluationMain"><h1>评测中心</h1><p>模块原始调用与用户问题反馈</p><div className="evaluationFilters"><button onClick={() => setView('run')}>按 Run 查看</button><button onClick={() => setView('module')}>按模块查看</button><select aria-label="模块" value={module} onChange={e => {setModule(e.target.value);setOffset(0);}}><option value="">全部模块</option>{Object.entries(moduleLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><select aria-label="状态" value={status} onChange={e => {setStatus(e.target.value);setOffset(0);}}><option value="">全部状态</option><option value="succeeded">调用成功</option><option value="failed">调用失败</option></select><label><input type="checkbox" checked={signal} onChange={e => {setSignal(e.target.checked);setOffset(0);}}/>用户反馈 Case</label><input aria-label="Run ID" placeholder="按 Run ID 筛选" value={run} onChange={e => {setRun(e.target.value);setOffset(0);}}/><button onClick={() => setRefresh(x => x + 1)}>刷新</button></div>{error && <p role="alert">{error}</p>}{!data.items.length && <p>暂无符合条件的 Case</p>}{groups.map(group => <section key={group}><h2>{view === 'run' ? `Run · ${group}` : group}</h2><table><thead><tr><th>模块 / 调用</th><th>Run / Turn</th><th>业务对象</th><th>状态</th><th>反馈</th><th>时间</th></tr></thead><tbody>{data.items.filter(r => view !== 'run' || r.source_run_id === group).map(row => <tr key={row.case_id}><td><button onClick={() => api(`${apiBase}/evaluation/cases/${row.case_id}`).then(setDetail).catch(e => setError(String(e)))}>{moduleLabels[row.module_key]} #{row.invocation_no}</button></td><td title={row.source_run_id}>{row.source_run_id.slice(0, 8)} / {row.turn_no}</td><td>{Object.values(row.identity).join(' / ') || '—'}</td><td>{row.status}</td><td>{row.has_feedback ? '用户反馈' : row.run_has_feedback ? 'Run 有反馈' : '—'}</td><td>{new Date(row.created_at).toLocaleString()}</td></tr>)}</tbody></table></section>)}<button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>上一页</button><button disabled={!data.has_more} onClick={() => setOffset(offset + 100)}>下一页</button><small>每页 100 条调用，Run 的调用可能跨页</small></main>{detail && <div className="evaluationOverlay" onClick={() => setDetail(null)}><aside onClick={e => e.stopPropagation()}><button onClick={() => setDetail(null)}>关闭</button><h2>{moduleLabels[detail.module_key]} · Case 详情</h2><p>{detail.id}</p><p>Run · {detail.source_run_id} / Turn {detail.turn_no} / 调用 {detail.invocation_no}</p>{['input_payload','output_payload','replay_context','version_snapshot','status','error_code','duration_ms','annotation_status','feedback'].map(key => <section key={key}><h3>{({input_payload:'实际输入',output_payload:'实际输出',replay_context:'Runtime Context 与重放上下文',version_snapshot:'版本快照',status:'调用状态',error_code:'异常类型',duration_ms:'耗时 ms',annotation_status:'标注状态',feedback:'用户反馈'} as Record<string,string>)[key]}</h3><pre>{JSON.stringify(detail[key], null, 2)}</pre></section>)}</aside></div>}</div>;
}
