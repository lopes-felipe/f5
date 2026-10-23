/**
 * Remote HTTPS images and scripts load only when allowed: either one is an
 * outbound request an agent-written page makes as soon as it renders.
 */
export const htmlRenderCsp = (allowRemoteContent = false) => {
  const remote = allowRemoteContent ? " https:" : "";
  return `default-src 'none'; img-src data:${remote}; style-src 'unsafe-inline'; script-src 'unsafe-inline'${remote}; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'`;
};
export interface HtmlRenderTheme {
  readonly appearance: "light" | "dark";
  readonly variables: Readonly<Record<string, string>>;
}

/** First-policy CSP and an opaque-origin iframe are both required by callers. */
export function htmlRenderDocument(
  html: string,
  theme: HtmlRenderTheme,
  bridgeId = "",
  options: { readonly allowRemoteContent?: boolean } = {},
): string {
  const variables = Object.entries(theme.variables)
    .filter(([key]) => /^--[a-z0-9-]+$/.test(key))
    .map(([key, value]) => `${key}:${value.replace(/[;{}<>]/g, "")}`)
    .join(";");
  const script =
    `const __f5Bridge=${JSON.stringify(bridgeId).replaceAll("<", "\\u003c")};` +
    String.raw`(()=>{
    if(parent===window||!__f5Bridge)return;
    const channel=new MessageChannel(),send=channel.port1.postMessage.bind(channel.port1);
    const emit=(type,value)=>send({f5HtmlRender:__f5Bridge,type,value});
    const read={};for(const key of ['key','code','metaKey','ctrlKey','shiftKey','altKey','repeat','isComposing']){const getter=Object.getOwnPropertyDescriptor(KeyboardEvent.prototype,key)?.get;if(getter)read[key]=Function.prototype.call.bind(getter)}
    const prevent=Function.prototype.call.bind(Event.prototype.preventDefault);
    let shortcuts=[];channel.port1.onmessage=e=>{if(e.data?.type==='shortcuts')shortcuts=e.data.value;if(e.data?.type==='theme'){const t=e.data.value,s=document.getElementById('f5-html-theme');if(s&&t){let css=':root{color-scheme:'+(t.appearance==='light'?'light':'dark')+';';for(const key in t.variables)if(/^--[a-z0-9-]+$/.test(key))css+=key+':'+String(t.variables[key]).replace(/[;{}<>]/g,'')+';';s.textContent=css+'}'}}};
    parent.postMessage({f5HtmlRender:__f5Bridge,type:'connect'},'*',[channel.port2]);
    let previous=0,timer;const measure=()=>{clearTimeout(timer);timer=setTimeout(()=>{const h=Math.min(100000,Math.ceil(Math.max(document.body?.scrollHeight||0,document.body?.getBoundingClientRect().height||0)));if(h!==previous){previous=h;emit('height',h)}},50)};
    addEventListener('DOMContentLoaded',()=>{new ResizeObserver(measure).observe(document.body);measure()});addEventListener('load',measure);
    document.addEventListener('click',e=>{if(!e.isTrusted)return;const a=e.composedPath().find(n=>n?.matches?.('a[href]'));if(a){prevent(e);try{const u=new URL(a.getAttribute('href'));if(/^https?:$/.test(u.protocol))emit('link',u.href)}catch{}return}const img=e.composedPath().find(n=>n?.tagName==='IMG');if(img&&!e.defaultPrevented)emit('image',{src:img.currentSrc||img.src,name:img.alt||'Rendered image'})},true);
    addEventListener('keydown',e=>{if(!e.isTrusted||read.isComposing(e))return;const key=read.key(e);if(key==='Escape'){prevent(e);emit('escape',null);return}const value={key,code:read.code(e),metaKey:read.metaKey(e),ctrlKey:read.ctrlKey(e),shiftKey:read.shiftKey(e),altKey:read.altKey(e),repeat:read.repeat(e)};if(shortcuts.some(s=>s.key===key.toLowerCase()&&s.metaKey===value.metaKey&&s.ctrlKey===value.ctrlKey&&s.shiftKey===value.shiftKey&&s.altKey===value.altKey)){prevent(e);emit('keydown',value)}},true);
    addEventListener('wheel',e=>{if(!e.isTrusted||e.ctrlKey)return;prevent(e);emit('wheel',{x:e.deltaX,y:e.deltaY})},{passive:false});
  })();`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${htmlRenderCsp(options.allowRemoteContent)}"><meta name="referrer" content="no-referrer"><style id="f5-html-theme">:root{color-scheme:${theme.appearance};${variables}}</style><style>html{overflow:hidden}body{margin:0;color:var(--foreground);background:var(--background);font-family:system-ui,sans-serif}img,svg,video{max-width:100%}</style><script>${script}</script></head><body>${html}</body></html>`;
}
