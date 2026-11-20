// Canopus — server edition. All AI calls and data go through this server; no API keys in the browser.
import { marked } from '/vendor/marked.esm.js';
import DOMPurify from '/vendor/purify.es.mjs';
import { initReports, renderReports } from '/reports.js';

DOMPurify.addHook('afterSanitizeAttributes', n => { if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); } });

/* ================= Icons ================= */
const ICONS = {
  star:'<path d="M12 1.5c.8 5.6 2.9 7.7 8.5 8.5-5.6.8-7.7 2.9-8.5 8.5-.8-5.6-2.9-7.7-8.5-8.5 5.6-.8 7.7-2.9 8.5-8.5z" fill="currentColor" stroke="none"/><circle cx="19.5" cy="19.5" r="1.4" fill="currentColor" stroke="none" opacity=".7"/><circle cx="4.5" cy="21" r=".9" fill="currentColor" stroke="none" opacity=".45"/>',
  home:'<path d="M3 11 12 4l9 7v8a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  layers:'<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/><path d="m3 17.5 9 5 9-5" opacity=".5"/>',
  archive:'<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
  book:'<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5zM4 21.5A2.5 2.5 0 0 1 6.5 19H20v3H6.5"/><path d="M9 7h7M9 11h5"/>',
  shield:'<path d="M12 2 4 5v6c0 5 3.4 9.3 8 11 4.6-1.7 8-6 8-11V5z"/><path d="m9 12 2 2 4-4"/>',
  bolt:'<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  puzzle:'<path d="M9 3a2 2 0 0 1 4 0v2h4a1 1 0 0 1 1 1v4h-2a2 2 0 1 0 0 4h2v4a1 1 0 0 1-1 1h-4v-2a2 2 0 1 0-4 0v2H5a1 1 0 0 1-1-1v-4h2a2 2 0 1 0 0-4H4V6a1 1 0 0 1 1-1h4z"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  sidebar:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  edit:'<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  pin:'<path d="M9 4h6l-1 5 4 3v2H6v-2l4-3zM12 14v7"/>',
  chevDown:'<path d="m6 9 6 6 6-6"/>', chevRight:'<path d="m9 6 6 6-6 6"/>',
  globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  mic:'<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  arrowUp:'<path d="M12 19V5M6 11l6-6 6 6"/>',
  stop:'<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/>',
  sparkle:'<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  attach:'<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/>',
  screen:'<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  check:'<path d="m5 12 5 5 9-10"/>', x:'<path d="M6 6l12 12M18 6 6 18"/>',
  trash:'<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  refresh:'<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4"/>',
  chat:'<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  upload:'<path d="M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  download:'<path d="M12 3v12M7 10l5 5 5-5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  file:'<path d="M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h6"/>',
  text:'<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  image:'<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 8"/>',
  table:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M3 15h18M9 5v14"/>',
  grid:'<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  key:'<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M17 6l3 3M14 9l2 2"/>',
  lock:'<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  dots:'<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  bulb:'<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3z"/>',
  memo:'<path d="M4 4h16v12H8l-4 4z"/><path d="M8 9h8M8 12h5"/>',
  chart:'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  eye:'<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  expand:'<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  folder:'<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  languages:'<path d="M4 5h8M8 3v2M6 5c0 4 2 7 6 9M10 5c0 3-2 6-6 8M13 21l4-9 4 9M14.5 18h5"/>',
  mail:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  megaphone:'<path d="M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1zM17 9a4 4 0 0 1 0 6"/>',
  scale:'<path d="M12 3v18M5 21h14M7 7h10M7 7l-3 7h6zM17 7l-3 7h6z"/>',
  users:'<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M19 20a6 6 0 0 0-3-5.2"/>',
  logout:'<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l-5-5 5-5M5 12h11"/>',
};
const ic = (n, cls='') => `<svg viewBox="0 0 24 24"${cls?` class="${cls}"`:''}>${ICONS[n]||''}</svg>`;
function hydrateIcons(root=document){ root.querySelectorAll('svg[data-ic]').forEach(s=>{ s.setAttribute('viewBox','0 0 24 24'); s.innerHTML=ICONS[s.dataset.ic]||''; s.removeAttribute('data-ic'); }); }

/* ================= Config ================= */
const MODES = [
  {id:'auto', name:'Balanced', d:'Good depth at good speed'},
  {id:'fast', name:'Quick', d:'Short, fast answers'},
  {id:'think', name:'Deep', d:'Thinks longer on hard problems'},
];
const FTYPES = [
  {id:'all', l:'All', ic:'grid'},
  {id:'doc', l:'Documents', ic:'file', ext:/\.(pdf|docx?|pptx?|odt|rtf)$/i},
  {id:'text', l:'Text', ic:'text', ext:/\.(txt|md|markdown|json|html?|xml|ya?ml|log)$/i},
  {id:'img', l:'Images', ic:'image', ext:/\.(png|jpe?g|gif|webp)$/i},
  {id:'tab', l:'Data', ic:'table', ext:/\.(csv|tsv)$/i},
];
const SPACE_COLORS=['#f4c76a','#a99bff','#7cc4ff','#5fd3a0','#ff7aa8','#f4a35c'];
const BUILTIN_PROMPTS = [
  {id:'bp14', icon:'memo', title:'Communication strategy', body:'Susun strategi komunikasi untuk {{program}} periode {{periode}}.\n\nStruktur: situasi & temuan monitoring media, tujuan (SMART), audiens prioritas, key messages, taktik per kanal, juru bicara, kalender aktivitas, risiko & mitigasi, serta indikator keberhasilan.'},
  {id:'bp9', icon:'megaphone', title:'Issue analysis', body:'Analisis isu berikut untuk tim komunikasi: {{isu}}.\n\nSusun: ringkasan isu, kronologi singkat, pemangku kepentingan dan posisinya, narasi yang beredar (positif/negatif), tingkat risiko reputasi (rendah/sedang/tinggi) beserta alasannya, dan 3–5 rekomendasi langkah komunikasi. Gunakan knowledge internal dan data monitoring terlampir bila ada.'},
  {id:'bp13', icon:'sparkle', title:'Brainstorm campaign ideas', body:'Brainstorming ide kampanye komunikasi untuk {{program}} dengan tujuan {{tujuan}} dan audiens {{audiens}}.\n\nBerikan 8 ide yang beragam (digital, media, komunitas, acara), masing-masing dengan: nama ide, inti gagasan, kanal, contoh konten, dan cara mengukur keberhasilan. Tandai 2 ide paling realistis untuk dijalankan bulan ini.'},
  {id:'bp10', icon:'bulb', title:'Key messages', body:'Rumuskan key messages untuk {{topik}} dengan audiens {{audiens}}.\n\nBerikan: 1 pesan utama (maks. 20 kata), 3 pesan pendukung masing-masing dengan bukti/data, kalimat yang sebaiknya dihindari, dan contoh kutipan untuk juru bicara.'},
  {id:'bp11', icon:'chat', title:'Media Q&A prep', body:'Siapkan antisipasi pertanyaan wartawan tentang {{topik}} untuk {{juru_bicara}}.\n\nBuat 10 pertanyaan paling mungkin (termasuk yang sulit/menjebak) dan jawaban singkat yang aman, konsisten dengan key messages, serta catatan hal yang tidak boleh dijanjikan.'},
  {id:'bp12', icon:'shield', title:'Crisis holding statement', body:'Isu sensitif sedang berkembang: {{situasi}}.\n\nBuat: (1) holding statement 3–4 kalimat yang empatik dan faktual, (2) daftar fakta yang perlu dipastikan dulu, (3) langkah 24 jam pertama, (4) kanal dan juru bicara yang tepat, (5) hal yang harus dihindari.'},
  {id:'bp15', icon:'users', title:'Stakeholder map', body:'Petakan pemangku kepentingan untuk {{isu_atau_program}}.\n\nBuat tabel: pemangku kepentingan, kepentingan/posisi, pengaruh (tinggi/rendah), sikap saat ini (mendukung/netral/menentang), pesan kunci yang tepat, kanal, dan PIC. Lalu kelompokkan ke matriks pengaruh × dukungan dan beri prioritas pendekatan.'},
  {id:'bp16', icon:'file', title:'Executive briefing note', body:'Buat nota singkat (maks. 1 halaman) untuk {{pimpinan}} tentang {{topik}}.\n\nStruktur: Inti (2 kalimat), Situasi terkini (angka kunci dari data/monitoring), Implikasi, Opsi respons beserta untung-rugi, Rekomendasi, dan Keputusan yang dibutuhkan dari pimpinan.'},
  {id:'bp1', icon:'clock', title:'Daily brief', body:'Prepare a daily brief on {{topic}} for {{audience}}.\n\nUse these sections: Summary (3 bullets), Key developments, Why it matters, Recommended actions. Use internal knowledge where relevant and cite it.'},
  {id:'bp2', icon:'users', title:'Meeting minutes', body:'Turn these meeting notes into formal minutes with: attendees, agenda, discussion summary, decisions, and an action-item table (task, owner, deadline).\n\nNotes:\n{{notes}}'},
  {id:'bp3', icon:'scale', title:'Policy memo', body:'Write a policy memo to {{recipient}} about {{issue}}.\n\nStructure: Purpose, Background, Options (with pros and cons), Recommendation, Next steps. Keep it under one page. Base the background on internal knowledge where possible.'},
  {id:'bp4', icon:'file', title:'Summarize a document', body:'Summarize the attached document for {{audience}}. Give the key points, decisions, numbers worth remembering, and open questions.'},
  {id:'bp5', icon:'chart', title:'Dashboard from data', body:'Build an interactive dashboard canvas from this data. Pick the right charts, add a short insights panel, and make it print-friendly.\n\nData:\n{{data}}'},
  {id:'bp6', icon:'languages', title:'Formal translation', body:'Translate the text below into {{language}}. Keep a formal, official tone and preserve names, numbers and formatting.\n\n{{text}}'},
  {id:'bp7', icon:'megaphone', title:'Press release', body:'Draft a press release announcing {{announcement}}. Include a headline, a dateline, a lead paragraph, a quote from {{spokesperson}}, and boilerplate.'},
  {id:'bp8', icon:'mail', title:'Reply to an email', body:'Draft a reply to this email. Tone: {{tone}}. Goal: {{goal}}.\n\nEmail:\n{{email}}'},
];
const BUILTIN_SKILLS = [
  {id:'bs6', name:'Communications analyst', description:'Media monitoring, issue framing and strategic communication advice (on by default)', builtin:true, defaultOn:true,
   content:'When the user works on media coverage, public issues, campaigns or communication strategy: think like a senior government communications analyst. Separate facts from narratives; name stakeholders and their interests; assess reputational risk with reasons; tie recommendations to evidence (coverage numbers, sentiment, outlets, quotes); propose concrete actions with owner, channel and timing; suggest key messages and spokespeople; flag what must be verified before speaking publicly. Keep tone professional and neutral; never invent quotes or figures.'},
  {id:'bs1', name:'Formal Indonesian', description:'Official, EYD-compliant Bahasa Indonesia for government documents', builtin:true,
   content:'When the user writes in Indonesian or asks for an Indonesian document, write in formal Bahasa Indonesia that follows PUEBI/EYD: standard vocabulary (bahasa baku), correct capitalization of official titles and institutions, no slang or English loanwords when an Indonesian term exists, and a polite official register (Bapak/Ibu). For letters and memos, follow common Indonesian government formats (Nomor, Lampiran, Hal, salutation, closing).'},
  {id:'bs2', name:'Executive brief', description:'Bottom-line-up-front writing for busy decision makers', builtin:true,
   content:'When asked for a brief, summary or recommendation: start with the bottom line in one or two sentences, then at most five supporting bullets, then risks and next steps. Prefer numbers and concrete names over adjectives. Flag uncertainty explicitly. Keep it to one screen unless asked for more.'},
  {id:'bs3', name:'Data analyst', description:'Careful analysis of tables and CSV files, with charts', builtin:true,
   content:'When the user provides tabular data: first describe the dataset (rows, columns, time range, obvious data-quality issues). Compute the specific statistics needed rather than eyeballing. State caveats. When a chart would help, offer to build a dashboard canvas. Never invent numbers that are not in the data.'},
  {id:'bs4', name:'Meeting secretary', description:'Consistent minutes and action-item tables', builtin:true,
   content:'When given meeting notes or a transcript, produce minutes with: title, date, attendees, agenda items, discussion summary per item, decisions, and an action-item table with columns Task | Owner | Deadline | Status. Mark anything unclear as [to confirm] instead of guessing.'},
];

/* ================= Server API ================= */
async function api(path, {method='GET', body, raw, headers={}, quiet}={}) {
  const opts={method, headers:{...headers}};
  if(method!=='GET') opts.headers['x-canopus']='1';
  if(raw!==undefined) opts.body=raw; else if(body!==undefined){ opts.headers['content-type']='application/json'; opts.body=JSON.stringify(body); }
  const r=await fetch(path, opts);
  const ct=r.headers.get('content-type')||''; const data=ct.includes('json')?await r.json().catch(()=>null):await r.text();
  if(r.status===401 && !path.startsWith('/api/auth')){ if(!quiet) showLogin('Your session has ended. Please sign in again.'); throw Object.assign(new Error('Please sign in'),{status:401}); }
  if(!r.ok) throw Object.assign(new Error(data?.error||('HTTP '+r.status)),{status:r.status});
  return data;
}

/* ================= State ================= */
const DEFAULT = { v:4, instructions:'', theme:'dark', model:null, mode:'auto', web:false, knowledge:true,
  spaces:[], chats:[], current:null, canvases:[], files:[], prompts:[], skills:[], sort:'new', panelW:null };
let state = structuredClone(DEFAULT);
let me = null; // {user, groups, config, budget, orgSkills, orgPrompts}
let knowledge = []; // collections visible to this user
let saveT, saving=false, dirty=false;
function save(){ dirty=true; clearTimeout(saveT); saveT=setTimeout(flush, 600); }
async function flush(){
  if(saving||!dirty||!me) return; saving=true; dirty=false;
  try{ await api('/api/me/state',{method:'PUT', raw:JSON.stringify(state), headers:{'content-type':'application/json'}, quiet:true}); }
  catch(e){ dirty=true; if(e.status!==401) toast('Could not save your workspace: '+e.message, 4000); }
  finally{ saving=false; if(dirty) save(); }
}
addEventListener('beforeunload', e=>{ if(dirty||saving){ flush(); e.preventDefault(); } });

/* ================= Helpers ================= */
const $=s=>document.querySelector(s);
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
function toast(t,ms=2400){ const el=$('#toast'); el.textContent=t; el.classList.add('show'); clearTimeout(toast.t); toast.t=setTimeout(()=>el.classList.remove('show'),ms); }
function esc(s){ return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDate(ts){ const d=new Date(ts); return `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; }
function fmtDT(ts){ const d=new Date(ts); return `${fmtDate(ts)} ${d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}`; }
function ago(ts){ const s=(Date.now()-ts)/1000; if(s<60) return 'just now'; if(s<3600) return Math.floor(s/60)+'m ago'; if(s<86400) return Math.floor(s/3600)+'h ago'; if(s<604800) return Math.floor(s/86400)+'d ago'; return fmtDate(ts); }
function fmtSize(b){ if(b<1024) return b+' B'; if(b<1048576) return (b/1024).toFixed(1)+' KB'; return (b/1048576).toFixed(1)+' MB'; }
function fmtTok(n){ return n>=1000?(n/1000).toFixed(n>=10000?0:1)+'k':String(n||0); }
const usd = n => '$'+(+n||0).toFixed(n>=100?0:2);
const mode=()=>MODES.find(m=>m.id===state.mode)||MODES[0];
const curChat=()=>state.chats.find(c=>c.id===state.current);
const space=id=>state.spaces.find(s=>s.id===id);
const isAdmin=()=>me?.user.role==='admin';
function ftypeOf(name){ const t=FTYPES.find(t=>t.ext&&t.ext.test(name)); return t?t.id:'doc'; }
const allSkills=()=>[...BUILTIN_SKILLS.map(b=>({...b, enabled:state.skills.find(s=>s.id===b.id)?.enabled ?? !!b.defaultOn})), ...state.skills.filter(s=>!s.builtin)];
const allPrompts=()=>[...(me?.orgPrompts||[]).map(p=>({...p, org:true})), ...state.prompts, ...BUILTIN_PROMPTS.filter(b=>!state.prompts.some(p=>p.id===b.id)&&(me?.config.canvas||b.id!=='bp5'))];
const AUTO={id:'auto', label:'Auto', d:'Picks the best model for each question'};
function currentModel(){ const ms=me?.config.models||[]; if(state.model==='auto'&&me?.config.auto) return AUTO; return ms.find(m=>m.id===state.model) || (me?.config.defaultModel==='auto'&&me?.config.auto?AUTO:ms.find(m=>m.id===me?.config.defaultModel)) || ms[0] || null; }
const PROVIDER={anthropic:'Claude', openai:'OpenAI', local:'On-premise (data stays inside)'};
function downloadText(name,text,type='text/html'){ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([text],{type})); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000); }
const safeName=s=>(String(s).replace(/[^\w\- ]+/g,'').trim()||'canopus').slice(0,60);
document.addEventListener('error', e=>{ if(e.target.tagName==='IMG' && e.target.closest('.src')) e.target.remove(); }, true);

/* ================= Sign-in ================= */
function authCard(inner){ const a=$('#auth'); a.innerHTML=`<div class="auth-card"><div class="logo">${ic('star')}CANOPUS</div>${inner}</div>`; a.hidden=false; $('#app').hidden=true; setTimeout(()=>a.querySelector('input')?.focus(),30); }
function showLogin(msg=''){
  me=null;
  authCard(`<h2>Sign in</h2><p class="s">Your organization's AI workspace.</p>
    <form id="loginForm"><label for="lEmail">Email</label><input id="lEmail" type="email" autocomplete="username" required>
    <label for="lPw">Password</label><input id="lPw" type="password" autocomplete="current-password" required>
    <button class="btn primary" type="submit">Sign in</button><div class="auth-err" id="authErr">${esc(msg)}</div></form>
    <div class="auth-foot">No account or forgot your password? Ask your administrator for a new invitation link.</div>`);
  $('#loginForm').onsubmit=async e=>{ e.preventDefault(); const b=e.submitter; b.disabled=true; $('#authErr').textContent='';
    try{ const r=await api('/api/auth/login',{method:'POST', body:{email:$('#lEmail').value, password:$('#lPw').value}}); await afterPassword(r); }
    catch(err){ $('#authErr').textContent=err.message; b.disabled=false; } };
}
async function showInvite(token){
  let inv; try{ inv=await api('/api/auth/invite?token='+encodeURIComponent(token)); }catch(e){ history.replaceState(null,'',location.pathname); showLogin(e.message); return; }
  authCard(`<h2>Set your password</h2><p class="s">Welcome${inv.name?', '+esc(inv.name):''}! You're signing in as <b>${esc(inv.email)}</b>.</p>
    <form id="invForm"><label for="iName">Your name</label><input id="iName" value="${esc(inv.name)}" autocomplete="name" required>
    <label for="iPw">New password</label><input id="iPw" type="password" autocomplete="new-password" minlength="10" required>
    <label for="iPw2">Repeat password</label><input id="iPw2" type="password" autocomplete="new-password" required>
    <button class="btn primary" type="submit">Continue</button><div class="auth-err" id="authErr"></div></form>
    <div class="auth-foot">At least 12 characters, with letters and numbers.</div>`);
  $('#invForm').onsubmit=async e=>{ e.preventDefault(); const b=e.submitter; $('#authErr').textContent='';
    if($('#iPw').value!==$('#iPw2').value){ $('#authErr').textContent='The passwords do not match.'; return; }
    b.disabled=true;
    try{ const r=await api('/api/auth/accept',{method:'POST', body:{token, name:$('#iName').value, password:$('#iPw').value}}); history.replaceState(null,'',location.pathname); await afterPassword(r); }
    catch(err){ $('#authErr').textContent=err.message; b.disabled=false; } };
}
// Second sign-in step: a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, …).
async function afterPassword(r){
  if(!r.step) return start(r);
  const enroll=r.step==='enroll';
  authCard(`<h2>${enroll?'Set up two-step verification':'Enter your code'}</h2><p class="s">${enroll?'Required for every account. Scan this code with an authenticator app (Google Authenticator, Microsoft Authenticator, Authy…), then enter the 6-digit code it shows.':'Open your authenticator app and enter the 6-digit code for Canopus.'}</p>
    ${enroll?`<div class="qrbox">${r.qr}</div><div class="auth-foot" style="margin:0 0 6px">Can't scan? Enter this key manually:</div><div class="mono" id="totpSecret" style="text-align:center;font-size:13px;word-break:break-all;user-select:all">${esc(r.secret.replace(/(.{4})/g,'$1 ').trim())}</div>`:''}
    <form id="totpForm"><label for="tCode">6-digit code</label><input id="tCode" inputmode="numeric" autocomplete="one-time-code" maxlength="7" pattern="[0-9 ]*" required>
    <button class="btn primary" type="submit">${enroll?'Turn on and continue':'Verify'}</button><div class="auth-err" id="authErr"></div></form>
    <div class="auth-foot">${enroll?'Keep your phone safe: you will need this code every time you sign in. Lost your phone? Ask your administrator to reset two-step verification.':'Lost your phone? Ask your administrator to reset two-step verification.'}</div>`);
  $('#totpForm').onsubmit=async e=>{ e.preventDefault(); const b=e.submitter; b.disabled=true; $('#authErr').textContent='';
    try{ const me_=await api(enroll?'/api/auth/enroll':'/api/auth/totp',{method:'POST', body:{ticket:r.ticket, code:$('#tCode').value}}); await start(me_); }
    catch(err){ $('#authErr').textContent=err.message; b.disabled=false; if(err.status===401&&/expired/i.test(err.message)) setTimeout(()=>showLogin(err.message),1500); } };
}
async function start(meData){
  me=meData;
  const [st, kn]=await Promise.all([api('/api/me/state'), api('/api/knowledge').catch(()=>[])]);
  state=Object.assign(structuredClone(DEFAULT), st||{});
  if(!st) state.spaces=[{id:'s1', name:'My first space', instructions:'', color:SPACE_COLORS[0], fileIds:[]}];
  for(const c of state.chats) for(const m of c.msgs) if(m.streaming){ m.streaming=false; if(!m.turn?.length) m.error='This reply was interrupted.'; }
  knowledge=kn||[];
  if(!state.model||!me.config.models.some(m=>m.id===state.model)) state.model=me.config.defaultModel;
  document.documentElement.dataset.theme=state.theme;
  $('#auth').hidden=true; $('#app').hidden=false;
  $('#navAdmin').hidden=!isAdmin();
  if(innerWidth<=820) $('#app').classList.add('collapsed');
  route();
}
// Opens a new chat with a file attached and a prompt to complete (used by Reports → Ask in chat).
function chatWith(rec, text=''){ addFileRecord({...rec, ftype:ftypeOf(rec.name), added:Date.now()}); save(); state.current=null; pendingSpace=null; closePanel(); attachments=[{...rec, ftype:ftypeOf(rec.name)}]; go('home'); setTimeout(()=>{ renderChips(); input.value=text; autosize(); input.focus(); },40); }
initReports({ api, esc, ic, hydrateIcons, toast, openModal, closeModal, confirmBox, ask, fmtSize, ago, isAdmin, me:()=>me, refreshMe:()=>refreshMe(), chatWith });
async function refreshMe(){ try{ me=await api('/api/me'); renderSide(); updateTools(); }catch{} }

/* ================= Routing ================= */
const VIEWS=['home','knowledge','reports','studio','sources','prompts','skills','space','admin'];
let spaceId=null, pendingSpace=null, pendingProject=null;
const projectById=id=>me?.projects?.find(p=>p.id===id);
const curView=()=>{ const v=location.hash.slice(1).split('/')[0]||'home'; return VIEWS.includes(v)?v:'home'; };
function route(){
  if(!me) return;
  let v=curView();
  if(v==='space'){ spaceId=location.hash.slice(1).split('/')[1]; if(!space(spaceId)) v='home'; }
  if(v==='admin'&&!isAdmin()) v='home';
  VIEWS.forEach(x=>$('#v-'+x).hidden=x!==v);
  const app=$('#app'); VIEWS.forEach(x=>app.classList.toggle('v-'+x, x===v));
  if(innerWidth<=820) app.classList.add('collapsed');
  if(v!=='home'&&!panel.full) closePanel();
  renderSide(); renderPage(v); renderHead();
}
function go(v){ if(location.hash==='#'+v) route(); else location.hash=v; }
addEventListener('hashchange', ()=>{ if(location.hash.startsWith('#invite=')) return showInvite(location.hash.slice(8)); route(); });
function renderPage(v=curView()){ ({home:renderHome, knowledge:renderKnowledge, reports:()=>renderReports(true), studio:renderStudio, sources:renderSources, prompts:renderPrompts, skills:renderSkills, space:renderSpace, admin:renderAdmin}[v]||renderHome)(); }

/* ================= Sidebar ================= */
function renderSide(){
  const cv=curView(); document.querySelectorAll('.side [data-go]').forEach(b=>b.classList.toggle('active', b.dataset.go===cv && (cv!=='home'||!state.current)));
  $('#projList').innerHTML=(me.projects||[]).map(p=>`<div class="row-item ${pendingProject===p.id&&!state.current?'active':''}" data-project="${p.id}" role="button" title="${esc(p.description||p.name)}">${ic('book','c-sky')}<span>${esc(p.name)}</span><small>${state.chats.filter(c=>c.projectId===p.id).length||''}</small></div>`).join('')||`<div class="empty">${isAdmin()?'Create shared projects in Admin → Projects.':'No shared projects yet.'}</div>`;
  document.querySelector('[data-go=studio]').hidden=!me.config.canvas&&!state.canvases.length;
  $('#spaceList').innerHTML=state.spaces.map(s=>`<div class="row-item ${location.hash==='#space/'+s.id?'active':''}" data-space="${s.id}" role="button"><i class="dotc" style="background:${s.color}"></i><span>${esc(s.name)}</span><small>${state.chats.filter(c=>c.spaceId===s.id).length||''}</small></div>`).join('')||`<div class="empty">Group related chats with shared instructions and files.</div>`;
  const onHome=cv==='home';
  const row=c=>`<div class="row-item ${onHome&&c.id===state.current?'active':''}" data-open="${c.id}" role="button" title="${esc(c.title)}">${c.spaceId&&space(c.spaceId)?`<i class="dotc" style="background:${space(c.spaceId).color}"></i>`:''}<span>${esc(c.title)}</span>${c.msgs.some(m=>m.streaming)?'<i class="live"></i>':''}<button class="mini" data-chatmenu="${c.id}" title="Options">${ic('dots')}</button></div>`;
  const chats=[...state.chats].sort((a,b)=>(b.updated||0)-(a.updated||0));
  const pinned=chats.filter(c=>c.pinned), rest=chats.filter(c=>!c.pinned);
  const day=864e5, t0=new Date().setHours(0,0,0,0);
  const groups=[['Today',c=>c.updated>=t0],['Yesterday',c=>c.updated>=t0-day],['Previous 7 days',c=>c.updated>=t0-7*day],['Previous 30 days',c=>c.updated>=t0-30*day],['Older',()=>true]];
  let html=pinned.length?`<div class="grp">Pinned</div>${pinned.map(row).join('')}`:''; const used=new Set();
  for(const [label,fn] of groups){ const g=rest.filter(c=>!used.has(c.id)&&fn(c)); g.forEach(c=>used.add(c.id)); if(g.length) html+=`<div class="grp">${label}</div>${g.map(row).join('')}`; }
  $('#chatList').innerHTML=html||`<div class="empty">Your conversations will appear here.</div>`;
  const on=allSkills().filter(s=>s.enabled).length+(me.orgSkills?.length||0);
  $('#nStudio').textContent=state.canvases.length||''; $('#nSources').textContent=state.files.length||''; $('#nSkills').textContent=on?on+' on':'';
  $('#nKnow').textContent=knowledge.reduce((a,c)=>a+c.docs.filter(d=>d.status==='ready').length,0)||'';
  const n=me.user.name||me.user.email; $('#userName').textContent=n; $('#avatar').textContent=n.charAt(0).toUpperCase();
  const b=me.budget; const pct=b.limit>0?Math.min(100,b.spent/b.limit*100):0;
  $('#budgetText').textContent=b.limit>0?`${usd(b.spent)} of ${usd(b.limit)} this month`:`${usd(b.spent)} used this month`;
  $('#budgetBar').hidden=!(b.limit>0); $('#budgetBar i').style.width=pct+'%'; $('#budgetBar').classList.toggle('warn', pct>=90);
}
function renderHead(){
  const c=curChat(); const h=$('#chatHead');
  if(curView()!=='home'||!c){ h.innerHTML=''; return; }
  const sp=space(c.spaceId);
  const pj=projectById(c.projectId);
  h.innerHTML=`<span class="t" data-act="renamechat" title="Rename">${esc(c.title)}</span>${pj?`<span class="space-chip" data-project="${pj.id}">${ic('book','c-sky')}${esc(pj.name)}</span>`:''}${sp?`<span class="space-chip" data-space="${sp.id}"><i style="background:${sp.color}"></i>${esc(sp.name)}</span>`:''}
    <div class="top-acts"><button class="icon-btn ${c.pinned?'pinned':''}" data-act="pinchat" title="${c.pinned?'Unpin':'Pin'}">${ic('pin')}</button><button class="icon-btn hide-m" data-act="exportchat" title="Export as Markdown">${ic('download')}</button><button class="icon-btn" data-chatmenu="${c.id}" title="More">${ic('dots')}</button></div>`;
}

/* ================= Composer ================= */
$('#composerHomeSlot').append($('#composerTpl').content.cloneNode(true));
hydrateIcons();
const input=$('#input');
function placeComposer(chatting){
  const slot=chatting?$('#composerChatSlot'):$('#composerHomeSlot');
  if(!slot.contains($('#composer'))) slot.append($('#keybar'),$('#composer'),$('#hint'));
  $('#composerChatSlot').hidden=!chatting; $('#hint').hidden=!chatting;
}
function updateTools(){
  if(!me) return;
  const m=currentModel(); const tick=`<span class="tick">${ic('check')}</span>`;
  $('#modelLabel').textContent=m?m.label:'No model';
  $('#modeLabel').textContent=mode().name;
  $('#webBtn').hidden=!me.config.webSearch; $('#webBtn').classList.toggle('on', !!state.web&&me.config.webSearch);
  $('#knowBtn').classList.toggle('on', state.knowledge!==false);
  $('#keybar').hidden=!!me.config.apiConfigured;
  const b=me.budget; const warn=[...(b.limit>0&&b.spent>=b.limit*.8?[`You have used ${Math.round(b.spent/b.limit*100)}% of your monthly AI budget (${usd(b.spent)} of ${usd(b.limit)}).`]:[]), ...(b.groups||[]).filter(g=>g.spent>=g.limit*.8).map(g=>`Group “${g.name}” has used ${Math.round(g.spent/g.limit*100)}% of its monthly budget.`)];
  let bn=$('#budgetWarn'); if(!bn){ bn=document.createElement('div'); bn.id='budgetWarn'; bn.className='notice'; $('#composer').before(bn); }
  bn.hidden=!warn.length; bn.innerHTML=warn.length?`${ic('clock')}<span>${esc(warn.join(' '))}</span>`:'';
  let mh=me.config.auto?`<button type="button" data-model="auto" class="${m?.id==='auto'?'sel':''}"><div>Auto <span class="badge gold" style="margin-left:4px">Recommended</span><small>${esc(AUTO.d)} — cheaper for simple tasks</small></div>${tick}</button>`:''; let grp='';
  for(const x of me.config.models){ if(x.provider!==grp){ grp=x.provider; mh+=`<div class="m-h">${PROVIDER[grp]||grp}</div>`; } mh+=`<button type="button" data-model="${x.id}" class="${m&&x.id===m.id?'sel':''}"><div>${esc(x.label)}<small>${esc(x.d)}</small></div>${tick}</button>`; }
  $('#modelMenu').innerHTML=mh;
  $('#modeMenu').innerHTML=MODES.map(x=>`<button type="button" data-mode="${x.id}" class="${x.id===state.mode?'sel':''}"><div>${x.name}<small>${x.d}</small></div>${tick}</button>`).join('');
  updateSend();
}
let attachments=[];
function updateSend(){
  const chat=curChat(); const busy=chat&&running.has(chat.id);
  const s=$('#send'); s.classList.toggle('stop',!!busy); s.classList.toggle('ready',!busy&&(input.value.trim().length>0||attachments.length>0));
  s.innerHTML=busy?ic('stop'):ic('arrowUp'); s.title=busy?'Stop':'Send';
}
function autosize(){ input.style.height='auto'; input.style.height=Math.min(input.scrollHeight,240)+'px'; updateSend(); }
input.addEventListener('input',()=>{ autosize(); if(input.value==='/'){ input.value=''; autosize(); pickPrompt(); } });
input.addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){ e.preventDefault(); $('#composer').requestSubmit(); } });
input.addEventListener('paste',async e=>{ const files=[...e.clipboardData.files]; if(files.length){ e.preventDefault(); await addAttachments(files); } });

/* ---- uploads: images are resized in the browser, then everything is stored on the server ---- */
async function prepareImage(file){
  const url=URL.createObjectURL(file); const img=new Image(); img.src=url; await img.decode();
  const max=1568, w=img.naturalWidth, h=img.naturalHeight; let out=file;
  if(w>max||h>max||file.size>3.5e6||!/^image\/(png|jpeg|gif|webp)$/.test(file.type)){
    const s=Math.min(1,max/Math.max(w,h)); const c=document.createElement('canvas'); c.width=Math.round(w*s); c.height=Math.round(h*s);
    c.getContext('2d').drawImage(img,0,0,c.width,c.height); const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',.88)); out=new File([blob], file.name.replace(/\.\w+$/,'')+'.jpg', {type:'image/jpeg'});
  }
  const t=document.createElement('canvas'); const ts=Math.min(1,96/Math.max(w,h)); t.width=Math.max(1,Math.round(w*ts)); t.height=Math.max(1,Math.round(h*ts));
  t.getContext('2d').drawImage(img,0,0,t.width,t.height); URL.revokeObjectURL(url);
  return {file:out, thumb:t.toDataURL('image/jpeg',.7)};
}
async function uploadFile(file){
  let f=file, thumb=null;
  if(/^image\//.test(file.type)||/\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(file.name)){ try{ ({file:f, thumb}=await prepareImage(file)); }catch{} }
  const r=await api('/api/blobs',{method:'POST', raw:f, headers:{'content-type':f.type||'application/octet-stream', 'x-filename':encodeURIComponent(f.name)}});
  return {id:r.id, name:r.name, mime:r.mime, size:r.size, kind:r.kind, ftype:r.kind==='image'?'img':ftypeOf(r.name), thumb, added:Date.now()};
}
function renderChips(){
  $('#chips').innerHTML=attachments.map((a,i)=>`<span class="chip" title="${esc(a.name)}"><span class="ai">${a.uploading?ic('clock'):a.thumb?`<img src="${a.thumb}" alt="">`:ic(a.kind==='image'?'image':a.kind==='text'?'text':'file')}</span><span>${esc(a.name)}<small>${a.uploading?'Uploading…':fmtSize(a.size)}</small></span><button type="button" data-rmchip="${i}" title="Remove">${ic('x')}</button></span>`).join('');
  updateSend();
}
async function addAttachments(list){
  for(const f of list){
    const tmp={name:f.name, size:f.size, uploading:true}; attachments.push(tmp); renderChips();
    try{ const rec=await uploadFile(f); Object.assign(tmp, rec, {uploading:false}); }
    catch(e){ attachments=attachments.filter(a=>a!==tmp); toast(`${f.name}: ${e.message}`, 4500); }
    renderChips();
  }
  input.focus();
}
$('#file').addEventListener('change',async e=>{ const f=[...e.target.files]; e.target.value=''; await addAttachments(f); });
const comp=$('#composer');
['dragenter','dragover'].forEach(t=>comp.addEventListener(t,e=>{ e.preventDefault(); comp.classList.add('drag'); }));
['dragleave','drop'].forEach(t=>comp.addEventListener(t,e=>{ e.preventDefault(); comp.classList.remove('drag'); }));
comp.addEventListener('drop',e=>{ if(e.dataTransfer.files.length) addAttachments([...e.dataTransfer.files]); });
function addFileRecord(rec){ if(!state.files.some(f=>f.id===rec.id)){ const {uploading, ...meta}=rec; state.files.unshift(meta); } }
comp.addEventListener('submit',async e=>{
  e.preventDefault();
  let chat=curChat();
  if(chat&&running.has(chat.id)){ running.get(chat.id).abort(); return; }
  if(attachments.some(a=>a.uploading)){ toast('Wait for the upload to finish'); return; }
  const text=input.value.trim(); if(!text&&!attachments.length) return;
  const atts=[...attachments]; atts.forEach(addFileRecord);
  if(!chat){ chat={id:uid(), title:(text||atts[0]?.name||'New chat').split('\n')[0].slice(0,60), msgs:[], pinned:false, created:Date.now(), updated:Date.now(), spaceId:pendingSpace||null, projectId:pendingProject||null}; state.chats.unshift(chat); state.current=chat.id; pendingSpace=null; pendingProject=null; }
  chat.msgs.push({r:'user', text, refs:atts.map(a=>a.id), atts:atts.map(a=>({name:a.name, kind:a.kind, thumb:a.thumb}))});
  input.value=''; attachments=[]; renderChips(); autosize();
  if(curView()!=='home') go('home');
  respond(chat);
});

/* ================= Home ================= */
function renderHome(){
  const c=curChat(); placeComposer(!!c);
  $('#home').hidden=!!c; $('#thread').hidden=!c;
  updateTools();
  if(c){ renderThread(); return; }
  const d=new Date(); const hr=d.getHours(); const g=hr<11?'Good morning':hr<15?'Good afternoon':'Good evening';
  $('#today').textContent=d.toLocaleDateString('en-US',{weekday:'long', month:'long', day:'numeric'});
  const n=(me.user.name||'').split(' ')[0];
  $('#greet').innerHTML=n?`${g}, <em>${esc(n)}</em>`:'What are we working on today?';
  input.placeholder=pendingProject&&projectById(pendingProject)?`Ask within “${projectById(pendingProject).name}”…`:pendingSpace&&space(pendingSpace)?`New chat in ${space(pendingSpace).name}…`:'Ask anything, or type / for prompts';
  const recent=[...state.chats].sort((a,b)=>(b.updated||0)-(a.updated||0)).slice(0,3);
  const works=[...state.canvases].sort((a,b)=>b.updated-a.updated).slice(0,3);
  const docs=knowledge.reduce((a,c)=>a+c.docs.filter(x=>x.status==='ready').length,0);
  let h='';
  if(docs) h+=`<div class="notice info" style="margin-top:14px">${ic('book')}<span>Canopus can search <b>${docs} internal document${docs>1?'s':''}</b> you have access to, and cites them in its answers.</span><button class="btn sm" data-go="knowledge">View</button></div>`;
  if(me.projects?.length) h+=`<div class="hsec"><div class="hsec-h">${ic('book')}Projects</div><div class="cont">${me.projects.slice(0,6).map(p=>`<button class="cc" data-project="${p.id}"><b>${esc(p.name)}</b><p>${esc(p.description||'Shared project with its own instructions and knowledge.')}</p><small>${p.collections?p.collections+' knowledge collection'+(p.collections>1?'s':''):'All your knowledge'}</small></button>`).join('')}</div></div>`;
  h+=`<div class="hsec"><div class="hsec-h">${ic('chart')}Strategic reports<a data-go="reports">Open Reports →</a></div><div class="cont"><button class="cc" data-go="reports"><b>Curate monitoring data</b><p>Upload Excel or CSV: clean it, label sentiment and issues, summarize.</p></button><button class="cc" data-go="reports"><b>Build a strategy deck</b><p>Claude analyzes, GPT polishes, on your PowerPoint template.</p></button><button class="cc" data-useprompt="bp9"><b>Analyze an issue</b><p>Stakeholders, narratives, risk and recommended actions.</p></button></div></div>`;
  h+=`<div class="hsec"><div class="hsec-h">${ic('bolt')}Quick start<a data-go="prompts">All prompts →</a></div><div class="qs">${allPrompts().slice(0,4).map(p=>`<button class="q" data-useprompt="${p.id}">${ic(p.icon||'bolt')}<b>${esc(p.title)}</b><small>${esc(p.body.replace(/\{\{[^}]+\}\}/g,'…').replace(/…\./g,'…').split('\n')[0].slice(0,80))}</small></button>`).join('')}</div></div>`;
  if(recent.length) h+=`<div class="hsec"><div class="hsec-h">${ic('clock')}Continue<a data-act="search">Search all →</a></div><div class="cont">${recent.map(c=>{ const last=[...c.msgs].reverse().find(m=>m.r==='assistant'&&botText(m)); return `<button class="cc" data-open="${c.id}"><b>${esc(c.title)}</b><p>${esc((last?botText(last):c.msgs[0]?.text||'').replace(/```[\s\S]*?```/g,'[canvas]').replace(/[#*`>|_]+/g,' ').slice(0,160))}</p><small>${ago(c.updated)}</small></button>`; }).join('')}</div></div>`;
  if(works.length&&me.config.canvas) h+=`<div class="hsec"><div class="hsec-h">${ic('layers')}Recent in Studio<a data-go="studio">Open Studio →</a></div><div class="mini-cards">${works.map(cardHTML).join('')}</div></div>`;
  $('#homeSections').innerHTML=h; fillThumbs($('#homeSections'));
}

/* ================= Thread ================= */
const HTML_BLOCK=/```html[^\n]*\n([\s\S]*?)```/g;
const mdHTML=text=>DOMPurify.sanitize(marked.parse(text,{gfm:true, breaks:false}));
function botText(m){ if(m.display!=null) return m.display; return (m.turn||[]).filter(x=>x.role==='assistant').flatMap(x=>x.content).filter(b=>b.type==='text').map(b=>b.text).join(''); }
function bodyHTML(m){
  let text=m.streaming?(m.live||''):botText(m); let n=0, building=false;
  text=text.replace(HTML_BLOCK,()=>`\n\n%%CANVAS${n++}%%\n\n`);
  const open=text.indexOf('```html'); if(open>=0){ text=text.slice(0,open); building=true; }
  let html=text.trim()?mdHTML(text):'';
  html=html.replace(/<p>%%CANVAS(\d+)%%<\/p>|%%CANVAS(\d+)%%/g,(_,a,b)=>{
    const ref=m.canvasRefs?.[+(a??b)]; const cv=ref&&state.canvases.find(c=>c.id===ref.id);
    if(!cv) return `<div class="cv-card building"><div class="cv-ic">${ic('sparkle')}</div><div><b>Canvas ready</b><small>Saving to Studio…</small></div></div>`;
    return `<div class="cv-card" data-copen="${cv.id}" data-v="${ref.v}" role="button"><div class="cv-ic">${ic('chart')}</div><div><b>${esc(cv.title)}</b><small>Version ${ref.v+1}${cv.versions.length>ref.v+1?` of ${cv.versions.length}`:''} · saved to Studio</small></div><span class="btn sm primary">${ic('eye')}View</span></div>`;
  });
  if(building) html+=`<div class="cv-card building" data-act="showbuild" role="button"><div class="cv-ic">${ic('sparkle')}</div><div><b class="shimmer">Building your canvas…</b><small>Watch it come together in the side panel</small></div></div>`;
  return html;
}
function hostOf(u){ try{ return new URL(u).hostname.replace(/^www\./,''); }catch{ return u; } }
function docRef(source){ const m=String(source||'').match(/^canopus:doc\/([^#]+)(?:#page=(\d+))?/); return m?{docId:m[1], page:m[2]?+m[2]:null}:null; }
function citesHTML(m,i){
  const cites=(m.citations||[]).filter(c=>c.kind==='doc'); const webs=(m.citations||[]).filter(c=>c.kind==='web');
  const seen=new Map(); for(const c of cites){ const k=c.title; if(!seen.has(k)) seen.set(k,{...c, n:0}); seen.get(k).n++; }
  let h='';
  if(seen.size) h+=`<div class="cites"><div class="cites-h">${ic('book')}Sources from internal knowledge</div>${[...seen.values()].map((c,j)=>`<button class="cite" data-cite="${i}:${(m.citations||[]).indexOf(cites.find(x=>x.title===c.title))}">${ic('file')}<span>${esc(c.title)}</span></button>`).join('')}</div>`;
  else if(m.found?.length) h+=`<div class="cites"><div class="cites-h">${ic('book')}Internal documents consulted</div>${[...new Map(m.found.map(f=>[f.title+'|'+(f.page||''),f])).values()].slice(0,8).map((f,j)=>`<button class="cite" data-found="${i}:${m.found.indexOf(f)}">${ic('file')}<span>${esc(f.title)}${f.page?' — p. '+f.page:''}</span></button>`).join('')}</div>`;
  if(webs.length) h+=`<div class="sources">${[...new Map(webs.map(w=>[w.url,w])).values()].slice(0,10).map(w=>`<a class="src" href="${esc(w.url)}" target="_blank" rel="noopener noreferrer"><img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostOf(w.url))}&sz=32" alt=""><span>${esc(w.title||hostOf(w.url))}</span></a>`).join('')}</div>`;
  return h;
}
function botInner(m,i,isLast){
  let h='';
  if(m.thinking) h+=`<details class="think" data-think="${i}" ${m.thinkOpen?'open':''}><summary>${ic('chevRight','chv')}${ic('bulb')}<span class="${m.streaming&&!m.live?'shimmer':''}">${m.streaming&&!m.live?'Thinking…':'Thought process'}</span></summary><div class="tx">${esc(m.thinking)}</div></details>`;
  if(m.streaming&&m.status) h+=`<div class="status">${ic(/web/i.test(m.status)?'globe':'book')}<span class="shimmer">${esc(m.status)}</span></div>`;
  let body=bodyHTML(m);
  if(body&&!m.streaming&&m.provider==='openai'&&m.citations?.length) body=body.replace(/\[(\d{1,2})\](?![^<]*<\/a>)/g,(x,n)=>{ const j=m.citations.findIndex(c=>c.n===+n); return j<0?x:`<button class="cn" data-cite="${i}:${j}" title="${esc(m.citations[j].title)}">${n}</button>`; });
  if(body) h+=`<div class="md">${body}</div>`;
  else if(m.streaming&&!m.thinking&&!m.status) h+=`<span class="typing"><span></span><span></span><span></span></span>`;
  if(m.stop==='refusal') h+=`<div class="err">${ic('x')}<div>Canopus can't help with that request. Try rephrasing it.</div></div>`;
  if(m.error) h+=`<div class="err">${ic('x')}<div>${esc(m.error)}</div></div>`;
  if(!m.streaming){
    h+=citesHTML(m,i);
    const u=m.usage; const usage=u&&(u.in||u.out)?` · ${fmtTok(u.in)} in · ${fmtTok(u.out)} out`:'';
    const r=m.route; const routeTxt=r?.auto?`Auto → ${esc(m.modelName||'')}${r.category?` · ${esc(me.config.categories?.[r.category]?.label||r.category)}`:''}`:esc(m.modelName||'');
    const fo=r?.failover?` · switched from ${esc(r.failover.from)} (${esc(r.failover.reason)})`:'';
    h+=`<div class="acts">${botText(m)?`<button class="icon-btn" title="Copy" data-copy="${i}">${ic('copy')}</button>`:''}${isLast?`<button class="icon-btn" title="Regenerate" data-act="regen">${ic('refresh')}</button>`:''}<span class="meta" title="${r?.auto?esc('Chosen automatically: '+(r.reason||'')):''}">${routeTxt}${m.modeName?' · '+esc(m.modeName):''}${fo}${m.stopped?' · stopped':''}${usage}</span></div>`;
  }
  return h;
}
let editing=-1;
function userHTML(m,i){
  if(editing===i) return `<div class="edit-box"><textarea id="editIn">${esc(m.text)}</textarea><div><button class="btn sm" data-act="canceledit">Cancel</button><button class="btn sm primary" data-act="saveedit">Save & resend</button></div></div>`;
  const atts=(m.atts||[]).map(a=>a.kind==='image'&&a.thumb
    ? `<div class="att" style="padding:4px"><img src="${a.thumb}" alt="" style="width:46px;height:46px;border-radius:7px;object-fit:cover"><span style="max-width:140px">${esc(a.name)}</span></div>`
    : `<div class="att"><div class="ai">${ic(a.kind==='text'?'text':'file')}</div><span>${esc(a.name)}</span></div>`).join('');
  return `${atts?`<div class="atts">${atts}</div>`:''}${m.text?`<div class="bubble">${esc(m.text)}</div>`:''}<div class="me-acts"><button class="icon-btn" title="Edit" data-edit="${i}">${ic('edit')}</button><button class="icon-btn" title="Copy" data-copyu="${i}">${ic('copy')}</button></div>`;
}
function renderThread(){
  const chat=curChat(); if(!chat) return;
  const lastBot=chat.msgs.map(m=>m.r).lastIndexOf('assistant');
  $('#threadIn').innerHTML=chat.msgs.map((m,i)=>m.r==='user'?`<div class="msg me" id="m-${i}">${userHTML(m,i)}</div>`:`<div class="msg bot ${m.streaming?'busy':''}" id="m-${i}"><div class="b-ic">${ic('star')}</div><div class="b-body">${botInner(m,i,i===lastBot)}</div></div>`).join('');
  decorate($('#threadIn')); const th=$('#thread'); th.scrollTop=th.scrollHeight;
  if(editing>=0) setTimeout(()=>$('#editIn')?.focus(),20);
}
function decorate(root){ root.querySelectorAll('.md pre').forEach(pre=>{ if(pre.querySelector('.cp')) return; const b=document.createElement('button'); b.className='cp'; b.type='button'; b.textContent='Copy'; b.dataset.cp='1'; pre.appendChild(b); }); }
let paintQ=new Set(), paintRAF=0;
function paint(chat,i){
  if(chat.id!==state.current||curView()!=='home') return;
  paintQ.add(i); if(paintRAF) return;
  paintRAF=requestAnimationFrame(()=>{
    paintRAF=0; const th=$('#thread'); const stick=th.scrollHeight-th.scrollTop-th.clientHeight<140;
    for(const j of paintQ){ const el=document.querySelector(`#m-${j} .b-body`); const m=chat.msgs[j]; if(el&&m){ el.innerHTML=botInner(m,j,j===chat.msgs.length-1); el.parentElement.classList.toggle('busy',!!m.streaming); decorate(el);} }
    paintQ.clear(); if(stick) th.scrollTop=th.scrollHeight;
    const m=chat.msgs[i];
    if(m?.streaming){ const t=m.live||''; const k=t.lastIndexOf('```html'); if(k>=0&&t.indexOf('```',k+7)<0){ if(!panel.build||panel.build.chatId!==chat.id) openBuild(chat.id); panel.build.code=t.slice(t.indexOf('\n',k)+1); updateBuild(); } }
  });
}

/* ================= Canvas sandbox & panel ================= */
// Canvases run in /sandbox.html: a separate, sandboxed page with no access to this app or the network.
const frameHtml=new WeakMap(); // iframe element -> html it should show
addEventListener('message', e=>{
  if(e.data!=='canopus-sandbox-ready') return;
  for(const f of document.querySelectorAll('iframe[data-sandbox]')) if(f.contentWindow===e.source&&frameHtml.has(f)){ e.source.postMessage(frameHtml.get(f),'*'); break; }
});
function sandboxFrame(html, cls='', title=''){ const f=document.createElement('iframe'); f.dataset.sandbox='1'; f.setAttribute('sandbox','allow-scripts allow-popups allow-modals allow-forms'); f.title=title; if(cls) f.className=cls; frameHtml.set(f, html); f.src='/sandbox.html'; return f; }
const panel={cid:null, v:0, tab:'preview', build:null, full:false};
function openCanvas(cid,v){ const c=state.canvases.find(x=>x.id===cid); if(!c) return; panel.cid=cid; panel.v=v??c.versions.length-1; panel.tab='preview'; panel.build=null; renderPanel(); }
function openBuild(chatId){ panel.build={chatId, code:''}; panel.cid=null; renderPanel(); }
function closePanel(){ panel.cid=null; panel.build=null; panel.full=false; const p=$('#panel'); p.hidden=true; p.innerHTML=''; p.classList.remove('full'); }
function renderPanel(){
  const p=$('#panel'); p.hidden=false; p.classList.toggle('full', panel.full);
  if(state.panelW&&innerWidth>820) p.style.setProperty('--pw', state.panelW+'px');
  if(panel.build){ p.innerHTML=`<div class="split"></div><div class="panel-head">${ic('sparkle','c-gold')}<b class="shimmer">Building canvas…</b><button class="icon-btn" data-act="closepanel" title="Close">${ic('x')}</button></div><div class="panel-body"><pre id="buildCode"></pre></div>`; updateBuild(); return; }
  const c=state.canvases.find(x=>x.id===panel.cid); if(!c){ closePanel(); return; }
  const html=c.versions[panel.v].html; const hasChat=c.chatId&&state.chats.some(x=>x.id===c.chatId);
  p.innerHTML=`<div class="split"></div><div class="panel-head"><b title="${esc(c.title)}">${esc(c.title)}</b>
    ${c.versions.length>1?`<select class="vsel" id="vsel" title="Version">${c.versions.map((x,i)=>`<option value="${i}" ${i===panel.v?'selected':''}>v${i+1}${i===c.versions.length-1?' · latest':''}</option>`).join('')}</select>`:''}
    <div class="seg"><button data-ptab="preview" class="${panel.tab==='preview'?'on':''}">Preview</button><button data-ptab="code" class="${panel.tab==='code'?'on':''}">Code</button></div>
    <div class="drop"><button class="icon-btn" data-menu="panelMenu" title="More">${ic('dots')}</button><div class="menu right down" id="panelMenu" style="min-width:200px">
      <button data-cdl="${c.id}">${ic('download')}Download HTML</button><button data-act="copycode">${ic('copy')}Copy code</button>${hasChat&&(curView()!=='home'||state.current!==c.chatId)?`<button data-cchat="${c.id}">${ic('chat')}Open its chat</button>`:''}</div></div>
    <button class="icon-btn" data-act="fullpanel" title="${panel.full?'Exit full screen':'Full screen'}">${ic('expand')}</button><button class="icon-btn" data-act="closepanel" title="Close">${ic('x')}</button></div>
    <div class="panel-body"></div>`;
  const body=p.querySelector('.panel-body');
  if(panel.tab==='preview') body.append(sandboxFrame(html,'',c.title)); else { const pre=document.createElement('pre'); pre.textContent=html; body.append(pre); }
}
function updateBuild(){ const pre=$('#buildCode'); if(pre&&panel.build){ pre.textContent=panel.build.code; pre.scrollTop=pre.scrollHeight; } }
document.addEventListener('pointerdown',e=>{
  if(!e.target.classList?.contains('split')) return;
  const p=$('#panel'), sp=e.target; sp.classList.add('drag'); p.querySelector('iframe')?.style.setProperty('pointer-events','none');
  const move=ev=>{ const w=Math.min(innerWidth*.72,Math.max(340,p.getBoundingClientRect().right-ev.clientX)); p.style.setProperty('--pw',w+'px'); state.panelW=Math.round(w); };
  const up=()=>{ sp.classList.remove('drag'); p.querySelector('iframe')?.style.removeProperty('pointer-events'); removeEventListener('pointermove',move); removeEventListener('pointerup',up); save(); };
  addEventListener('pointermove',move); addEventListener('pointerup',up);
});

/* ================= Talking to the server ================= */
const running=new Map();
function spaceRefs(chat){ const sp=space(chat.spaceId); return (sp?.fileIds||[]).filter(id=>state.files.some(f=>f.id===id)).map(id=>({type:'blob', id})); }
function historyFor(chat, upto){
  const out=[]; const pre=spaceRefs(chat); let first=true;
  for(const m of chat.msgs.slice(0,upto)){
    if(m.r==='user'){ const content=[...(first?pre:[]), ...(m.refs||[]).map(id=>({type:'blob', id})), ...(m.text?[{type:'text', text:m.text}]:[])]; first=false; if(content.length) out.push({role:'user', content}); }
    else if(!m.streaming&&m.turn?.length&&m.stop!=='refusal') out.push({role:'turn', provider:m.provider||'anthropic', messages:m.turn});
  }
  return out;
}
async function respond(chat){
  const M=currentModel(); if(!M){ toast('No AI model is enabled. Ask your administrator.'); return; }
  const sp=space(chat.spaceId);
  const bot={r:'assistant', live:'', thinking:'', found:[], streaming:true, modelName:M.id==='auto'?'Auto':M.label, modeName:mode().name};
  chat.msgs.push(bot); chat.updated=Date.now();
  const idx=chat.msgs.length-1; const ac=new AbortController(); const ctl={abort(){ ctl.aborted=true; ac.abort(); }};
  running.set(chat.id, ctl); renderSide(); if(curView()==='home'&&chat.id===state.current){ renderHead(); renderHome(); }
  const payload={ chatId:chat.id, projectId:chat.projectId||undefined, model:M.id, mode:state.mode, web:!!state.web, knowledge:state.knowledge!==false, messages:historyFor(chat, idx),
    system:{ instructions:state.instructions, spaceName:sp?.name, spaceInstructions:sp?.instructions, skills:allSkills().filter(s=>s.enabled).map(s=>({name:s.name, content:s.content})) } };
  try{
    const r=await fetch('/api/chat',{method:'POST', signal:ac.signal, headers:{'content-type':'application/json','x-canopus':'1'}, body:JSON.stringify(payload)});
    if(r.status===401){ showLogin('Your session has ended. Please sign in again.'); throw new Error('Please sign in'); }
    if(!r.ok){ const j=await r.json().catch(()=>({})); throw new Error(j.error||('HTTP '+r.status)); }
    const reader=r.body.getReader(); const dec=new TextDecoder(); let buf='';
    while(true){
      const {done,value}=await reader.read(); if(done) break;
      buf+=dec.decode(value,{stream:true}); let k;
      while((k=buf.indexOf('\n\n'))>=0){
        const line=buf.slice(0,k); buf=buf.slice(k+2); if(!line.startsWith('data:')) continue;
        let ev; try{ ev=JSON.parse(line.slice(5)); }catch{ continue; }
        if(ev.t==='text') bot.live+=ev.d;
        else if(ev.t==='thinking') bot.thinking+=ev.d;
        else if(ev.t==='status') bot.status=ev.d;
        else if(ev.t==='sources') bot.found.push(...ev.d);
        else if(ev.t==='error'){ bot.error=ev.message; }
        else if(ev.t==='route'){ bot.modelName=ev.model.label; bot.provider=ev.model.provider; bot.route=ev.route; bot.modeName=mode().name; }
        else if(ev.t==='done'){ bot.provider=ev.provider; bot.turn=ev.turn; bot.display=ev.display; bot.citations=ev.citations; bot.usage=ev.usage; bot.stop=ev.stop; }
        paint(chat, idx);
      }
    }
    if(!bot.turn&&!bot.error) bot.error='The connection ended before the answer was complete.';
  }catch(err){
    if(ctl.aborted||err.name==='AbortError'){ bot.stopped=true; if(bot.live.trim()){ bot.display=bot.live; } }
    else if(!bot.error) bot.error=/fetch|network/i.test(err.message)?'Could not reach the Canopus server. Check your connection.':err.message;
  }finally{
    running.delete(chat.id); bot.streaming=false; bot.status=''; delete bot.live;
    if(bot.stopped&&!bot.turn) bot.turn=bot.display?[{role:'assistant', content:[{type:'text', text:bot.display}]}]:null; // keep partial text in history
    const wasBuilding=panel.build?.chatId===chat.id; if(wasBuilding) panel.build=null;
    const refs=harvestCanvases(chat, bot);
    chat.updated=Date.now(); save(); renderSide(); refreshMe();
    if(chat.id===state.current&&curView()==='home'){ renderThread(); updateSend(); if(refs.length) openCanvas(refs.at(-1).id, refs.at(-1).v); else if(wasBuilding) closePanel(); }
    if(!chat.titled&&bot.turn&&!bot.error){ chat.titled=true; autoTitle(chat); }
  }
}
function harvestCanvases(chat,bot){
  const text=botText(bot)||''; let mm; HTML_BLOCK.lastIndex=0; bot.canvasRefs=[];
  while((mm=HTML_BLOCK.exec(text))){
    const html=mm[1].trim();
    const title=(html.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1]||html.match(/<h1[^>]*>([\s\S]{1,160}?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g,'')||chat.title).trim();
    let cv=state.canvases.find(c=>c.chatId===chat.id&&c.title.toLowerCase()===title.toLowerCase());
    if(cv){ cv.versions.push({html, created:Date.now()}); cv.updated=Date.now(); } else { cv={id:uid(), title, chatId:chat.id, created:Date.now(), updated:Date.now(), versions:[{html, created:Date.now()}]}; state.canvases.push(cv); }
    bot.canvasRefs.push({id:cv.id, v:cv.versions.length-1});
  }
  if(bot.canvasRefs.length) toast(bot.canvasRefs.some(r=>r.v>0)?'New version saved to Studio':'Saved to Studio');
  return bot.canvasRefs;
}
async function autoTitle(chat){
  const first=chat.msgs.find(m=>m.r==='user'); const seed=(first?.text||(first?.atts||[]).map(a=>a.name).join(', ')||'').slice(0,1500);
  try{ const {text}=await api('/api/quick',{method:'POST', body:{purpose:'title', text:seed, chatId:chat.id}, quiet:true}); if(text){ chat.title=text.replace(/^["'“”*#]+|["'“”.*]+$/g,'').split('\n')[0].slice(0,70); save(); renderSide(); renderHead(); } }catch{}
}

/* ================= Knowledge (organization) ================= */
const clsBadge=c=>`<span class="cls ${esc(c)}">${esc(me.config.classifications[c]?.label||c)}</span>`;
async function renderKnowledge(){
  const total=knowledge.reduce((a,c)=>a+c.docs.length,0);
  $('#knowPage').innerHTML=`<div class="page-head"><div><h1><span class="h-ic c-sky"><svg data-ic="book"></svg></span>Knowledge</h1><p class="sub">Internal documents Canopus can search when you ask a question. Documents stay on this server: only the few passages relevant to your question are sent to the AI, sensitive details like ID numbers are masked first, and every answer cites its sources.</p></div>${isAdmin()?`<button class="cta" data-go="admin" data-tab="knowledge">${ic('settings')}Manage</button>`:''}</div>
    <div class="set-sec" style="margin-bottom:16px"><h3 style="display:flex;gap:8px;align-items:center">${ic('search')}Search documents directly</h3><p>Finds passages without using AI: nothing leaves the server and it costs nothing. Works for every collection you can access, including on-premise ones.</p>
      <form id="dsForm" class="bar" style="margin:0"><label class="search"><svg data-ic="search"></svg><input id="dsQ" placeholder="e.g. a name, a record number, “anggaran 2026”…"></label><button class="btn primary" type="submit">Search</button></form><div id="dsRes"></div></div>
    <div class="stat-row"><div class="stat"><small>Collections you can access</small><b>${knowledge.length}</b></div><div class="stat"><small>Documents</small><b>${total}</b></div><div class="stat"><small>Searchable passages</small><b>${knowledge.reduce((a,c)=>a+c.docs.reduce((x,d)=>x+(d.chunks||0),0),0)}</b></div></div>
    ${knowledge.length?knowledge.map(c=>`<div class="col-card"><div class="col-head"><div><h3>${esc(c.name)}</h3><p>${c.local_only?`<span class="cls biasa">${ic('lock')}On this server only</span> `:''}${c.description?esc(c.description)+' · ':''}Access: ${c.groups.length?c.groups.map(g=>esc(g.name)).join(', '):'everyone'}</p></div><button class="btn sm" data-askcol="${c.id}">${ic('chat')}Ask about this</button></div>
      ${c.docs.length?c.docs.map(d=>`<div class="doc-row">${ic('file')}<span class="t" title="${esc(d.filename)}">${esc(d.title)}</span>${clsBadge(d.classification)}${d.sensitive?`<span class="cls terbatas" title="Values in personal-data columns are always masked before reaching the AI">${ic('lock')}${d.sensitive} masked</span>`:''}<small>${d.pages>1?d.pages+' pages · ':''}${fmtDate(d.created)}</small>${d.status==='ready'?`<a class="icon-btn" href="/api/knowledge/docs/${d.id}/file" target="_blank" rel="noopener" title="Open original">${ic('eye')}</a>`:`<span class="cls ${d.status}">${d.status}</span>`}</div>`).join(''):'<div class="empty" style="padding:6px 0">No documents yet.</div>'}</div>`).join('')
      :`<div class="empty-box"><div class="e-ic">${ic('book')}</div><b>No knowledge available yet</b><p>${isAdmin()?'Create a collection and upload documents in Admin → Knowledge.':'Your administrator hasn\'t shared any knowledge collections with you yet.'}</p></div>`}`;
  hydrateIcons($('#knowPage'));
  $('#dsForm').onsubmit=async e=>{ e.preventDefault(); const q=$('#dsQ').value.trim(); if(!q) return; const box=$('#dsRes'); box.innerHTML='<div class="help">Searching…</div>';
    try{ const hits=await api('/api/knowledge/search',{method:'POST', body:{query:q}}); dsHits=hits;
      box.innerHTML=hits.length?hits.map((h,j)=>`<div class="doc-row" style="align-items:flex-start">${ic('file')}<div style="flex:1;min-width:0"><b style="font-size:14px">${esc(h.title)}${h.page?' — p. '+h.page:''}</b> <small>${esc(h.collection)}</small>${h.localOnly?` <span class="cls biasa">${ic('lock')}on-premise</span>`:''}<div class="help" style="white-space:pre-wrap;color:var(--fg);opacity:.85">${esc(h.text.slice(0,400))}${h.text.length>400?'…':''}</div></div><button class="icon-btn" data-dshit="${j}" title="Show passage">${ic('eye')}</button></div>`).join(''):'<div class="help">No matching passages.</div>'; }
    catch(err){ box.innerHTML=`<div class="help" style="color:var(--red)">${esc(err.message)}</div>`; } };
}
let dsHits=[];

/* ================= Studio ================= */
function cardHTML(c){ const v=c.versions.length; return `<div class="card"><div class="thumb" data-copen="${c.id}" data-thumb="${c.id}" role="button"></div><div class="card-body"><div class="card-top"><h3>${esc(c.title)}</h3><button class="icon-btn" data-cmenu="${c.id}" title="Options">${ic('dots')}</button></div><div class="date">Updated ${ago(c.updated)}</div><div class="badges"><span class="badge">${ic('sidebar')}Interactive page</span>${v>1?`<span class="badge gold">${ic('layers')}${v} versions</span>`:''}</div></div></div>`; }
function fillThumbs(root){ root.querySelectorAll('[data-thumb]').forEach(t=>{ const c=state.canvases.find(x=>x.id===t.dataset.thumb); if(!c||t.firstChild) return; const f=sandboxFrame(c.versions.at(-1).html); f.tabIndex=-1; t.append(f); const w=t.clientWidth||300; f.style.transform=`scale(${w/1280})`; }); }
function renderStudio(){
  $('#studioSort').innerHTML=[['new','Recent'],['old','Oldest'],['az','A–Z']].map(([k,l])=>`<button class="pill ${state.sort===k?'on':''}" data-sort="${k}">${l}</button>`).join('');
  const q=$('#studioQ').value.trim().toLowerCase();
  let list=state.canvases.filter(c=>c.title.toLowerCase().includes(q));
  list.sort(state.sort==='az'?(a,b)=>a.title.localeCompare(b.title):state.sort==='old'?(a,b)=>a.created-b.created:(a,b)=>b.updated-a.updated);
  if(!state.canvases.length){ $('#cards').innerHTML=`<div class="empty-box"><div class="e-ic">${ic('layers')}</div><b>Nothing here yet</b><p>Ask Canopus for a report page, dashboard, infographic or small tool. It opens beside your chat and is saved here, with every revision kept.</p><button class="cta" data-act="newcanvas">${ic('sparkle')}Create something</button></div>`; $('#studioFoot').textContent=''; return; }
  $('#cards').innerHTML=list.length?`<div class="cards">${list.map(cardHTML).join('')}</div>`:`<div class="empty-box"><b>No matches</b><p>Try a different search.</p></div>`;
  fillThumbs($('#cards')); $('#studioFoot').textContent=list.length?`${list.length} of ${state.canvases.length} item${state.canvases.length>1?'s':''}`:'';
}

/* ================= My files ================= */
let fType='all';
function renderSources(){
  const used=state.files.reduce((a,f)=>a+(f.size||0),0); const inSpaces=new Set(state.spaces.flatMap(s=>s.fileIds||[])).size;
  $('#srcStats').innerHTML=`<div class="stat"><small>Files</small><b>${state.files.length}</b></div><div class="stat"><small>Pinned to spaces</small><b>${inSpaces}</b></div><div class="stat"><small>Storage used</small><b>${fmtSize(used)}</b></div>`;
  $('#pills').innerHTML=FTYPES.map(t=>`<button class="pill ${t.id===fType?'on':''}" data-ftype="${t.id}">${ic(t.ic)}${t.l}</button>`).join('');
  const q=$('#fileQ').value.trim().toLowerCase();
  const list=state.files.filter(f=>(fType==='all'||f.ftype===fType)&&f.name.toLowerCase().includes(q));
  $('#fileList').innerHTML=list.length?`<div class="files">${list.map(f=>`<div class="file"><div class="f-ic">${f.thumb?`<img src="${f.thumb}" alt="">`:ic(FTYPES.find(t=>t.id===f.ftype)?.ic||'file')}</div><div class="f-meta"><b>${esc(f.name)}</b><small>${fmtSize(f.size||0)} · ${fmtDate(f.added)}</small></div><div class="f-acts"><a class="icon-btn" href="/api/blobs/${f.id}" target="_blank" rel="noopener" title="Open">${ic('eye')}</a><button class="icon-btn" title="Ask about this" data-fuse="${f.id}">${ic('chat')}</button><button class="icon-btn" title="Delete" data-fdel="${f.id}">${ic('trash')}</button></div></div>`).join('')}</div>`
    :`<div class="empty-box drop-zone" id="srcDrop"><div class="e-ic">${ic('upload')}</div><b>${state.files.length?'No matching files':'Drop files here'}</b><p>Images, PDF, Word and text files. Files you attach in chats are added automatically.</p>${state.files.length?'':`<button class="cta" data-act="upload">${ic('upload')}Choose files</button>`}</div>`;
  const dz=$('#srcDrop'); if(dz){ ['dragenter','dragover'].forEach(t=>dz.addEventListener(t,e=>{e.preventDefault();dz.classList.add('drag');})); ['dragleave','drop'].forEach(t=>dz.addEventListener(t,e=>{e.preventDefault();dz.classList.remove('drag');})); dz.addEventListener('drop',e=>addSources([...e.dataTransfer.files])); }
}
async function addSources(files){ let n=0; for(const f of files){ try{ addFileRecord(await uploadFile(f)); n++; }catch(e){ toast(`${f.name}: ${e.message}`,4500); } } save(); renderSources(); renderSide(); if(n) toast(`${n} file${n>1?'s':''} added`); }
$('#kFile').addEventListener('change',async e=>{ const n=[...e.target.files]; e.target.value=''; await addSources(n); });

/* ================= Prompts ================= */
const varsOf=body=>[...new Set([...body.matchAll(/\{\{([^}]+)\}\}/g)].map(m=>m[1].trim()))];
function renderPrompts(){
  const q=$('#promptQ').value.trim().toLowerCase();
  const list=allPrompts().filter(p=>(p.title+' '+p.body).toLowerCase().includes(q));
  const card=p=>{ const vars=varsOf(p.body); const own=state.prompts.some(x=>x.id===p.id); return `<div class="tpl" data-useprompt="${p.id}" role="button"><div class="tpl-top"><div class="f-ic">${ic(p.icon||'bolt')}</div><b>${esc(p.title)}</b>${p.org?`<span class="badge gold">${ic('shield')}Organization</span>`:`<div class="f-acts"><button class="icon-btn" data-editprompt="${p.id}" title="Edit">${ic('edit')}</button>${own?`<button class="icon-btn" data-delprompt="${p.id}" title="Delete">${ic('trash')}</button>`:''}</div>`}</div><p>${esc(p.body.replace(/\{\{([^}]+)\}\}/g,'[$1]'))}</p>${vars.length?`<div class="vars">${vars.map(v=>`<span class="var">${esc(v)}</span>`).join('')}</div>`:''}</div>`; };
  $('#promptList').innerHTML=list.length?`<div class="tpls">${list.map(card).join('')}</div>`:`<div class="empty-box"><b>No prompts found</b><p>Try another search, or create a new prompt.</p></div>`;
}
let promptFill=null;
function usePrompt(id){
  const p=allPrompts().find(x=>x.id===id); if(!p) return;
  const vars=varsOf(p.body);
  const fill=vals=>{ let t=p.body; for(const v of vars) t=t.replace(new RegExp('\\{\\{\\s*'+v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*\\}\\}','g'), vals[v]||''); if(curView()!=='home'||!curChat()){ state.current=null; closePanel(); go('home'); } setTimeout(()=>{ input.value=t; autosize(); input.focus(); },30); };
  if(!vars.length){ fill({}); return; }
  promptFill=fill; modalDone=null;
  openModal(`<h3>${esc(p.title)}</h3><p class="s">Fill in the blanks. You can still edit the prompt before sending.</p>${vars.map((v,i)=>{ const long=/notes|text|data|email|content/i.test(v); return `<label for="pv${i}">${esc(v[0].toUpperCase()+v.slice(1))}</label>${long?`<textarea id="pv${i}" data-var="${esc(v)}" ${i===0?'autofocus':''}></textarea>`:`<input type="text" id="pv${i}" data-var="${esc(v)}" ${i===0?'autofocus':''}>`}`; }).join('')}<div class="dlg-actions"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-act="fillprompt">Use prompt</button></div>`,'wide');
}
function pickPrompt(){
  modalDone=null; $('#modal').innerHTML=`<div class="dlg palette"><label class="search">${ic('bolt')}<input id="ppQ" placeholder="Choose a prompt…"></label><div class="res" id="ppRes"></div></div>`; $('#modal').hidden=false;
  const q=$('#ppQ'); const draw=()=>{ const s=q.value.toLowerCase(); $('#ppRes').innerHTML=allPrompts().filter(p=>p.title.toLowerCase().includes(s)).map(p=>`<div class="row-item" data-useprompt="${p.id}" role="button">${ic(p.icon||'bolt','c-violet')}<span>${esc(p.title)}</span>${p.org?'<small>Organization</small>':''}</div>`).join('')||'<div class="empty">No prompts</div>'; };
  q.addEventListener('input',draw); draw(); setTimeout(()=>q.focus(),30);
}
function editPrompt(id){
  const p=id?allPrompts().find(x=>x.id===id):{title:'', body:'', icon:'bolt'}; modalDone=null;
  openModal(`<h3>${id?'Edit prompt':'New prompt'}</h3><p class="s">Write <span class="var">{{blank}}</span> for parts you fill in each time.</p><label for="ptTitle">Title</label><input type="text" id="ptTitle" value="${esc(p.title)}" autofocus><label for="ptBody">Prompt</label><textarea id="ptBody" style="min-height:180px">${esc(p.body)}</textarea><div class="dlg-actions"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-act="saveprompt" data-pid="${id||''}">Save</button></div>`,'wide');
}

/* ================= Skills ================= */
function renderSkills(){
  const sk=allSkills(); const own=sk.filter(s=>!s.builtin);
  const row=s=>`<div class="skill"><div class="f-ic" style="color:var(--green);background:rgba(95,211,160,.12)">${ic('puzzle')}</div><div class="f-meta"><b>${esc(s.name)}</b><small>${esc(s.description||s.file||'')}</small></div><button class="icon-btn" title="View" data-sview="${s.id}">${ic('eye')}</button>${s.builtin?'':`<button class="icon-btn" title="Edit" data-sedit="${s.id}">${ic('edit')}</button><button class="icon-btn" title="Delete" data-sdel="${s.id}">${ic('trash')}</button>`}<button class="switch ${s.enabled?'on':''}" data-stoggle="${s.id}" role="switch" aria-checked="${!!s.enabled}" aria-label="${esc(s.name)}"></button></div>`;
  $('#skillList').innerHTML=(me.orgSkills.length?`<div class="sec-label">${ic('shield')}From your organization<span class="r">always on</span></div>${me.orgSkills.map(s=>`<div class="skill"><div class="f-ic" style="color:var(--pink);background:rgba(255,122,168,.12)">${ic('shield')}</div><div class="f-meta"><b>${esc(s.name)}</b><small>${esc(s.description||'Set by your administrator')}</small></div></div>`).join('')}`:'')
    +`<div class="sec-label">${ic('sparkle')}Built-in</div>${sk.filter(s=>s.builtin).map(row).join('')}<div class="sec-label">${ic('puzzle')}Yours<span class="r">${own.length} of 20</span></div>${own.length?own.map(row).join(''):`<div class="empty-box" style="padding:34px 20px"><p>Write a skill in plain language, or upload a skill folder with a <b>SKILL.md</b>.</p></div>`}`;
}
function frontmatter(md){ const m=md.match(/^---\s*\n([\s\S]*?)\n---/); const o={}; if(m) m[1].split('\n').forEach(l=>{ const k=l.match(/^(\w[\w-]*):\s*(.*)$/); if(k) o[k[1]]=k[2].replace(/^["']|["']$/g,''); }); return o; }
function loadScript(src){ return new Promise((res,rej)=>{ const s=document.createElement('script'); s.src=src; s.onload=res; s.onerror=rej; document.head.appendChild(s); }); }
function untar(buf){ const out=[]; const u=new Uint8Array(buf); const dec=new TextDecoder(); let o=0; while(o+512<=u.length){ const hdr=u.subarray(o,o+512); if(hdr.every(b=>b===0)) break; const str=(a,b)=>dec.decode(hdr.subarray(a,b)).replace(/\0.*$/s,'').trim(); const name=(str(345,500)?str(345,500)+'/':'')+str(0,100); const size=parseInt(str(124,136)||'0',8)||0; const type=String.fromCharCode(hdr[156]||48); if(type==='0'||type==='\0') out.push({name, data:u.subarray(o+512,o+512+size)}); o+=512+Math.ceil(size/512)*512; } return out; }
async function parseSkill(file){
  let entries=[];
  if(/\.(md|txt)$/i.test(file.name)) entries=[{name:file.name, text:await file.text()}];
  else if(/\.zip$/i.test(file.name)){ if(!window.JSZip) await loadScript('/vendor/jszip.min.js'); const z=await window.JSZip.loadAsync(file); for(const f of Object.values(z.files)) if(!f.dir&&/\.(md|txt)$/i.test(f.name)&&!/__MACOSX/.test(f.name)) entries.push({name:f.name, text:await f.async('string')}); }
  else if(/\.(tar\.gz|tgz|gz)$/i.test(file.name)){ const buf=await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(); for(const e of untar(buf)) if(/\.(md|txt)$/i.test(e.name)&&!/(^|\/)\._/.test(e.name)) entries.push({name:e.name, text:new TextDecoder().decode(e.data)}); }
  else throw new Error('Unsupported file type');
  if(!entries.length) throw new Error('No SKILL.md or .md file found');
  entries.sort((a,b)=>(/(^|\/)skill\.md$/i.test(b.name)-/(^|\/)skill\.md$/i.test(a.name))||a.name.length-b.name.length);
  const main=entries[0]; const fm=frontmatter(main.text); let content=main.text; for(const e of entries.slice(1)){ if(content.length>18000) break; content+=`\n\n<!-- ${e.name} -->\n${e.text}`; }
  return {id:uid(), name:fm.name||file.name.replace(/\.(zip|tar\.gz|tgz|gz|md|txt)$/i,''), description:fm.description||'', content:content.slice(0,20000), size:file.size, file:file.name, added:Date.now(), enabled:true};
}
$('#pFile').addEventListener('change',async e=>{ const files=[...e.target.files]; e.target.value=''; for(const f of files){ if(state.skills.filter(s=>!s.builtin).length>=20){ toast('Skill limit reached (20)'); break; } try{ const s=await parseSkill(f); state.skills.push(s); toast(`Added skill “${s.name}”`); }catch(err){ toast(`${f.name}: ${err.message}`,4000); } } save(); renderSkills(); renderSide(); });
function editSkill(id){ const s=id?state.skills.find(x=>x.id===id):{name:'',description:'',content:''}; modalDone=null; openModal(`<h3>${id?'Edit skill':'Write a skill'}</h3><p class="s">Describe, in plain language, what Canopus should do when this skill applies.</p><label for="skName">Name</label><input type="text" id="skName" value="${esc(s.name)}" autofocus><label for="skDesc">When to use it</label><input type="text" id="skDesc" value="${esc(s.description)}"><label for="skBody">Instructions</label><textarea id="skBody" style="min-height:200px">${esc(s.content)}</textarea><div class="dlg-actions"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-act="saveskill" data-sid="${id||''}">Save</button></div>`,'wide'); }

/* ================= Spaces ================= */
function renderSpace(){
  const sp=space(spaceId); if(!sp) return;
  const chats=state.chats.filter(c=>c.spaceId===sp.id).sort((a,b)=>b.updated-a.updated);
  const files=(sp.fileIds||[]).map(id=>state.files.find(f=>f.id===id)).filter(Boolean);
  $('#spacePage').innerHTML=`<div class="page-head"><div><h1><span class="h-ic" style="background:${sp.color}22;color:${sp.color}">${ic('folder')}</span>${esc(sp.name)}</h1><p class="sub">Chats in this space share its instructions and reference files.</p></div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-act="editspace">${ic('edit')}Rename</button><button class="btn danger" data-act="delspace" title="Delete space">${ic('trash')}</button><button class="cta" data-act="spacechat">${ic('plus')}New chat here</button></div></div>
    <div class="space-grid"><div style="display:grid;gap:18px;min-width:0"><div class="box"><h3>${ic('chat','c-muted')}Chats</h3><p class="s">${chats.length} conversation${chats.length===1?'':'s'}</p>${chats.length?chats.map(c=>`<div class="row-item" data-open="${c.id}" role="button" style="padding-left:8px">${ic('chat','c-muted')}<span>${esc(c.title)}</span><small>${ago(c.updated)}</small></div>`).join(''):`<div class="empty" style="padding:4px 0">No chats yet — start one with <b>New chat here</b>.</div>`}</div>
      <div class="box"><h3>${ic('archive','c-sky')}Reference files</h3><p class="s">Attached to every chat in this space.</p>${files.map(f=>`<div class="row-item" style="padding-left:8px">${ic(FTYPES.find(t=>t.id===f.ftype)?.ic||'file','c-muted')}<span>${esc(f.name)}</span><button class="mini" style="opacity:1" data-unpinfile="${f.id}" title="Remove from space">${ic('x')}</button></div>`).join('')}<button class="btn sm" style="margin-top:8px" data-act="spacefiles">${ic('plus')}Add from My files</button></div></div>
    <div class="box"><h3>${ic('memo','c-gold')}Instructions</h3><p class="s">Background, tone, formats or rules Canopus should follow here.</p><textarea id="spInstr" placeholder="e.g. Write in formal Indonesian. Every daily brief has: Summary, Key Issues, Recommendations.">${esc(sp.instructions)}</textarea><div class="saved" id="spSaved"></div><div style="font-size:13px;color:var(--muted);font-weight:600;margin-top:6px">Color</div><div class="swatches">${SPACE_COLORS.map(c=>`<button class="sw ${sp.color===c?'on':''}" style="background:${c}" data-color="${c}" title="${c}"></button>`).join('')}</div></div></div>`;
  const ta=$('#spInstr'); let t; ta.addEventListener('input',()=>{ sp.instructions=ta.value; clearTimeout(t); $('#spSaved').textContent='Saving…'; t=setTimeout(()=>{ save(); $('#spSaved').textContent='Saved'; },500); });
}

/* ================= Admin console ================= */
let adminTab='security', admin=null;
async function loadAdmin(){ admin=await api('/api/admin/overview'); }
async function renderAdmin(){
  const page=$('#adminPage');
  try{ await loadAdmin(); }catch(e){ page.innerHTML=`<div class="empty-box"><b>Could not load the admin console</b><p>${esc(e.message)}</p></div>`; return; }
  const tabs=[['security','Security'],['users','Users'],['groups','Groups'],['projects','Projects'],['knowledge','Knowledge'],['models','Models'],['settings','Settings'],['integrations','Integrations'],['usage','Usage'],['audit','Audit log']];
  page.innerHTML=`<div class="page-head"><div><h1><span class="h-ic c-pink"><svg data-ic="shield"></svg></span>Admin</h1><p class="sub">Manage who can use Canopus, what internal knowledge they can reach, the AI models and budgets, and review activity.</p></div></div>
    ${admin.apiConfigured?'':`<div class="notice" style="max-width:none">${ic('key')}<span>No AI provider is configured. Set <b>ANTHROPIC_API_KEY</b> and/or <b>OPENAI_API_KEY</b> in the server's .env file and restart it.</span></div>`}
    <div class="tabs">${tabs.map(([k,l])=>`<button class="tab ${adminTab===k?'on':''}" data-atab="${k}">${l}</button>`).join('')}</div><div id="adminBody" style="margin-top:18px"></div>`;
  hydrateIcons(page);
  ({security:adminSecurity, users:adminUsers, groups:adminGroups, projects:adminProjects, knowledge:adminKnowledge, models:adminModels, settings:adminSettings, integrations:adminIntegrations, usage:adminUsage, audit:adminAudit}[adminTab])();
}
const groupName=id=>admin.groups.find(g=>g.id===id)?.name||'?';
async function adminSecurity(){
  const r=await api('/api/admin/security'); const s=r.settings;
  const okN=r.checks.filter(c=>c.ok).length;
  $('#adminBody').innerHTML=`<div class="stat-row"><div class="stat"><small>Security checks passed</small><b>${okN} / ${r.checks.length}</b></div></div>
    <div class="set-sec"><h3>Checklist</h3><p>What this server enforces right now. Items marked ⚠ are allowed but worth reviewing for patient or hospital data.</p>
      ${r.checks.map(c=>`<div class="set-row"><div><b>${c.ok?'✅':c.warn?'⚠️':'❌'} ${esc(c.label)}</b>${c.ok?'':`<small>${esc(c.fix)}</small>`}</div></div>`).join('')}</div>
    <div class="set-sec"><h3>Policies</h3><p>Two-step verification uses an authenticator app (6-digit codes). Masking data maps placeholders back to real values, so it is deleted after the period below.</p>
      <div class="set-row"><div><b>Require two-step verification</b><small>Applies at the next sign-in.</small></div><select id="sec2fa">${[['all','Everyone (recommended)'],['admins','Administrators only'],['off','Not required']].map(([k,l])=>`<option value="${k}" ${s.require2fa===k?'selected':''}>${l}</option>`).join('')}</select></div>
      <div class="set-row"><div><b>Delete masking data after (days)</b><small>0 = keep forever. After this, old chats may need to be started fresh.</small></div><input type="number" id="secMask" min="0" value="${s.maskingRetentionDays}" style="width:110px"></div>
      <div class="set-row"><div><b>Delete audit log and usage after (days)</b><small>0 = keep forever (check your record-keeping rules first).</small></div><input type="number" id="secLogs" min="0" value="${s.logRetentionDays}" style="width:110px"></div>
      <div class="save-bar"><button class="btn primary" data-act="savesecurity">Save policies</button></div></div>
    <div class="set-sec"><h3>Server-level protections</h3><p>Set in the server's <span class="mono">.env</span> (restart required): <span class="mono">CANOPUS_ALLOWED_IPS</span> (office network / VPN only), <span class="mono">SESSION_IDLE_MINUTES</span>, <span class="mono">SESSION_HOURS</span>, <span class="mono">PUBLIC_URL</span> (https). See the deployment guide for disk encryption, backups and firewall.</p></div>`;
}
function adminUsers(){
  $('#adminBody').innerHTML=`<div class="bar"><div style="flex:1;color:var(--muted)">${admin.users.length} user${admin.users.length===1?'':'s'}</div><button class="cta" data-act="adduser">${ic('plus')}Invite user</button></div>
    <div class="tblwrap"><table class="tbl"><thead><tr><th>User</th><th>Role</th><th>Groups</th><th class="r">This month</th><th>Status</th><th>2FA</th><th></th></tr></thead><tbody>
    ${admin.users.map(u=>`<tr><td><b>${esc(u.name||'—')}</b><div class="muted">${esc(u.email)}</div></td><td>${u.role==='admin'?'<span class="badge gold">Admin</span>':'User'}</td><td>${u.groups.map(g=>`<span class="gchip">${esc(groupName(g))}</span>`).join('')||'<span class="muted">—</span>'}</td><td class="r">${usd(u.spent)}<div class="muted">of ${u.budget>0?usd(u.budget):'unlimited'}</div></td><td>${u.disabled?'<span class="cls error">Disabled</span>':u.active?'<span class="cls biasa">Active</span>':'<span class="cls processing">Invited</span>'}${u.last_login?`<div class="muted">${ago(u.last_login)}</div>`:''}</td><td>${u.twofa?'<span class="cls biasa">On</span>':'<span class="muted">—</span>'}</td>
      <td class="r"><button class="icon-btn" data-edituser="${u.id}" title="Edit">${ic('edit')}</button><button class="icon-btn" data-resetuser="${u.id}" title="New sign-in link">${ic('key')}</button></td></tr>`).join('')}</tbody></table></div>`;
}
function groupChecks(selected=[]){ return admin.groups.length?`<div class="checks">${admin.groups.map(g=>`<label><input type="checkbox" value="${g.id}" ${selected.includes(g.id)?'checked':''}>${esc(g.name)}</label>`).join('')}</div>`:'<div class="help">No groups yet — create them in the Groups tab.</div>'; }
function userModal(u){
  modalDone=null;
  openModal(`<h3>${u?'Edit user':'Invite a user'}</h3><p class="s">${u?esc(u.email):'They get a one-time link to set their password (valid 72 hours). Send it through your usual internal channel.'}</p>
    ${u?'':`<label for="uEmail">Email</label><input type="text" id="uEmail" autofocus placeholder="name@kantor.go.id">`}
    <label for="uName">Name</label><input type="text" id="uName" value="${esc(u?.name||'')}">
    <div class="row2"><div><label for="uRole">Role</label><select id="uRole"><option value="user" ${u?.role!=='admin'?'selected':''}>User</option><option value="admin" ${u?.role==='admin'?'selected':''}>Administrator</option></select></div>
    <div><label for="uBudget">Monthly AI budget (USD)</label><input type="text" id="uBudget" value="${u?.budget_usd??''}" placeholder="Default: ${usd(admin.settings.monthlyBudgetUsd)}"></div></div>
    <label>Groups <span style="font-weight:400;color:var(--dim)">— control which knowledge collections they can search</span></label><div id="uGroups">${groupChecks(u?.groups||[])}</div>
    <div class="dlg-actions">${u?.twofa?`<button class="btn" data-act="reset2fa" data-uid="${u.id}">${ic('key')}Reset 2FA</button>`:''}${u?`<button class="btn ${u.disabled?'':'danger'}" data-act="toggleuser" data-uid="${u.id}" data-dis="${u.disabled?0:1}">${u.disabled?'Enable':'Disable'} account</button><span class="grow"></span>`:''}<button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-act="saveuser" data-uid="${u?.id||''}">${u?'Save':'Create invitation'}</button></div>`,'wide');
}
function showLink(title, link){ modalDone=null; openModal(`<h3>${esc(title)}</h3><p class="s">Copy this one-time link and send it to the user through a trusted internal channel. It expires in 72 hours and can be used once.</p><div class="linkbox"><input type="text" id="linkIn" value="${esc(link)}" readonly><button class="btn primary" data-act="copylink">${ic('copy')}Copy</button></div><div class="dlg-actions"><button class="btn" data-dlg="cancel">Done</button></div>`,'wide'); }
function adminGroups(){
  $('#adminBody').innerHTML=`<div class="bar"><div style="flex:1;color:var(--muted)">Groups decide which knowledge collections and projects people can use, which models they may choose, and an optional shared monthly budget.</div><button class="cta" data-act="addgroup">${ic('plus')}New group</button></div>
    ${admin.groups.length?`<div class="tblwrap"><table class="tbl"><thead><tr><th>Group</th><th class="r">Members</th><th>Models allowed</th><th class="r">This month</th><th></th></tr></thead><tbody>${admin.groups.map(g=>`<tr><td><b>${esc(g.name)}</b></td><td class="r">${g.members}</td><td>${g.models?g.models.map(id=>`<span class="gchip">${esc(admin.models.find(m=>m.id===id)?.label||id)}</span>`).join(''):'<span class="muted">All enabled models</span>'}</td><td class="r">${usd(g.spent)}<div class="muted">${g.budget_usd>0?'of '+usd(g.budget_usd):'no group budget'}</div></td><td class="r"><button class="icon-btn" data-editgroup="${g.id}" title="Edit">${ic('edit')}</button><button class="icon-btn" data-delgroup="${g.id}" title="Delete">${ic('trash')}</button></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty-box"><b>No groups yet</b><p>Without groups, every collection and project is visible to everyone.</p></div>`}`;
}
function groupModal(g){
  const enabled=admin.models.filter(m=>admin.settings.models.includes(m.id)); modalDone=null;
  openModal(`<h3>Edit group</h3><p class="s">${esc(g.name)} · ${g.members} member${g.members===1?'':'s'}</p>
    <label for="gName">Name</label><input type="text" id="gName" value="${esc(g.name)}">
    <label for="gBudget">Shared monthly budget (USD) <span style="font-weight:400;color:var(--dim)">— leave empty for none</span></label><input type="text" id="gBudget" value="${g.budget_usd??''}" placeholder="e.g. 20">
    <label>Models this group may use</label><div class="checks" id="gModels"><label><input type="checkbox" value="__all" ${g.models?'':'checked'}>All enabled models</label>${enabled.map(m=>`<label><input type="checkbox" value="${m.id}" ${g.models?.includes(m.id)?'checked':''}>${esc(m.label)}</label>`).join('')}</div>
    <div class="help">If a person belongs to several groups, they may use any model allowed in at least one of them. Auto picks the closest allowed model.</div>
    <div class="dlg-actions"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-act="savegroup" data-gid="${g.id}">Save</button></div>`,'wide');
}
function adminProjects(){
  $('#adminBody').innerHTML=`<div class="bar"><div style="flex:1;color:var(--muted)">Shared projects work like Claude Projects: instructions plus knowledge, ready for everyone you choose — without anyone needing their own AI account.</div><button class="cta" data-act="addproject">${ic('plus')}New project</button></div>
    ${admin.projects.length?admin.projects.map(p=>`<div class="col-card"><div class="col-head"><div><h3>${esc(p.name)}</h3><p>${p.description?esc(p.description)+' · ':''}Model: ${p.model==='auto'?'Auto':esc(admin.models.find(m=>m.id===p.model)?.label||p.model)} · Knowledge: ${p.collections.length?p.collections.map(c=>esc(admin.collections.find(x=>x.id===c)?.name||'?')).join(', '):'all the user can access'} · Access: ${p.groups.length?p.groups.map(g=>esc(groupName(g))).join(', '):'everyone'}</p></div><button class="btn sm" data-editproject="${p.id}">${ic('edit')}Edit</button></div>${p.instructions?`<div class="quote" style="max-height:120px;font-size:13px">${esc(p.instructions.slice(0,600))}${p.instructions.length>600?'…':''}</div>`:''}</div>`).join('')
      :`<div class="empty-box"><div class="e-ic">${ic('book')}</div><b>No projects yet</b><p>Create one from scratch, or copy a Claude project: paste its instructions and upload the same files.</p></div>`}`;
}
function projectModal(p){
  const enabled=admin.models.filter(m=>admin.settings.models.includes(m.id)); modalDone=null;
  openModal(`<h3>${p?'Edit project':'New project'}</h3><p class="s">${p?'':'<b>Copying a Claude project?</b> Open it on claude.ai, copy the text under “Instructions”, paste it below, and upload the same files.'}</p>
    <label for="pjName">Name</label><input type="text" id="pjName" value="${esc(p?.name||'')}" autofocus>
    <label for="pjDesc">Short description</label><input type="text" id="pjDesc" value="${esc(p?.description||'')}">
    <label for="pjInstr">Instructions</label><textarea id="pjInstr" style="min-height:160px" placeholder="How Canopus should behave in this project: role, tone, format, what to focus on…">${esc(p?.instructions||'')}</textarea>
    <div class="row2"><div><label for="pjModel">Model</label><select id="pjModel"><option value="auto">Auto (recommended)</option>${enabled.map(m=>`<option value="${m.id}" ${p?.model===m.id?'selected':''}>${esc(m.label)}</option>`).join('')}</select></div><div></div></div>
    <label>Knowledge collections <span style="font-weight:400;color:var(--dim)">— none checked = everything the user can access</span></label><div class="checks" id="pjCols">${admin.collections.map(c=>`<label><input type="checkbox" value="${c.id}" ${p?.collections.includes(c.id)?'checked':''}>${esc(c.name)}</label>`).join('')||'<span class="help">No collections yet.</span>'}</div>
    ${p?'':`<label>Or upload this project's files now <span style="font-weight:400;color:var(--dim)">— creates a new collection for it</span></label><input type="file" id="pjFiles" multiple accept=".pdf,.docx,.xlsx,.csv,.tsv,.txt,.md,.html,.htm,.json"><select id="pjCls" style="margin-top:8px">${Object.entries(admin.classifications).filter(([,v])=>v.allowed).map(([k,v])=>`<option value="${k}">${esc(v.label)}</option>`).join('')}</select><div id="pjLog" class="help"></div>`}
    <label>Who can use it <span style="font-weight:400;color:var(--dim)">— none checked = everyone</span></label><div id="pjGroups">${groupChecks(p?.groups||[])}</div>
    <div class="dlg-actions">${p?`<button class="btn danger" data-delproject="${p.id}">${ic('trash')}Delete</button><span class="grow"></span>`:''}<button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-act="saveproject" data-pid="${p?.id||''}">Save project</button></div>`,'xwide');
}
function adminKnowledge(){
  const cls=admin.classifications;
  $('#adminBody').innerHTML=`<div class="notice info" style="max-width:none;margin:0 0 16px">${ic('lock')}<span>Only <b>${Object.values(cls).filter(c=>c.allowed).map(c=>c.label).join('</b> and <b>')}</b> documents can be added. ${Object.values(cls).filter(c=>!c.allowed).map(c=>c.label).join(' and ')} documents are refused and never stored. Text is indexed on this server; only matching passages are sent to the AI, with personal identifiers masked${admin.settings.redaction.enabled?'':' (masking is currently OFF in Settings)'}.</span></div>
    <div class="bar"><div style="flex:1;color:var(--muted)">${admin.collections.length} collection${admin.collections.length===1?'':'s'}</div><button class="cta" data-act="addcol">${ic('plus')}New collection</button></div>
    ${admin.collections.map(c=>`<div class="col-card"><div class="col-head"><div><h3>${esc(c.name)}</h3><p>${c.local_only?`<span class="cls biasa">${ic('lock')}On this server only</span> `:''}${c.description?esc(c.description)+' · ':''}Access: ${c.groups.length?c.groups.map(g=>esc(g.name)).join(', '):'everyone'}</p></div><button class="btn sm" data-editcol="${c.id}">${ic('edit')}Edit</button><button class="btn sm primary" data-upcol="${c.id}">${ic('upload')}Upload</button></div>
      ${c.docs.length?c.docs.map(d=>`<div class="doc-row">${ic('file')}<span class="t" title="${esc(d.filename)}">${esc(d.title)}</span>${clsBadge(d.classification)}${d.sensitive?`<span class="cls terbatas" title="Personal-data values always masked">${ic('lock')}${d.sensitive} masked</span>`:''}<small>${d.status==='ready'?`${d.chunks} passage${d.chunks===1?'':'s'}${d.pages>1?' · '+d.pages+' pages':''}`:''}</small>${d.status==='ready'?'':`<span class="cls ${d.status}" title="${esc(d.error||'')}">${d.status==='error'?'Error':d.status}</span>`}<button class="icon-btn" data-deldoc="${d.id}" title="Delete">${ic('trash')}</button></div>${d.error?`<div class="help" style="color:var(--red);padding:0 0 8px 30px">${esc(d.error)}</div>`:''}`).join(''):'<div class="empty" style="padding:6px 0">No documents yet. Upload PDF, DOCX, TXT, MD, CSV or HTML files.</div>'}</div>`).join('')}`;
}
function colModal(c){ modalDone=null; openModal(`<h3>${c?'Edit collection':'New collection'}</h3><p class="s">A collection is a set of documents with the same audience, for example “Regulations” or “Directorate A reports”.</p><label for="cName">Name</label><input type="text" id="cName" value="${esc(c?.name||'')}" autofocus><label for="cDesc">Description</label><input type="text" id="cDesc" value="${esc(c?.description||'')}"><label>Who can search it <span style="font-weight:400;color:var(--dim)">— leave all unchecked for everyone</span></label><div id="cGroups">${groupChecks(c?.groups.map(g=>g.id)||[])}</div>
  <label>Privacy</label><div class="checks"><label><input type="checkbox" id="cLocal" ${c?.local_only?'checked':''}>Keep on this server only — never sent to cloud AI (Claude/GPT)</label></div>
  <div class="help">For patient records and other highly sensitive data. These documents can only be read by the on-premise AI model${admin.providers.local?'':' (not configured yet — set CANOPUS_LOCAL_BASE_URL)'} and by direct document search, which uses no AI at all.</div><div class="dlg-actions">${c?`<button class="btn danger" data-delcol="${c.id}">${ic('trash')}Delete collection</button><span class="grow"></span>`:''}<button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-act="savecol" data-cid="${c?.id||''}">Save</button></div>`,'wide'); }
function uploadModal(cid){
  const c=admin.collections.find(x=>x.id===cid); const cls=admin.classifications; modalDone=null;
  openModal(`<h3>Upload to “${esc(c.name)}”</h3><p class="s">Choose the security classification that applies to <b>all</b> files in this upload.</p>
    <label for="docCls">Classification</label><select id="docCls">${Object.entries(cls).map(([k,v])=>`<option value="${k}" ${k==='biasa'?'selected':''}>${esc(v.label)}${v.allowed?'':' — not allowed'}</option>`).join('')}</select>
    <label for="docFiles">Files</label><input type="file" id="docFiles" multiple accept=".pdf,.docx,.xlsx,.csv,.tsv,.txt,.md,.html,.htm,.json">
    <div class="help">PDF (with selectable text), DOCX, XLSX, CSV, TXT, MD, HTML · max ${me.config.maxUploadMb} MB each. Scanned PDFs need OCR first. In spreadsheets, columns such as Nama, NIK, No RM, Alamat, HP and Tgl Lahir are detected automatically and always masked before reaching the AI.</div><div id="upLog" class="help"></div>
    <div class="dlg-actions"><button class="btn" data-dlg="cancel">Close</button><button class="btn primary" data-act="douploaddocs" data-cid="${cid}">Upload</button></div>`,'wide');
}
function adminModels(){
  const s=admin.settings; const pv=admin.providers; const cats=admin.categories;
  const enabled=admin.models.filter(m=>s.models.includes(m.id)&&pv[m.provider]);
  const row=m=>`<div class="set-row"><div><b>${esc(m.label)}</b><small>${esc(m.d)} · ${esc(m.tier)}${m.vision?' · reads images':''}${m.provider!=='local'&&m.price?` · $${m.price.in}/$${m.price.out} per M tokens`:''}</small></div>${m.provider!=='anthropic'?`<button class="icon-btn" data-editoa="${m.id}" data-prov="${m.provider}" title="Edit">${ic('edit')}</button>`:''}<button class="switch ${s.models.includes(m.id)?'on':''}" data-setmodel="${m.id}" role="switch" aria-checked="${s.models.includes(m.id)}" aria-label="${esc(m.label)}" ${pv[m.provider]?'':'disabled title="Provider not configured"'}></button></div>`;
  $('#adminBody').innerHTML=`<div class="set-sec"><h3>Providers</h3><p>API keys live only in the server's <span class="mono">.env</span> file. They are never shown or sent to browsers.</p>
      <div class="set-row"><div><b>Anthropic · Claude</b><small><span class="mono">ANTHROPIC_API_KEY</span></small></div>${pv.anthropic?'<span class="cls biasa">Connected</span>':'<span class="cls error">Not configured</span>'}</div>
      <div class="set-row"><div><b>OpenAI · GPT</b><small><span class="mono">OPENAI_API_KEY</span></small></div>${pv.openai?'<span class="cls biasa">Connected</span>':'<span class="cls error">Not configured</span>'}</div></div>
    <div class="set-sec"><h3>Claude models</h3><p>Built in. Swift is the cheapest, Prime the most capable.</p>${admin.models.filter(m=>m.provider==='anthropic').map(row).join('')}</div>
    <div class="set-sec"><h3>OpenAI models</h3><p>Add the GPT models your organization wants to use. Enter the exact model ID from your OpenAI account and its price per million tokens (used for budgets).</p>
      ${admin.models.filter(m=>m.provider==='openai').map(row).join('')||'<div class="help">None yet.</div>'}
      <div style="display:flex;gap:8px;margin-top:10px"><button class="btn sm" data-editoa="">${ic('plus')}Add OpenAI model</button>${pv.openai?`<button class="btn sm" data-act="listoa">${ic('search')}See available model IDs</button>`:''}</div><div id="oaList" class="help"></div></div>
    <div class="set-sec"><h3>On-premise model <span class="cls biasa" style="margin-left:6px">${ic('lock')}data stays inside</span></h3><p>An AI model running on your own server (OpenAI-compatible API such as Ollama or vLLM, address in <span class="mono">CANOPUS_LOCAL_BASE_URL</span>). It is the only model allowed to read collections marked “On this server only”, and chats that used it never move to cloud AI.</p>
      <div class="set-row"><div><b>Local AI server</b><small class="mono">CANOPUS_LOCAL_BASE_URL</small></div>${pv.local?'<span class="cls biasa">Connected</span>':'<span class="cls error">Not configured</span>'}</div>
      ${admin.models.filter(m=>m.provider==='local').map(row).join('')}
      <button class="btn sm" style="margin-top:10px" data-editoa="" data-prov="local">${ic('plus')}Add local model</button></div>
    <div class="set-sec"><h3>Auto routing</h3><p>When someone chooses <b>Auto</b>, a quick, low-cost check decides what kind of request it is, then uses the model you pick for that kind. People's group permissions still apply.</p>
      <table class="tbl rt"><tbody>${Object.entries(cats).filter(([k])=>s.canvas||k!=='visual').map(([k,c])=>`<tr><td><b>${esc(c.label)}</b><div class="muted">${esc(c.d)}</div></td><td class="r"><select data-rule="${k}">${enabled.map(m=>`<option value="${m.id}" ${s.routing.rules[k]===m.id?'selected':''}>${esc(m.label)}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table>
      <div class="set-row"><div><b>Automatic failover</b><small>If a provider is down or rate-limited before answering, retry once with the closest model from the other provider.</small></div><button class="switch ${s.routing.failover?'on':''}" data-settoggle="failover" role="switch" aria-checked="${s.routing.failover}"></button></div>
      <div class="set-row"><div><b>Default for new chats</b></div><select id="defModel"><option value="auto" ${s.defaultModel==='auto'?'selected':''}>Auto</option>${enabled.map(m=>`<option value="${m.id}" ${s.defaultModel===m.id?'selected':''}>${esc(m.label)}</option>`).join('')}</select></div></div>
    <div class="save-bar"><button class="btn primary" data-act="savemodels">Save models</button></div>`;
}
function oaModal(m, prov='openai'){
  modalDone=null; const local=prov==='local';
  openModal(`<h3>${m?'Edit':'Add'} ${local?'local':'OpenAI'} model</h3><p class="s">${local?'Use the model name exactly as your local server lists it (for Ollama, the name shown by <span class="mono">ollama list</span>). Local models cost nothing per token.':'Use the exact model ID from your OpenAI account. Prices are per million tokens, from OpenAI&#39;s pricing page; they are used for budgets and the Usage page.'}</p>
    <div class="row2"><div><label for="oaApi">Model ID</label><input type="text" id="oaApi" value="${esc(m?.api||'')}" autofocus></div><div><label for="oaLabel">Name shown to people</label><input type="text" id="oaLabel" value="${esc(m?.label||'')}" placeholder="e.g. GPT Standard"></div></div>
    <div class="row2"><div><label for="oaTier">Tier</label><select id="oaTier">${['light','standard','advanced'].map(t=>`<option value="${t}" ${m?.tier===t?'selected':''}>${t}</option>`).join('')}</select></div><div><label>Capabilities</label><div class="checks"><label><input type="checkbox" id="oaVision" ${m?.vision?'checked':''}>Reads images</label>${local?'':`<label><input type="checkbox" id="oaReason" ${m?.reasoning?'checked':''}>Reasoning model</label>`}</div></div></div>
    ${local?'':`<div class="row2"><div><label for="oaIn">Input $ / M tokens</label><input type="text" id="oaIn" value="${m?.price?.in??''}"></div><div><label for="oaOut">Output $ / M tokens</label><input type="text" id="oaOut" value="${m?.price?.out??''}"></div></div>
    <label for="oaCached">Cached input $ / M tokens <span style="font-weight:400;color:var(--dim)">— optional</span></label><input type="text" id="oaCached" value="${m&&m.price&&m.price.cacheRead!==m.price.in?m.price.cacheRead:''}">
    <div class="help">“Reasoning model” sends the Quick/Balanced/Deep setting as reasoning effort; only tick it for models that support that parameter.</div>`}
    <div class="dlg-actions">${m?`<button class="btn danger" data-deloa="${m.id}">${ic('trash')}Remove</button><span class="grow"></span>`:''}<button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-act="saveoa" data-mid="${m?.id||''}" data-prov="${prov}">Save</button></div>`,'wide');
}
function adminSettings(){
  const s=admin.settings;
  $('#adminBody').innerHTML=`<div class="set-sec"><h3>Privacy & safety</h3><p>How data is handled before anything is sent to an AI provider.</p>
      <div class="set-row"><div><b>Mask sensitive data</b><small>Replace NIK, NIP, NPWP, emails, phone numbers, values from personal-data columns in spreadsheets, and the terms below with placeholders before sending; restored only on screen. PDFs are converted to text so they can be masked.</small></div><button class="switch ${s.redaction.enabled?'on':''}" data-settoggle="redaction" role="switch" aria-checked="${s.redaction.enabled}"></button></div>
      <div style="padding:6px 0 4px"><b style="font-size:14px">Extra terms to mask</b><div class="help" style="margin:2px 0 8px">One per line — names of people, project codenames, locations… (at least 3 characters).</div><textarea id="setTerms">${esc(s.redaction.terms.join('\n'))}</textarea></div>
      <div style="padding:6px 0 4px"><b style="font-size:14px">Extra spreadsheet columns to mask</b><div class="help" style="margin:2px 0 8px">Names, NIK, No RM, address, phone, email and date of birth are detected automatically. Add other column names whose values must never reach cloud AI, one per line (e.g. Diagnosa, Riwayat Penyakit). Applies to files uploaded after saving.</div><textarea id="setCols" placeholder="Diagnosa">${esc((s.redaction.columns||[]).join('\n'))}</textarea></div>
      <div class="set-row"><div><b>Allow image uploads</b><small>Images cannot be masked; turn off if screenshots may contain sensitive data.</small></div><button class="switch ${s.imageUploads?'on':''}" data-settoggle="imageUploads" role="switch" aria-checked="${s.imageUploads}"></button></div>
      <div class="set-row"><div><b>Allow web search</b><small>For public information, with source links (Claude models). Search queries go to the search provider.</small></div><button class="switch ${s.webSearch?'on':''}" data-settoggle="webSearch" role="switch" aria-checked="${s.webSearch}"></button></div>
      <div class="set-row"><div><b>Allow canvases (dashboards, infographics)</b><small>Off = text answers only, which also uses fewer tokens.</small></div><button class="switch ${s.canvas?'on':''}" data-settoggle="canvas" role="switch" aria-checked="${!!s.canvas}"></button></div></div>
    <div class="set-sec"><h3>Budgets & limits</h3><p>Estimated from list prices. 0 = unlimited. Individual users and groups can have their own budgets.</p>
      <div class="set-row"><div><b>Default monthly budget per user (USD)</b></div><input type="number" id="setBudget" min="0" step="0.5" value="${s.monthlyBudgetUsd}" style="width:120px"></div>
      <div class="set-row"><div><b>Requests per minute per user</b></div><input type="number" id="setPerMin" min="0" value="${s.rateLimits.perMinute}" style="width:120px"></div>
      <div class="set-row"><div><b>Requests per day per user</b></div><input type="number" id="setPerDay" min="0" value="${s.rateLimits.perDay}" style="width:120px"></div></div>
    <div class="set-sec"><h3>Organization skills</h3><p>Always-on instructions for everyone (house style, letter formats…).</p><div>${s.orgSkills.map((k,i)=>`<div class="set-row"><div><b>${esc(k.name)}</b><small>${esc(k.description||k.content.slice(0,90))}</small></div><button class="icon-btn" data-editorgskill="${i}">${ic('edit')}</button><button class="icon-btn" data-delorgskill="${i}">${ic('trash')}</button></div>`).join('')||'<div class="help">None yet.</div>'}</div><button class="btn sm" style="margin-top:10px" data-editorgskill="-1">${ic('plus')}Add skill</button></div>
    <div class="set-sec"><h3>Organization prompts</h3><p>Templates everyone sees first.</p><div>${s.orgPrompts.map((k,i)=>`<div class="set-row"><div><b>${esc(k.title)}</b><small>${esc(k.body.slice(0,100))}</small></div><button class="icon-btn" data-editorgprompt="${i}">${ic('edit')}</button><button class="icon-btn" data-delorgprompt="${i}">${ic('trash')}</button></div>`).join('')||'<div class="help">None yet.</div>'}</div><button class="btn sm" style="margin-top:10px" data-editorgprompt="-1">${ic('plus')}Add prompt</button></div>
    <div class="save-bar"><button class="btn primary" data-act="savesettingsadmin">Save settings</button></div>`;
}
const SCOPE_LABEL={'ask':'Ask questions','knowledge:read':'List knowledge','knowledge:write':'Upload knowledge'};
const WEBHOOK_EVENTS={'budget.warning':'A user reached 80% of their budget','budget.exhausted':'A user used their whole budget','group_budget.warning':'A group reached 80% of its budget','group_budget.exhausted':'A group used its whole budget','knowledge.upload_refused':'A confidential upload was refused','user.created':'A user was invited'};
function adminIntegrations(){
  const s=admin.settings; const base=location.origin;
  $('#adminBody').innerHTML=`<div class="set-sec"><h3>API tokens (n8n, scripts)</h3><p>Let automations ask Canopus questions or add knowledge. A token acts as the user you choose, with that user's groups, budget and limits. The AI provider keys are never exposed.</p>
      ${admin.tokens.length?`<div class="tblwrap" style="margin-bottom:10px"><table class="tbl"><thead><tr><th>Name</th><th>Acts as</th><th>Permissions</th><th>Last used</th><th></th></tr></thead><tbody>${admin.tokens.map(t=>`<tr><td><b>${esc(t.name)}</b><div class="muted mono">${esc(t.prefix)}…</div></td><td>${esc(t.email)}</td><td>${t.scopes.map(x=>`<span class="gchip">${esc(SCOPE_LABEL[x]||x)}</span>`).join('')}</td><td class="muted">${t.revoked?'<span class="cls error">Revoked</span>':t.last_used?ago(t.last_used):'never'}</td><td class="r">${t.revoked?'':`<button class="icon-btn" data-revoketoken="${t.id}" title="Revoke">${ic('trash')}</button>`}</td></tr>`).join('')}</tbody></table></div>`:''}
      <button class="btn sm" data-act="addtoken">${ic('plus')}Create token</button>
      <details style="margin-top:14px"><summary class="help" style="cursor:pointer">How to call it from n8n</summary><pre class="quote mono" style="white-space:pre-wrap">POST ${esc(base)}/api/v1/ask
Authorization: Bearer cnp_…
Content-Type: application/json

{"question": "Ringkas isu utama minggu ini", "model": "auto", "knowledge": true}

→ {"answer": "…", "model": {…}, "citations": [{"title": "…", "text": "…"}], "usage": {…}}

POST ${esc(base)}/api/v1/collections/&lt;collection-id&gt;/docs   (body = the file)
X-Filename: laporan.pdf
X-Classification: biasa</pre></details></div>
    <div class="set-sec"><h3>Webhook notifications</h3><p>Canopus POSTs JSON to this URL when the selected events happen (for example an n8n “Webhook” node that sends email or chat messages). Each request is signed: <span class="mono">X-Canopus-Signature: sha256=HMAC(secret, body)</span>.</p>
      <label class="help" for="whUrl" style="display:block;margin-bottom:6px">URL</label><input type="url" id="whUrl" value="${esc(s.webhook.url)}" placeholder="https://n8n.kantor.go.id/webhook/canopus" style="width:100%;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:9px 11px;color:var(--fg)">
      <div class="checks" id="whEvents" style="margin:12px 0">${Object.entries(WEBHOOK_EVENTS).map(([k,l])=>`<label><input type="checkbox" value="${k}" ${s.webhook.events.includes(k)?'checked':''}>${esc(l)}</label>`).join('')}</div>
      ${s.webhook.url?`<div class="set-row"><div><b>Signing secret</b><small class="mono">${esc(s.webhook.secret)}</small></div><button class="btn sm" data-act="showsecret">Show</button><button class="btn sm" data-act="rotatesecret">Rotate</button><button class="btn sm" data-act="testwebhook">Send test</button></div>`:''}
      <div class="save-bar"><button class="btn primary" data-act="savewebhook">Save webhook</button></div></div>`;
}
let usageMonth=new Date().toISOString().slice(0,7);
async function adminUsage(){
  const u=await api('/api/admin/usage?month='+usageMonth);
  $('#adminBody').innerHTML=`<div class="bar"><label class="set-sec" style="margin:0;padding:8px 12px;display:flex;gap:10px;align-items:center">Month <input type="month" id="usageMonth" value="${u.month}"></label><div class="stat" style="flex:0 1 220px"><small>Estimated total</small><b>${usd(u.total)}</b></div></div>
    <div class="tblwrap" style="margin-bottom:16px"><table class="tbl"><thead><tr><th>User</th><th class="r">Requests</th><th class="r">Input tokens</th><th class="r">Output tokens</th><th class="r">Estimated cost</th></tr></thead><tbody>${u.rows.map(r=>`<tr><td><b>${esc(r.name||'—')}</b><div class="muted">${esc(r.email||'deleted user')}</div></td><td class="r">${r.requests}</td><td class="r">${fmtTok(r.input)}</td><td class="r">${fmtTok(r.output)}</td><td class="r">${usd(r.cost)}</td></tr>`).join('')||'<tr><td colspan="5" class="muted">No usage this month.</td></tr>'}</tbody></table></div>
    <div class="tblwrap"><table class="tbl"><thead><tr><th>Model</th><th class="r">Requests</th><th class="r">Estimated cost</th></tr></thead><tbody>${u.byModel.map(r=>`<tr><td>${esc(r.model)}</td><td class="r">${r.requests}</td><td class="r">${usd(r.cost)}</td></tr>`).join('')||'<tr><td colspan="3" class="muted">—</td></tr>'}</tbody></table></div>
    ${admin.groups.some(g=>g.budget_usd>0||g.spent>0)?`<div class="tblwrap" style="margin-top:16px"><table class="tbl"><thead><tr><th>Group (this month)</th><th class="r">Spent</th><th class="r">Budget</th></tr></thead><tbody>${admin.groups.map(g=>`<tr><td>${esc(g.name)}</td><td class="r">${usd(g.spent)}</td><td class="r">${g.budget_usd>0?usd(g.budget_usd):'—'}</td></tr>`).join('')}</tbody></table></div>`:''}
    <div class="help" style="margin-top:10px">Estimates use list prices (Claude built in, OpenAI as entered in Models), including prompt-cache discounts. Your Anthropic Console and OpenAI dashboard show the billed amounts.</div>`;
  $('#usageMonth').onchange=e=>{ usageMonth=e.target.value; adminUsage(); };
}
let auditFilter='';
async function adminAudit(){
  const rows=await api('/api/admin/audit?limit=300'+(auditFilter?'&action='+auditFilter:''));
  const label={'auth.login':'Signed in','auth.login_failed':'Failed sign-in','auth.totp_failed':'Wrong 2FA code','auth.totp_enrolled':'Set up 2FA','auth.password_ok':'Password accepted','admin.user_2fa_reset':'Reset 2FA','knowledge.direct_search':'Direct search','auth.logout':'Signed out','auth.password_set':'Set password','auth.password_changed':'Changed password','knowledge.search':'Knowledge search','knowledge.open':'Opened document','knowledge.upload':'Uploaded document','knowledge.upload_refused':'Upload refused','knowledge.delete':'Deleted document','redaction.applied':'Data masked','admin.user_created':'Invited user','admin.user_updated':'Changed user','admin.user_reset':'New sign-in link','admin.group_created':'Created group','admin.group_deleted':'Deleted group','admin.collection_created':'Created collection','admin.collection_updated':'Changed collection','admin.collection_deleted':'Deleted collection','admin.settings_updated':'Changed settings','admin.group_updated':'Changed group','admin.project_created':'Created project','admin.project_updated':'Changed project','admin.project_deleted':'Deleted project','admin.token_created':'Created API token','admin.token_revoked':'Revoked API token','api.ask':'API question','ai.failover':'Switched AI provider','budget.warning':'Budget 80%','budget.exhausted':'Budget used up','group_budget.warning':'Group budget 80%','group_budget.exhausted':'Group budget used up','webhook.failed':'Webhook failed'};
  const detail=r=>{ const d=r.detail||{}; if(r.action==='knowledge.search') return `“${esc(d.query)}” → ${d.results?.length||0} passage(s)`; if(d.title) return esc(d.title)+(d.classification?` (${esc(d.classification)})`:''); if(d.user) return esc(d.user); if(d.count) return `${d.count} value(s) masked`; if(d.file) return esc(d.file)+` (${esc(d.classification)})`; return esc(Object.entries(d).map(([k,v])=>`${k}: ${Array.isArray(v)?v.join(', '):v}`).join(' · ')).slice(0,160); };
  $('#adminBody').innerHTML=`<div class="bar"><div class="pills">${[['','All'],['auth','Sign-ins'],['knowledge','Knowledge'],['admin','Admin changes'],['redaction','Masking']].map(([k,l])=>`<button class="pill ${auditFilter===k?'on':''}" data-afilter="${k}">${l}</button>`).join('')}</div></div>
    <div class="tblwrap"><table class="tbl"><thead><tr><th>Time</th><th>User</th><th>Event</th><th>Detail</th><th>IP</th></tr></thead><tbody>${rows.map(r=>`<tr><td class="muted" style="white-space:nowrap">${fmtDT(r.ts)}</td><td>${esc(r.email||'—')}</td><td>${esc(label[r.action]||r.action)}</td><td>${detail(r)}</td><td class="muted">${esc(r.ip||'')}</td></tr>`).join('')||'<tr><td colspan="5" class="muted">No events.</td></tr>'}</tbody></table></div>`;
}

/* ================= Dialogs ================= */
let modalDone=null;
function openModal(html,cls=''){ const m=$('#modal'); m.innerHTML=`<div class="dlg ${cls}" role="dialog" aria-modal="true">${html}</div>`; m.hidden=false; hydrateIcons(m); const f=m.querySelector('[autofocus]'); if(f) setTimeout(()=>f.focus(),30); }
function closeModal(v=null){ $('#modal').hidden=true; $('#modal').innerHTML=''; const d=modalDone; modalDone=null; d&&d(v); }
function ask(title,{value='',placeholder='',ok='Save',sub=''}={}){ return new Promise(res=>{ modalDone=res; openModal(`<h3>${esc(title)}</h3>${sub?`<p class="s">${esc(sub)}</p>`:''}<input type="text" id="askIn" value="${esc(value)}" placeholder="${esc(placeholder)}" autofocus><div class="dlg-actions"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-dlg="ok">${esc(ok)}</button></div>`); setTimeout(()=>$('#askIn')?.select(),40); }); }
function confirmBox(title,sub,ok='Delete'){ return new Promise(res=>{ modalDone=res; openModal(`<h3>${esc(title)}</h3><p class="s">${esc(sub)}</p><div class="dlg-actions"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-dlg="yes" autofocus style="background:var(--red);color:#fff">${esc(ok)}</button></div>`); }); }
function openSettings(){
  modalDone=null; const b=me.budget;
  openModal(`<h3>Settings</h3><p class="s">Signed in as <b>${esc(me.user.email)}</b>${me.groups.length?` · ${me.groups.map(g=>esc(g.name)).join(', ')}`:''}</p>
    <label for="sName">Your name</label><input type="text" id="sName" value="${esc(me.user.name)}">
    <label for="sInstr">Custom instructions</label><textarea id="sInstr" placeholder="Your role, preferred language, tone, formats…">${esc(state.instructions)}</textarea>
    <label>Theme</label><div class="seg"><button type="button" data-settheme="dark" class="${state.theme==='dark'?'on':''}">Dark</button><button type="button" data-settheme="light" class="${state.theme==='light'?'on':''}">Light</button></div>
    <label>Two-step verification</label><div style="font-size:14px">${me.user.twoFactor?'✅ On (authenticator app)':'Off'}</div>
    <label>AI usage this month</label><div style="font-size:14px">${usd(b.spent)}${b.limit>0?` of ${usd(b.limit)}`:''}</div>${b.limit>0?`<div class="budget"><i style="width:${Math.min(100,b.spent/b.limit*100)}%"></i></div>`:''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:18px"><button class="btn sm" data-act="changepw">${ic('lock')}Change password</button><button class="btn sm" data-act="export">${ic('download')}Export my workspace</button><button class="btn sm danger" data-act="clear">${ic('trash')}Delete all chats</button><button class="btn sm" data-act="logout">${ic('logout')}Sign out</button></div>
    <div class="dlg-actions"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-act="savesettings">Save</button></div>`,'wide');
}
function openSearch(){
  modalDone=null; $('#modal').innerHTML=`<div class="dlg palette"><label class="search">${ic('search')}<input id="palQ" placeholder="Search chats, Studio, files and prompts…"></label><div class="res" id="palRes"></div></div>`; $('#modal').hidden=false;
  const q=$('#palQ'); const draw=()=>{ const s=q.value.trim().toLowerCase(); const hit=t=>(t||'').toLowerCase().includes(s);
    const chats=state.chats.filter(c=>!s||hit(c.title)||c.msgs.some(m=>hit(m.text)||hit(botText(m)))).sort((a,b)=>b.updated-a.updated).slice(0,12);
    const cvs=state.canvases.filter(c=>s&&hit(c.title)).slice(0,5), fs=state.files.filter(f=>s&&hit(f.name)).slice(0,5), ps=allPrompts().filter(p=>s&&hit(p.title)).slice(0,4);
    $('#palRes').innerHTML=(chats.map(c=>`<div class="row-item" data-open="${c.id}" role="button">${ic('chat','c-muted')}<span>${esc(c.title)}</span><small>${ago(c.updated)}</small></div>`).join('')+cvs.map(c=>`<div class="row-item" data-copen="${c.id}" role="button">${ic('layers','c-orange')}<span>${esc(c.title)}</span><small>Studio</small></div>`).join('')+fs.map(f=>`<div class="row-item" data-fuse="${f.id}" role="button">${ic('archive','c-sky')}<span>${esc(f.name)}</span><small>File</small></div>`).join('')+ps.map(p=>`<div class="row-item" data-useprompt="${p.id}" role="button">${ic('bolt','c-violet')}<span>${esc(p.title)}</span><small>Prompt</small></div>`).join(''))||`<div class="empty">${s?'Nothing found':'No chats yet'}</div>`; };
  q.addEventListener('input',draw); draw(); setTimeout(()=>q.focus(),30);
}
let pickCb=null;
function pickSources(onPick,title='Add from My files',sub='Choose files to attach to your message.'){
  if(!state.files.length){ toast('No files yet'); return; } modalDone=null; pickCb=onPick;
  openModal(`<h3>${esc(title)}</h3><p class="s">${esc(sub)}</p><div style="max-height:46vh;overflow:auto;margin:0 -6px">${state.files.map(f=>`<label class="pick"><input type="checkbox" value="${f.id}"><div class="f-ic" style="width:34px;height:34px">${f.thumb?`<img src="${f.thumb}" alt="">`:ic(FTYPES.find(t=>t.id===f.ftype)?.ic||'file')}</div><div class="f-meta"><b>${esc(f.name)}</b><small>${fmtSize(f.size||0)}</small></div></label>`).join('')}</div><div class="dlg-actions"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-act="picked">Add</button></div>`,'wide');
}
function showPassage(title, text, docId, page){ modalDone=null; openModal(`<h3>${esc(title)}</h3><p class="s">The passage Canopus used${page?` (page ${page})`:''}.</p><div class="quote">${esc(text)}</div><div class="dlg-actions"><button class="btn" data-dlg="cancel">Close</button>${docId?`<a class="btn primary" href="/api/knowledge/docs/${esc(docId)}/file${page?'#page='+page:''}" target="_blank" rel="noopener">${ic('eye')}Open document</a>`:''}</div>`,'wide'); }

/* ================= Screen capture & dictation ================= */
async function captureScreen(){
  try{ const s=await navigator.mediaDevices.getDisplayMedia({video:true}); const v=document.createElement('video'); v.srcObject=s; v.muted=true; await v.play(); await new Promise(r=>setTimeout(r,350));
    const c=document.createElement('canvas'); c.width=v.videoWidth; c.height=v.videoHeight; c.getContext('2d').drawImage(v,0,0); s.getTracks().forEach(t=>t.stop());
    const blob=await new Promise(r=>c.toBlob(r,'image/png')); await addAttachments([new File([blob],`screenshot-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.png`,{type:'image/png'})]); }
  catch(e){ if(e.name!=='NotAllowedError') toast('Screen capture is not available here'); }
}
let rec=null;
function dictate(btn){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition; if(!SR){ toast('Dictation is not supported in this browser. Try Chrome or Edge.'); return; }
  if(rec){ rec.stop(); return; }
  rec=new SR(); rec.lang=navigator.language||'en-US'; rec.interimResults=false; rec.continuous=true; btn.classList.add('rec'); toast('Listening… click the mic again to stop');
  rec.onresult=ev=>{ for(let i=ev.resultIndex;i<ev.results.length;i++) if(ev.results[i].isFinal) input.value+=(input.value&&!input.value.endsWith(' ')?' ':'')+ev.results[i][0].transcript; autosize(); };
  rec.onend=()=>{ btn.classList.remove('rec'); rec=null; }; rec.onerror=e=>{ if(e.error==='not-allowed') toast('Microphone permission was denied'); }; rec.start();
}

/* ================= Actions ================= */
function closeMenus(except){ document.querySelectorAll('.menu.open:not(.float-menu)').forEach(m=>{ if(m!==except) m.classList.remove('open'); }); }
function openChat(id){ state.current=id; editing=-1; save(); closeModal(); closePanel(); if(curView()==='home') route(); else go('home'); }
function floatMenu(anchor,html){ const r=anchor.getBoundingClientRect(); const m=document.createElement('div'); m.className='menu open float-menu'; m.style.cssText=`top:${Math.min(r.bottom+4,innerHeight-270)}px;left:${Math.max(8,Math.min(r.right-210,innerWidth-220))}px;bottom:auto;min-width:210px`; m.innerHTML=html; document.body.appendChild(m); }
function chatMenuHTML(c){ return `<button data-crn="${c.id}">${ic('edit')}Rename</button><button data-cpin="${c.id}">${ic('pin')}${c.pinned?'Unpin':'Pin'}</button><button data-cmove="${c.id}">${ic('folder')}Move to space…</button><button data-cexport="${c.id}">${ic('download')}Export Markdown</button><div class="m-sep"></div><button class="danger" data-del="${c.id}">${ic('trash')}Delete</button>`; }
function chatMarkdown(c){ let md=`# ${c.title}\n\n_Exported from Canopus · ${new Date().toLocaleString()}_\n\n`; for(const m of c.msgs){ if(m.r==='user') md+=`## You\n\n${m.text||''}${m.atts?.length?`\n\n_Attachments: ${m.atts.map(a=>a.name).join(', ')}_`:''}\n\n`; else if(botText(m)){ md+=`## Canopus\n\n${botText(m)}\n\n`; const docs=[...new Set((m.citations||[]).filter(x=>x.kind==='doc').map(x=>x.title))]; if(docs.length) md+=`_Sources: ${docs.join('; ')}_\n\n`; } } return md; }
function newChat(){ state.current=null; pendingSpace=null; editing=-1; closePanel(); save(); go('home'); setTimeout(()=>input.focus(),20); }
const checked=sel=>[...document.querySelectorAll(sel+' input[type=checkbox]:checked')].map(i=>i.value);

document.addEventListener('click',async e=>{
  if(e.target.id==='modal'){ closeModal(); return; }
  const t=e.target.closest('button,[data-open],[data-go],[data-space],[data-project],[data-copen],[data-fuse],[data-useprompt],[data-act],.scrim');
  document.querySelectorAll('.float-menu').forEach(x=>x.remove());
  if(!t){ closeMenus(); return; }
  const d=t.dataset;
  if(d.menu){ const m=document.getElementById(d.menu); closeMenus(m); m.classList.toggle('open'); return; }
  closeMenus();
  try{
  if(d.dlg){ if(d.dlg==='ok') closeModal($('#askIn')?.value??true); else if(d.dlg==='yes') closeModal(true); else closeModal(null); return; }
  if(d.go){ if(d.tab) adminTab=d.tab; if(d.go==='home'){ state.current=null; pendingSpace=null; save(); closePanel(); } go(d.go); return; }
  if(d.chatmenu){ e.stopPropagation(); const c=state.chats.find(x=>x.id===d.chatmenu); if(c) floatMenu(t,chatMenuHTML(c)); return; }
  if(d.cmenu){ const c=state.canvases.find(x=>x.id===d.cmenu); floatMenu(t,`<button data-copen="${c.id}">${ic('eye')}Open</button><button data-crename="${c.id}">${ic('edit')}Rename</button><button data-cdl="${c.id}">${ic('download')}Download HTML</button>${c.chatId&&state.chats.some(x=>x.id===c.chatId)?`<button data-cchat="${c.id}">${ic('chat')}Open its chat</button>`:''}<div class="m-sep"></div><button class="danger" data-cdel="${c.id}">${ic('trash')}Delete</button>`); return; }
  if(d.model){ state.model=d.model; save(); updateTools(); return; }
  if(d.mode){ state.mode=d.mode; save(); updateTools(); return; }
  if(d.sort){ state.sort=d.sort; save(); renderStudio(); return; }
  if(d.rmchip!==undefined){ attachments.splice(+d.rmchip,1); renderChips(); return; }
  if(d.editprompt){ e.stopPropagation(); editPrompt(d.editprompt); return; }
  if(d.delprompt){ e.stopPropagation(); if(await confirmBox('Delete prompt?','This template will be removed.')){ state.prompts=state.prompts.filter(p=>p.id!==d.delprompt); save(); renderPrompts(); } return; }
  if(d.useprompt){ closeModal(); usePrompt(d.useprompt); return; }
  if(d.cpin){ const c=state.chats.find(x=>x.id===d.cpin); c.pinned=!c.pinned; save(); renderSide(); renderHead(); return; }
  if(d.cexport){ const c=state.chats.find(x=>x.id===d.cexport); downloadText(safeName(c.title)+'.md', chatMarkdown(c), 'text/markdown'); return; }
  if(d.del){ const c=state.chats.find(x=>x.id===d.del); if(await confirmBox('Delete chat?',`“${c.title}” will be permanently deleted.`)){ running.get(c.id)?.abort(); state.chats=state.chats.filter(x=>x.id!==d.del); if(state.current===d.del){ state.current=null; closePanel(); } save(); route(); } return; }
  if(d.crn){ const c=state.chats.find(x=>x.id===d.crn); const n=await ask('Rename chat',{value:c.title}); if(n&&n.trim()){ c.title=n.trim(); c.titled=true; save(); route(); } return; }
  if(d.cmove){ const c=state.chats.find(x=>x.id===d.cmove); modalDone=null; openModal(`<h3>Move to space</h3><p class="s">Chats in a space follow its instructions and see its reference files.</p>${state.spaces.map(s=>`<div class="row-item" data-movechat="${c.id}" data-to="${s.id}" role="button"><i class="dotc" style="background:${s.color}"></i><span>${esc(s.name)}</span>${c.spaceId===s.id?ic('check','c-gold'):''}</div>`).join('')}<div class="row-item" data-movechat="${c.id}" data-to="" role="button">${ic('x','c-muted')}<span>No space</span></div><div class="dlg-actions"><button class="btn" data-dlg="cancel">Close</button></div>`); return; }
  if(d.movechat!==undefined){ const c=state.chats.find(x=>x.id===d.movechat); c.spaceId=d.to||null; save(); closeModal(); route(); return; }
  if(d.open){ openChat(d.open); return; }
  if(d.space){ go('space/'+d.space); return; }
  if(d.project){ state.current=null; pendingProject=d.project; pendingSpace=null; editing=-1; closePanel(); save(); if(curView()==='home') route(); else go('home'); setTimeout(()=>input.focus(),30); return; }
  if(d.copen){ closeModal(); const c=state.canvases.find(x=>x.id===d.copen); if(!c) return; if(!(curView()==='home'&&curChat())) panel.full=true; openCanvas(c.id, d.v!=null?+d.v:undefined); return; }
  if(d.ptab){ panel.tab=d.ptab; renderPanel(); return; }
  if(d.cchat){ const c=state.canvases.find(x=>x.id===d.cchat); if(c&&state.chats.some(x=>x.id===c.chatId)){ state.current=c.chatId; save(); panel.full=false; if(curView()==='home') route(); else go('home'); setTimeout(()=>openCanvas(c.id),30); } return; }
  if(d.cdl){ const c=state.canvases.find(x=>x.id===d.cdl); const v=panel.cid===c.id?panel.v:c.versions.length-1; downloadText(safeName(c.title)+(c.versions.length>1?`-v${v+1}`:'')+'.html', c.versions[v].html); return; }
  if(d.crename){ const c=state.canvases.find(x=>x.id===d.crename); const n=await ask('Rename',{value:c.title}); if(n&&n.trim()){ c.title=n.trim(); save(); renderPage(); if(panel.cid===c.id) renderPanel(); } return; }
  if(d.cdel){ if(await confirmBox('Delete from Studio?','All versions will be removed.')){ state.canvases=state.canvases.filter(c=>c.id!==d.cdel); if(panel.cid===d.cdel) closePanel(); save(); renderPage(); renderSide(); } return; }
  if(d.cite){ const [i,j]=d.cite.split(':').map(Number); const c=curChat().msgs[i].citations[j]; const r=docRef(c.source); showPassage(c.title, c.text, r?.docId, r?.page); return; }
  if(d.dshit!==undefined){ const h=dsHits[+d.dshit]; showPassage(h.title, h.text, h.docId, h.page); return; }
  if(d.found){ const [i,j]=d.found.split(':').map(Number); const f=curChat().msgs[i].found[j]; showPassage(f.title, f.text, f.docId, f.page); return; }
  if(d.askcol){ const c=knowledge.find(x=>x.id===d.askcol); state.current=null; go('home'); setTimeout(()=>{ input.value=`Using the internal documents in “${c.name}”, `; autosize(); input.focus(); },30); return; }
  if(d.ftype){ fType=d.ftype; renderSources(); return; }
  if(d.fdel){ if(await confirmBox('Delete file?','It will be removed from the server and from any space. Chats that used it can no longer resend it.')){ await api('/api/blobs/'+d.fdel,{method:'DELETE'}).catch(()=>{}); state.files=state.files.filter(f=>f.id!==d.fdel); state.spaces.forEach(s=>s.fileIds=(s.fileIds||[]).filter(x=>x!==d.fdel)); save(); renderSources(); renderSide(); } return; }
  if(d.fuse){ const f=state.files.find(x=>x.id===d.fuse); if(f){ closeModal(); state.current=null; closePanel(); attachments=[...attachments.filter(a=>a.id!==f.id), {...f}]; go('home'); setTimeout(()=>{ renderChips(); input.focus(); },20); } return; }
  if(d.unpinfile){ const sp=space(spaceId); sp.fileIds=sp.fileIds.filter(x=>x!==d.unpinfile); save(); renderSpace(); return; }
  if(d.color){ const sp=space(spaceId); sp.color=d.color; save(); renderSpace(); renderSide(); return; }
  if(d.stoggle){ const b=BUILTIN_SKILLS.find(x=>x.id===d.stoggle); if(b){ let s=state.skills.find(x=>x.id===b.id); if(!s){ s={id:b.id, builtin:true, enabled:false}; state.skills.push(s); } s.enabled=!s.enabled; } else { const s=state.skills.find(x=>x.id===d.stoggle); s.enabled=!s.enabled; } save(); renderSkills(); renderSide(); return; }
  if(d.sview){ const s=allSkills().find(x=>x.id===d.sview); modalDone=null; openModal(`<h3>${esc(s.name)}</h3><p class="s">${esc(s.description||'')}</p><pre style="white-space:pre-wrap;font:12.5px/1.55 var(--mono);background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:14px;max-height:50vh;overflow:auto">${esc(s.content)}</pre><div class="dlg-actions"><button class="btn" data-dlg="cancel">Close</button></div>`,'wide'); return; }
  if(d.sedit){ editSkill(d.sedit); return; }
  if(d.sdel){ if(await confirmBox('Delete skill?','Canopus will stop using these instructions.')){ state.skills=state.skills.filter(s=>s.id!==d.sdel); save(); renderSkills(); renderSide(); } return; }
  if(d.settheme){ state.theme=d.settheme; document.documentElement.dataset.theme=state.theme; t.parentElement.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b===t)); save(); return; }
  if(d.cp){ const code=t.parentElement.querySelector('code')?.innerText||''; navigator.clipboard.writeText(code).then(()=>{ t.textContent='Copied'; setTimeout(()=>t.textContent='Copy',1500); }); return; }
  if(d.copy!==undefined){ navigator.clipboard.writeText(botText(curChat().msgs[+d.copy])).then(()=>toast('Copied')); return; }
  if(d.copyu!==undefined){ navigator.clipboard.writeText(curChat().msgs[+d.copyu].text||'').then(()=>toast('Copied')); return; }
  if(d.edit!==undefined){ const c=curChat(); if(running.has(c.id)) return; editing=+d.edit; renderThread(); return; }
  // ---- admin ----
  if(d.atab){ adminTab=d.atab; renderAdmin(); return; }
  if(d.edituser){ userModal(admin.users.find(u=>u.id===d.edituser)); return; }
  if(d.resetuser){ const u=admin.users.find(x=>x.id===d.resetuser); if(await confirmBox('Create a new sign-in link?',`${u.email} will be signed out everywhere and must set a new password with the link.`,'Create link')){ const r=await api(`/api/admin/users/${u.id}/reset`,{method:'POST'}); showLink('New sign-in link', r.invite); } return; }
  if(d.delgroup){ if(await confirmBox('Delete group?','Members lose access to collections that were shared only with this group.')){ await api('/api/admin/groups/'+d.delgroup,{method:'DELETE'}); renderAdmin(); } return; }
  if(d.editcol){ colModal(admin.collections.find(c=>c.id===d.editcol)); return; }
  if(d.delcol){ if(await confirmBox('Delete collection?','All its documents are deleted from the server and can no longer be searched.')){ await api('/api/admin/collections/'+d.delcol,{method:'DELETE'}); closeModal(); refreshKnowledge(); renderAdmin(); } return; }
  if(d.upcol){ uploadModal(d.upcol); return; }
  if(d.deldoc){ if(await confirmBox('Delete document?','It will be removed from the server and the search index.')){ await api('/api/admin/docs/'+d.deldoc,{method:'DELETE'}); refreshKnowledge(); renderAdmin(); } return; }
  if(d.setmodel){ t.classList.toggle('on'); t.setAttribute('aria-checked', t.classList.contains('on')); return; }
  if(d.settoggle){ t.classList.toggle('on'); t.setAttribute('aria-checked', t.classList.contains('on')); return; }
  if(d.editorgskill!==undefined){ const i=+d.editorgskill; const k=i>=0?admin.settings.orgSkills[i]:{name:'',description:'',content:''}; modalDone=null; openModal(`<h3>${i>=0?'Edit':'Add'} organization skill</h3><p class="s">Applied to every user's chats.</p><label for="oskName">Name</label><input type="text" id="oskName" value="${esc(k.name)}" autofocus><label for="oskDesc">Description</label><input type="text" id="oskDesc" value="${esc(k.description)}"><label for="oskBody">Instructions</label><textarea id="oskBody" style="min-height:200px">${esc(k.content)}</textarea><div class="dlg-actions"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-act="saveorgskill" data-i="${i}">Save</button></div>`,'wide'); return; }
  if(d.delorgskill!==undefined){ admin.settings.orgSkills.splice(+d.delorgskill,1); await saveAdminSettings(); return; }
  if(d.editorgprompt!==undefined){ const i=+d.editorgprompt; const k=i>=0?admin.settings.orgPrompts[i]:{title:'',body:''}; modalDone=null; openModal(`<h3>${i>=0?'Edit':'Add'} organization prompt</h3><p class="s">Use {{blanks}} for parts people fill in.</p><label for="opTitle">Title</label><input type="text" id="opTitle" value="${esc(k.title)}" autofocus><label for="opBody">Prompt</label><textarea id="opBody" style="min-height:200px">${esc(k.body)}</textarea><div class="dlg-actions"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-act="saveorgprompt" data-i="${i}">Save</button></div>`,'wide'); return; }
  if(d.delorgprompt!==undefined){ admin.settings.orgPrompts.splice(+d.delorgprompt,1); await saveAdminSettings(); return; }
  if(d.afilter!==undefined){ auditFilter=d.afilter; adminAudit(); return; }
  if(d.editgroup){ groupModal(admin.groups.find(g=>g.id===d.editgroup)); return; }
  if(d.editproject){ projectModal(admin.projects.find(p=>p.id===d.editproject)); return; }
  if(d.delproject){ if(await confirmBox('Delete project?','Chats that used it keep their history, but can no longer use its instructions.')){ await api('/api/admin/projects/'+d.delproject,{method:'DELETE'}); closeModal(); await refreshMe(); renderAdmin(); } return; }
  if(d.editoa!==undefined){ oaModal(d.editoa?admin.models.find(m=>m.id===d.editoa):null, t.dataset.prov||'openai'); return; }
  if(d.deloa){ const key=d.deloa.startsWith('local:')?'localModels':'openaiModels'; admin.settings[key]=admin.settings[key].filter(m=>m.id!==d.deloa); admin.settings.models=admin.settings.models.filter(x=>x!==d.deloa); closeModal(); await saveAdminSettings(adminModels); return; }
  if(d.revoketoken){ if(await confirmBox('Revoke token?','Automations using it will stop working immediately.','Revoke')){ await api('/api/admin/tokens/'+d.revoketoken,{method:'DELETE'}); renderAdmin(); } return; }

  switch(d.act){
    case 'toggle': $('#app').classList.toggle('collapsed'); break;
    case 'new': newChat(); break;
    case 'search': openSearch(); break;
    case 'newspace': { const n=await ask('New space',{placeholder:'e.g. Daily Briefs', ok:'Create', sub:'A space groups related chats with shared instructions and reference files.'}); if(n&&n.trim()){ const s={id:uid(), name:n.trim(), instructions:'', color:SPACE_COLORS[state.spaces.length%6], fileIds:[]}; state.spaces.push(s); save(); go('space/'+s.id); } break; }
    case 'editspace': { const sp=space(spaceId); const n=await ask('Rename space',{value:sp.name}); if(n&&n.trim()){ sp.name=n.trim(); save(); route(); } break; }
    case 'delspace': { const sp=space(spaceId); if(await confirmBox('Delete space?',`“${sp.name}” will be deleted. Its chats are kept.`)){ state.chats.forEach(c=>{ if(c.spaceId===sp.id) c.spaceId=null; }); state.spaces=state.spaces.filter(x=>x.id!==sp.id); save(); go('home'); } break; }
    case 'spacechat': state.current=null; pendingSpace=spaceId; closePanel(); go('home'); setTimeout(()=>input.focus(),30); break;
    case 'spacefiles': pickSources(ids=>{ const sp=space(spaceId); sp.fileIds=[...new Set([...(sp.fileIds||[]),...ids])]; save(); renderSpace(); },'Add reference files','These files will be available in every chat in this space.'); break;
    case 'renamechat': { const c=curChat(); const n=await ask('Rename chat',{value:c.title}); if(n&&n.trim()){ c.title=n.trim(); c.titled=true; save(); renderSide(); renderHead(); } break; }
    case 'pinchat': { const c=curChat(); c.pinned=!c.pinned; save(); renderSide(); renderHead(); break; }
    case 'exportchat': { const c=curChat(); downloadText(safeName(c.title)+'.md', chatMarkdown(c), 'text/markdown'); break; }
    case 'newcanvas': state.current=null; closePanel(); go('home'); setTimeout(()=>{ input.value='Create an interactive one-page dashboard about '; autosize(); input.focus(); },30); break;
    case 'newprompt': editPrompt(null); break;
    case 'saveprompt': { const title=$('#ptTitle').value.trim(), body=$('#ptBody').value.trim(); if(!title||!body){ toast('Add a title and a prompt'); break; } const id=t.dataset.pid; const base=allPrompts().find(p=>p.id===id); const r={id:id||uid(), title, body, icon:base?.icon||'bolt'}; state.prompts=[r,...state.prompts.filter(p=>p.id!==r.id)]; save(); closeModal(); renderPrompts(); break; }
    case 'fillprompt': { const vals={}; document.querySelectorAll('#modal [data-var]').forEach(el=>vals[el.dataset.var]=el.value.trim()); closeModal(); promptFill?.(vals); break; }
    case 'useprompt': pickPrompt(); break;
    case 'newskill': editSkill(null); break;
    case 'uploadskill': $('#pFile').click(); break;
    case 'saveskill': { const name=$('#skName').value.trim(), content=$('#skBody').value.trim(); if(!name||!content){ toast('Add a name and instructions'); break; } const id=t.dataset.sid; if(id) Object.assign(state.skills.find(s=>s.id===id),{name, description:$('#skDesc').value.trim(), content}); else { if(state.skills.filter(s=>!s.builtin).length>=20){ toast('Skill limit reached (20)'); break; } state.skills.push({id:uid(), name, description:$('#skDesc').value.trim(), content:content.slice(0,20000), file:'Written in Canopus', added:Date.now(), enabled:true}); } save(); closeModal(); renderSkills(); renderSide(); break; }
    case 'upload': $('#kFile').click(); break;
    case 'attach': $('#file').click(); break;
    case 'fromsources': pickSources(ids=>{ for(const id of ids){ const f=state.files.find(x=>x.id===id); if(f&&!attachments.some(a=>a.id===id)) attachments.push({...f}); } renderChips(); }); break;
    case 'picked': { const ids=checked('#modal'); closeModal(); pickCb?.(ids); break; }
    case 'shot': captureScreen(); break;
    case 'web': state.web=!state.web; save(); updateTools(); toast(state.web?'Web search on':'Web search off'); break;
    case 'know': state.knowledge=state.knowledge===false; save(); updateTools(); toast(state.knowledge!==false?'Internal knowledge on':'Internal knowledge off for this conversation'); break;
    case 'enhance': { const v=input.value.trim(); if(!v){ toast('Type a prompt first, then I can improve it'); break; } t.classList.add('on'); t.disabled=true; try{ const {text}=await api('/api/quick',{method:'POST', body:{purpose:'enhance', text:v, chatId:state.current||'compose'}}); if(text){ input.value=text; autosize(); toast('Prompt improved'); } }catch(err){ toast(err.message,4000); } finally{ t.classList.remove('on'); t.disabled=false; } break; }
    case 'mic': dictate(t); break;
    case 'regen': { const c=curChat(); if(!c||running.has(c.id)) break; if(c.msgs.at(-1)?.r==='assistant') c.msgs.pop(); respond(c); break; }
    case 'canceledit': editing=-1; renderThread(); break;
    case 'saveedit': { const c=curChat(); const v=$('#editIn').value.trim(); if(!v) break; c.msgs[editing].text=v; c.msgs=c.msgs.slice(0,editing+1); editing=-1; renderThread(); respond(c); break; }
    case 'showbuild': { const c=curChat(); if(c&&running.has(c.id)) openBuild(c.id); break; }
    case 'closepanel': closePanel(); break;
    case 'fullpanel': panel.full=!panel.full; renderPanel(); break;
    case 'copycode': { const c=state.canvases.find(x=>x.id===panel.cid); navigator.clipboard.writeText(c.versions[panel.v].html).then(()=>toast('Code copied')); break; }
    case 'settings': openSettings(); break;
    case 'savesettings': { const name=$('#sName').value.trim(); state.instructions=$('#sInstr').value; save(); if(name!==me.user.name){ me=await api('/api/me',{method:'PATCH', body:{name}}); } closeModal(); route(); toast('Settings saved'); break; }
    case 'changepw': modalDone=null; openModal(`<h3>Change password</h3><p class="s">You'll stay signed in on this device; other sessions are signed out.</p><label for="pwCur">Current password</label><input type="password" id="pwCur" autofocus autocomplete="current-password"><label for="pwNew">New password</label><input type="password" id="pwNew" autocomplete="new-password"><div class="help">At least 10 characters, with letters and numbers.</div><div class="dlg-actions"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-act="savepw">Change password</button></div>`); break;
    case 'savepw': await api('/api/me/password',{method:'POST', body:{current:$('#pwCur').value, next:$('#pwNew').value}}); closeModal(); toast('Password changed'); break;
    case 'logout': await flush(); await api('/api/auth/logout',{method:'POST'}).catch(()=>{}); closeModal(); location.hash=''; showLogin(); break;
    case 'export': downloadText('canopus-workspace.json', JSON.stringify(state), 'application/json'); break;
    case 'clear': if(await confirmBox('Delete all chats?','Every chat will be permanently deleted. Studio, files, prompts and skills are kept.','Delete all')){ running.forEach(s=>s.abort()); state.chats=[]; state.current=null; closePanel(); save(); route(); } break;
    // ---- admin ----
    case 'adduser': userModal(null); break;
    case 'reset2fa': if(await confirmBox('Reset two-step verification?','The user is signed out and must set up their authenticator again at the next sign-in. Use this only after verifying who is asking.','Reset')){ await api(`/api/admin/users/${t.dataset.uid}/reset2fa`,{method:'POST'}); renderAdmin(); toast('Two-step verification reset'); } break;
    case 'savesecurity': await api('/api/admin/settings',{method:'PUT', body:{security:{require2fa:$('#sec2fa').value, maskingRetentionDays:+$('#secMask').value||0, logRetentionDays:+$('#secLogs').value||0}}}); await loadAdmin(); adminSecurity(); toast('Policies saved'); break;
    case 'saveuser': { const uid_=t.dataset.uid; const body={name:$('#uName').value.trim(), role:$('#uRole').value, budget_usd:$('#uBudget').value.trim()===''?null:+$('#uBudget').value, groups:checked('#uGroups')};
      if(uid_){ await api('/api/admin/users/'+uid_,{method:'PATCH', body}); closeModal(); renderAdmin(); toast('User updated'); }
      else { body.email=$('#uEmail').value.trim(); const r=await api('/api/admin/users',{method:'POST', body}); await loadAdmin(); renderAdmin(); showLink('Invitation created', r.invite); } break; }
    case 'toggleuser': await api('/api/admin/users/'+t.dataset.uid,{method:'PATCH', body:{disabled:t.dataset.dis==='1'}}); closeModal(); renderAdmin(); break;
    case 'copylink': navigator.clipboard.writeText($('#linkIn').value).then(()=>toast('Link copied')); $('#linkIn').select(); break;
    case 'addgroup': { const n=await ask('New group',{placeholder:'e.g. Deputi Bidang Polhukam', ok:'Create'}); if(n&&n.trim()){ await api('/api/admin/groups',{method:'POST', body:{name:n.trim()}}); renderAdmin(); } break; }
    case 'addcol': colModal(null); break;
    case 'savecol': { const cid=t.dataset.cid; const body={name:$('#cName').value.trim(), description:$('#cDesc').value.trim(), groups:checked('#cGroups'), local_only:$('#cLocal').checked}; if(!body.name){ toast('Name required'); break; } await api(cid?'/api/admin/collections/'+cid:'/api/admin/collections',{method:cid?'PATCH':'POST', body}); closeModal(); refreshKnowledge(); renderAdmin(); break; }
    case 'douploaddocs': { const files=[...$('#docFiles').files]; const cls=$('#docCls').value; if(!files.length){ toast('Choose files first'); break; } const log=$('#upLog'); t.disabled=true; log.innerHTML='';
      for(const f of files){ log.innerHTML+=`<div>${esc(f.name)}: uploading…</div>`; try{ const r=await api(`/api/admin/collections/${t.dataset.cid}/docs`,{method:'POST', raw:f, headers:{'content-type':f.type||'application/octet-stream','x-filename':encodeURIComponent(f.name),'x-classification':cls}}); log.lastChild.textContent=`${f.name}: ${r.status==='ready'?`indexed (${r.chunks} passages)`:'error — '+r.error}`; }catch(err){ log.lastChild.textContent=`${f.name}: ${err.message}`; log.lastChild.style.color='var(--red)'; } }
      t.disabled=false; refreshKnowledge(); await loadAdmin(); adminKnowledge(); break; }
    case 'savesettingsadmin': { const s=admin.settings;
      s.redaction={...s.redaction, enabled:document.querySelector('[data-settoggle=redaction]').classList.contains('on'), terms:$('#setTerms').value.split('\n').map(x=>x.trim()).filter(Boolean)};
      s.imageUploads=document.querySelector('[data-settoggle=imageUploads]').classList.contains('on'); s.webSearch=document.querySelector('[data-settoggle=webSearch]').classList.contains('on'); s.canvas=document.querySelector('[data-settoggle=canvas]').classList.contains('on');
      s.redaction.columns=($('#setCols')?.value||'').split('\n').map(x=>x.trim()).filter(Boolean);
      s.monthlyBudgetUsd=+$('#setBudget').value||0; s.rateLimits={perMinute:+$('#setPerMin').value||0, perDay:+$('#setPerDay').value||0}; await saveAdminSettings(); break; }
    case 'savemodels': { const s=admin.settings;
      s.models=[...document.querySelectorAll('[data-setmodel]')].filter(b=>b.classList.contains('on')).map(b=>b.dataset.setmodel);
      s.defaultModel=$('#defModel').value; s.routing={failover:document.querySelector('[data-settoggle=failover]').classList.contains('on'), rules:Object.fromEntries([...document.querySelectorAll('[data-rule]')].map(x=>[x.dataset.rule,x.value]))};
      await saveAdminSettings(adminModels); break; }
    case 'listoa': { const ids=await api('/api/admin/openai/models'); $('#oaList').innerHTML=`<div style="margin-top:8px">${ids.length} model IDs available: <span class="mono">${esc(ids.slice(0,80).join(', '))}</span></div>`; break; }
    case 'saveoa': { const prov=t.dataset.prov||'openai'; const key=prov==='local'?'localModels':'openaiModels'; const api_=$('#oaApi').value.trim(); if(!api_){ toast('Enter the model ID'); break; }
      const m={id:t.dataset.mid||`${prov}:${api_.toLowerCase().replace(/[^\w.-]+/g,'-').slice(0,40)}`, api:api_, label:$('#oaLabel').value.trim()||api_, tier:$('#oaTier').value, vision:$('#oaVision').checked, reasoning:$('#oaReason')?.checked||false, priceIn:prov==='local'?0:$('#oaIn').value, priceOut:prov==='local'?0:$('#oaOut').value, priceCached:prov==='local'?'':$('#oaCached').value};
      const list=admin.settings[key]||[]; const i=list.findIndex(x=>x.id===m.id); if(i>=0) list[i]=m; else list.push(m); admin.settings[key]=list; if(!admin.settings.models.includes(m.id)) admin.settings.models.push(m.id);
      closeModal(); await saveAdminSettings(adminModels); break; }
    case 'savegroup': { const ms=checked('#gModels'); await api('/api/admin/groups/'+t.dataset.gid,{method:'PATCH', body:{name:$('#gName').value, budget_usd:$('#gBudget').value.trim()===''?null:+$('#gBudget').value, models:ms.includes('__all')||!ms.length?null:ms}}); closeModal(); renderAdmin(); break; }
    case 'addproject': projectModal(null); break;
    case 'saveproject': { const pid=t.dataset.pid; const body={name:$('#pjName').value.trim(), description:$('#pjDesc').value.trim(), instructions:$('#pjInstr').value, model:$('#pjModel').value, collections:checked('#pjCols'), groups:checked('#pjGroups')};
      if(!body.name){ toast('Name required'); break; } t.disabled=true;
      const files=[...($('#pjFiles')?.files||[])];
      if(files.length){ const log=$('#pjLog'); const col=await api('/api/admin/collections',{method:'POST', body:{name:body.name, description:'Files for the project '+body.name, groups:body.groups}});
        for(const f of files){ log.innerHTML+=`<div>${esc(f.name)}: uploading…</div>`; try{ const r=await api(`/api/admin/collections/${col.id}/docs`,{method:'POST', raw:f, headers:{'content-type':f.type||'application/octet-stream','x-filename':encodeURIComponent(f.name),'x-classification':$('#pjCls').value}}); log.lastChild.textContent=`${f.name}: ${r.status==='ready'?'indexed':'error — '+r.error}`; }catch(err){ log.lastChild.textContent=`${f.name}: ${err.message}`; } }
        body.collections=[...body.collections, col.id]; refreshKnowledge(); }
      await api(pid?'/api/admin/projects/'+pid:'/api/admin/projects',{method:pid?'PUT':'POST', body}); closeModal(); await refreshMe(); await loadAdmin(); renderAdmin(); toast('Project saved'); break; }
    case 'addtoken': modalDone=null; openModal(`<h3>Create API token</h3><p class="s">The token is shown once. Store it in your automation tool's credentials, not in a document.</p><label for="tkName">Name</label><input type="text" id="tkName" placeholder="e.g. n8n daily brief" autofocus><label for="tkUser">Acts as</label><select id="tkUser">${admin.users.filter(u=>!u.disabled&&u.active).map(u=>`<option value="${u.id}" ${u.id===me.user.id?'selected':''}>${esc(u.name||u.email)} (${esc(u.email)})</option>`).join('')}</select><label>Permissions</label><div class="checks" id="tkScopes">${Object.entries(SCOPE_LABEL).map(([k,l])=>`<label><input type="checkbox" value="${k}" ${k==='ask'?'checked':''}>${l}</label>`).join('')}</div><div class="dlg-actions"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-act="savetoken">Create</button></div>`,'wide'); break;
    case 'savetoken': { const r=await api('/api/admin/tokens',{method:'POST', body:{name:$('#tkName').value.trim()||'Integration', user_id:$('#tkUser').value, scopes:checked('#tkScopes')}}); await loadAdmin(); renderAdmin(); modalDone=null; openModal(`<h3>Token created</h3><p class="s">Copy it now — it will not be shown again.</p><div class="linkbox"><input type="text" id="linkIn" value="${esc(r.token)}" readonly><button class="btn primary" data-act="copylink">${ic('copy')}Copy</button></div><div class="dlg-actions"><button class="btn" data-dlg="cancel">Done</button></div>`,'wide'); break; }
    case 'savewebhook': { admin.settings.webhook={url:$('#whUrl').value.trim(), events:checked('#whEvents')}; await saveAdminSettings(adminIntegrations); break; }
    case 'testwebhook': { const r=await api('/api/admin/webhook/test',{method:'POST'}); toast(r.status?`Webhook answered HTTP ${r.status}`:r.error?'Webhook failed: '+r.error:'Webhook not configured',4000); break; }
    case 'showsecret': { const r=await api('/api/admin/webhook/secret'); t.closest('.set-row').querySelector('small').textContent=r.secret; break; }
    case 'rotatesecret': { if(await confirmBox('Rotate secret?','The receiving workflow must be updated with the new secret.','Rotate')){ await api('/api/admin/webhook/rotate',{method:'POST'}); await loadAdmin(); adminIntegrations(); toast('Secret rotated'); } break; }
    case 'saveorgskill': { const i=+t.dataset.i; const k={name:$('#oskName').value.trim(), description:$('#oskDesc').value.trim(), content:$('#oskBody').value.trim(), enabled:true}; if(!k.name||!k.content){ toast('Add a name and instructions'); break; } if(i>=0) admin.settings.orgSkills[i]={...admin.settings.orgSkills[i],...k}; else admin.settings.orgSkills.push({id:uid(),...k}); closeModal(); await saveAdminSettings(); break; }
    case 'saveorgprompt': { const i=+t.dataset.i; const k={title:$('#opTitle').value.trim(), body:$('#opBody').value.trim()}; if(!k.title||!k.body){ toast('Add a title and a prompt'); break; } if(i>=0) admin.settings.orgPrompts[i]={...admin.settings.orgPrompts[i],...k}; else admin.settings.orgPrompts.push({id:uid(),...k}); closeModal(); await saveAdminSettings(); break; }
  }
  }catch(err){ if(err.status!==401) toast(err.message,4500); }
});
async function saveAdminSettings(view=adminSettings){ const {webhook, ...rest}=admin.settings; const body={...rest, webhook:{url:webhook.url, events:webhook.events}}; await api('/api/admin/settings',{method:'PUT', body}); await loadAdmin(); await refreshMe(); view(); toast('Saved'); }
async function refreshKnowledge(){ knowledge=await api('/api/knowledge').catch(()=>knowledge); renderSide(); }
document.addEventListener('change',e=>{ if(e.target.id==='vsel'){ panel.v=+e.target.value; renderPanel(); } });
document.addEventListener('toggle',e=>{ const d=e.target.closest?.('[data-think]'); if(d){ const m=curChat()?.msgs[+d.dataset.think]; if(m) m.thinkOpen=d.open; } },true);
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){ closeMenus(); document.querySelectorAll('.float-menu').forEach(x=>x.remove()); if(!$('#modal').hidden) closeModal(); else if(panel.full){ panel.full=false; if(curView()==='home'&&curChat()) renderPanel(); else closePanel(); } else if(!$('#panel').hidden) closePanel(); }
  if(e.key==='Enter'&&!$('#modal').hidden&&e.target.id==='askIn'){ e.preventDefault(); closeModal(e.target.value); }
  if(!me) return;
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){ e.preventDefault(); openSearch(); }
  if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==='o'){ e.preventDefault(); newChat(); }
});
['studioQ','fileQ','promptQ'].forEach(id=>$('#'+id).addEventListener('input',()=>renderPage()));

/* ================= Test hook (used by the harness) ================= */
window.__canopus={ get state(){ return state; }, get me(){ return me; }, busy(){ return running.size>0; }, flush };

/* ================= Boot ================= */
(async()=>{
  hydrateIcons();
  if(location.hash.startsWith('#invite=')) return showInvite(location.hash.slice(8));
  try{ await start(await api('/api/me',{quiet:true})); }catch(e){ showLogin(e.status===401?'':e.message); }
})();
