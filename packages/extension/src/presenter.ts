import type { Deck } from "@slidepix/core";
import type { PresentationServer } from "./presentation";

type PresenterSession = Pick<PresentationServer, "port" | "url">;

export function presenterHtml(session: PresenterSession, deck: Deck): string {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const frame = (index: number) => `${session.url("/frame")}&index=${index}`;
  const previewBackground = cssValue(deck.theme.background);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:${session.port}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px;margin:0}.grid{display:grid;grid-template-columns:2fr 1fr;gap:14px}.frame-shell{position:relative;width:100%;aspect-ratio:${deck.size.width}/${deck.size.height};border:1px solid var(--vscode-panel-border);background:${previewBackground};overflow:hidden}.frame-shell iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:${previewBackground}}.controls{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:14px 0}button{padding:8px 12px}pre{white-space:pre-wrap;font-family:inherit}.timer{font-size:22px;font-variant-numeric:tabular-nums;margin-left:auto}</style></head><body><div class="grid"><div><h3>Current</h3><div class="frame-shell" id="current"><iframe src="${frame(0)}"></iframe></div></div><div><h3>Next</h3><div class="frame-shell" id="next"><iframe src="${frame(1)}"></iframe></div></div></div><div class="controls"><button data-command="first">First</button><button data-command="previous">Previous</button><button data-command="next">Next</button><button data-command="last">Last</button><span class="timer" id="timer">00:00</span><button id="reset">Reset timer</button></div><h3>Notes</h3><pre id="notes">${escapeHtml(deck.slides.filter(s=>!s.hidden)[0]?.notes ?? "")}</pre><script nonce="${nonce}">const vscode=acquireVsCodeApi(),slides=${JSON.stringify(deck.slides.filter(s=>!s.hidden).map(s=>({notes:s.notes})))},base=${JSON.stringify(session.url("/frame"))};let started=Date.now(),frameRequest=0;function swapFrame(id,index){const shell=document.getElementById(id),next=document.createElement('iframe'),request=String(++frameRequest);shell.dataset.request=request;next.src=base+'&index='+index;next.style.opacity='0';next.onload=()=>{if(shell.dataset.request!==request)return next.remove();shell.querySelectorAll('iframe').forEach(frame=>{if(frame!==next)frame.remove()});next.style.opacity='1'};shell.append(next)}document.querySelectorAll('[data-command]').forEach(b=>b.onclick=()=>vscode.postMessage({command:b.dataset.command}));document.getElementById('reset').onclick=()=>started=Date.now();setInterval(()=>{const s=Math.floor((Date.now()-started)/1000);document.getElementById('timer').textContent=String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')},500);addEventListener('message',e=>{if(e.data.type!=='state')return;const i=e.data.index;swapFrame('current',i);swapFrame('next',i+1);document.getElementById('notes').textContent=slides[i]?.notes||''});</script></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] ?? character);
}

function cssValue(value: string): string {
  return value.replace(/[;{}<>"']/g, "");
}
