export const ADMIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>WeCom Codex 管理后台</title>
  <style>
    :root{color-scheme:dark;--bg:#090d14;--panel:#111823;--panel2:#172130;--line:#263447;--text:#e8eef7;--muted:#91a0b5;--blue:#4b9cff;--green:#48d597;--amber:#ffbd59;--red:#ff6b78;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% -10%,#17345a 0,transparent 32%),var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    header{height:72px;padding:0 28px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);background:#0b111bcc;backdrop-filter:blur(14px);position:sticky;top:0;z-index:10}
    h1{font-size:18px;margin:0;letter-spacing:.2px}.brand{display:flex;align-items:center;gap:12px}.logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#49a5ff,#715cff);display:grid;place-items:center;font-weight:800}
    .status{display:flex;align-items:center;gap:8px;color:var(--muted)}.dot{width:9px;height:9px;border-radius:50%;background:var(--amber);box-shadow:0 0 12px currentColor}.dot.on{background:var(--green)}
    main{max-width:1500px;margin:0 auto;padding:24px}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:20px}.card{background:linear-gradient(180deg,#151f2d,#101720);border:1px solid var(--line);border-radius:14px;padding:16px}.label{color:var(--muted);font-size:12px}.value{font:600 18px var(--mono);margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .tabs{display:flex;gap:8px;margin-bottom:14px}.tab{border:1px solid var(--line);background:var(--panel);color:var(--muted);padding:9px 16px;border-radius:10px;cursor:pointer}.tab.active{color:white;border-color:#3e77ba;background:#173052}.view{display:none}.view.active{display:block}
    .toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}.toolbar input,.toolbar select,.toolbar button{border:1px solid var(--line);background:#101824;color:var(--text);border-radius:9px;padding:9px 11px}.toolbar input{min-width:260px}.toolbar button{cursor:pointer}.toolbar button:hover{border-color:#5479a6}.spacer{flex:1}.badge{font:12px var(--mono);color:var(--muted)}
    .log-list{height:calc(100vh - 270px);min-height:440px;overflow:auto;border:1px solid var(--line);border-radius:14px;background:#0c121b}.event{display:grid;grid-template-columns:185px 250px 1fr;gap:12px;padding:10px 13px;border-bottom:1px solid #1a2635;font:12px/1.45 var(--mono)}.event:hover{background:#121c29}.event time{color:#7f90a8}.event-name{color:var(--blue);word-break:break-all}.event pre{margin:0;white-space:pre-wrap;word-break:break-word;color:#cbd6e5;max-height:180px;overflow:auto}.event.warn .event-name{color:var(--amber)}.event.error .event-name{color:var(--red)}
    .table-wrap{border:1px solid var(--line);border-radius:14px;overflow:auto;max-height:calc(100vh - 280px);background:#0c121b}table{border-collapse:collapse;width:max-content;min-width:100%;font:12px/1.45 var(--mono)}th{position:sticky;top:0;background:#182334;color:#b8c5d8;text-align:left;z-index:2}th,td{padding:9px 11px;border-right:1px solid #213044;border-bottom:1px solid #1d2a3a;max-width:420px;vertical-align:top}td{white-space:pre-wrap;word-break:break-word;color:#dbe3ef}.empty{padding:50px;text-align:center;color:var(--muted)}
    @media(max-width:900px){.stats{grid-template-columns:1fr 1fr}.event{grid-template-columns:1fr}.event time{display:none}main{padding:14px}header{padding:0 16px}}
  </style>
</head>
<body>
<header><div class="brand"><div class="logo">CX</div><div><h1>WeCom Codex 管理后台</h1><div class="label">本机只读监控</div></div></div><div class="status"><span id="liveDot" class="dot"></span><span id="liveText">正在连接</span></div></header>
<main>
  <section class="stats">
    <div class="card"><div class="label">服务运行时间</div><div id="uptime" class="value">—</div></div>
    <div class="card"><div class="label">审计事件</div><div id="eventCount" class="value">0</div></div>
    <div class="card"><div class="label">SQLite 表</div><div id="tableCount" class="value">—</div></div>
    <div class="card"><div class="label">监听地址</div><div id="listenAddress" class="value">—</div></div>
  </section>
  <nav class="tabs"><button class="tab active" data-view="logs">实时日志</button><button class="tab" data-view="database">SQLite 数据</button></nav>
  <section id="logs" class="view active">
    <div class="toolbar"><input id="logSearch" placeholder="筛选事件名或内容"><select id="eventFilter"><option value="">全部事件</option></select><button id="pauseBtn">暂停</button><button id="clearBtn">清空视图</button><span class="spacer"></span><span id="logHint" class="badge"></span></div>
    <div id="logList" class="log-list"><div class="empty">正在加载审计日志…</div></div>
  </section>
  <section id="database" class="view">
    <div class="toolbar"><select id="tableSelect"></select><select id="pageSize"><option>25</option><option selected>50</option><option>100</option><option>200</option></select><button id="refreshTable">刷新</button><button id="prevPage">上一页</button><button id="nextPage">下一页</button><span id="pageInfo" class="badge"></span></div>
    <div id="tableWrap" class="table-wrap"><div class="empty">请选择数据表</div></div>
  </section>
</main>
<script>
const state={events:[],paused:false,eventCount:0,offset:0,total:0};
const $=id=>document.getElementById(id); const esc=v=>v===null?'NULL':typeof v==='object'?JSON.stringify(v,null,2):String(v);
function formatUptime(s){s=Math.max(0,Math.floor(s));const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60),x=s%60;return (d?d+'天 ':'')+[h,m,x].map(v=>String(v).padStart(2,'0')).join(':')}
async function json(url){const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||r.statusText);return r.json()}
async function loadStatus(){try{const s=await json('/api/status');$('uptime').textContent=formatUptime(s.uptimeSeconds);$('listenAddress').textContent=s.address;setInterval(()=>$('uptime').textContent=formatUptime(++s.uptimeSeconds),1000)}catch(e){$('liveText').textContent='状态读取失败'}}
function severity(name){return /error|failed|stderr|decline/i.test(name)?'error':/warn|approval|interrupt/i.test(name)?'warn':''}
function visible(e){const q=$('logSearch').value.toLowerCase(),f=$('eventFilter').value;return(!f||e.event===f)&&(!q||JSON.stringify(e).toLowerCase().includes(q))}
function renderLogs(){const list=$('logList');list.textContent='';const rows=state.events.filter(visible);if(!rows.length){list.innerHTML='<div class="empty">没有匹配的事件</div>';return}const frag=document.createDocumentFragment();for(const e of rows){const row=document.createElement('div');row.className='event '+severity(e.event);const t=document.createElement('time');t.textContent=new Date(e.timestamp).toLocaleString();const n=document.createElement('div');n.className='event-name';n.textContent=e.event;const p=document.createElement('pre');p.textContent=JSON.stringify(e.data,null,2);row.append(t,n,p);frag.append(row)}list.append(frag);list.scrollTop=list.scrollHeight;$('logHint').textContent='显示 '+rows.length+' / 缓存 '+state.events.length}
function addEvent(e){state.eventCount++;$('eventCount').textContent=state.eventCount.toLocaleString();if(state.paused)return;state.events.push(e);if(state.events.length>1000)state.events.shift();if(!$('eventFilter').querySelector('option[value="'+CSS.escape(e.event)+'"]')){const o=document.createElement('option');o.value=e.event;o.textContent=e.event;$('eventFilter').append(o)}renderLogs()}
async function loadRecent(){const data=await json('/api/audit/recent?limit=250');state.events=data.entries;state.eventCount=data.entries.length;for(const e of data.entries){if(!$('eventFilter').querySelector('option[value="'+CSS.escape(e.event)+'"]')){const o=document.createElement('option');o.value=e.event;o.textContent=e.event;$('eventFilter').append(o)}}$('eventCount').textContent=state.eventCount.toLocaleString();renderLogs()}
function connectStream(){const es=new EventSource('/api/audit/stream');es.onopen=()=>{$('liveDot').classList.add('on');$('liveText').textContent='实时连接'};es.onmessage=e=>{try{addEvent(JSON.parse(e.data))}catch{}};es.onerror=()=>{$('liveDot').classList.remove('on');$('liveText').textContent='正在重连'}}
async function loadTables(){const d=await json('/api/db/tables');$('tableCount').textContent=d.tables.length;const s=$('tableSelect');s.textContent='';for(const t of d.tables){const o=document.createElement('option');o.value=t;o.textContent=t;s.append(o)}if(d.tables.length)loadRows()}
async function loadRows(){const table=$('tableSelect').value,limit=Number($('pageSize').value);if(!table)return;const d=await json('/api/db/rows?table='+encodeURIComponent(table)+'&limit='+limit+'&offset='+state.offset);state.total=d.total;const wrap=$('tableWrap');wrap.textContent='';if(!d.rows.length){wrap.innerHTML='<div class="empty">该表没有数据</div>'}else{const tableEl=document.createElement('table'),thead=document.createElement('thead'),tr=document.createElement('tr');for(const c of d.columns){const th=document.createElement('th');th.textContent=c.name+' · '+(c.type||'');tr.append(th)}thead.append(tr);tableEl.append(thead);const tb=document.createElement('tbody');for(const row of d.rows){const rr=document.createElement('tr');for(const c of d.columns){const td=document.createElement('td');td.textContent=esc(row[c.name]);rr.append(td)}tb.append(rr)}tableEl.append(tb);wrap.append(tableEl)}const end=Math.min(state.offset+limit,d.total);$('pageInfo').textContent=d.total?state.offset+1+'–'+end+' / '+d.total:'0 条';$('prevPage').disabled=state.offset===0;$('nextPage').disabled=end>=d.total}
document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tab,.view').forEach(x=>x.classList.remove('active'));b.classList.add('active');$(b.dataset.view).classList.add('active')});
$('logSearch').oninput=renderLogs;$('eventFilter').onchange=renderLogs;$('pauseBtn').onclick=()=>{state.paused=!state.paused;$('pauseBtn').textContent=state.paused?'继续':'暂停'};$('clearBtn').onclick=()=>{state.events=[];renderLogs()};
$('tableSelect').onchange=()=>{state.offset=0;loadRows()};$('pageSize').onchange=()=>{state.offset=0;loadRows()};$('refreshTable').onclick=loadRows;$('prevPage').onclick=()=>{state.offset=Math.max(0,state.offset-Number($('pageSize').value));loadRows()};$('nextPage').onclick=()=>{state.offset+=Number($('pageSize').value);loadRows()};
loadStatus();loadRecent().catch(e=>$('logList').textContent=e.message);loadTables().catch(e=>$('tableWrap').textContent=e.message);connectStream();
</script>
</body></html>`;
