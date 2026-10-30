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

/** The tallest an inline page grows; the rest scrolls inside it or opens full screen. */
export const HTML_RENDER_MAX_FIT_HEIGHT = 20_000;
/** The tallest page height measured, and shown full screen. */
export const HTML_RENDER_MAX_CONTENT_HEIGHT = 100_000;
export const HTML_RENDER_MIN_FIT_HEIGHT = 120;
/** The default chat column (56rem) less its row padding. */
export const HTML_RENDER_COLUMN_WIDTH = 880;
/** `--chart-2..6`; `--chart-1` is the palette's primary color. */
export const HTML_RENDER_CHART_COLORS = {
  light: ["#0d9488", "#d97706", "#9333ea", "#e11d48", "#65a30d"],
  dark: ["#2dd4bf", "#fbbf24", "#c084fc", "#fb7185", "#a3e635"],
} as const;

/**
 * The page height, gutter included. A page shorter than its frame reports its
 * own height rather than the frame's, and absolutely positioned overflow still
 * counts. Shared by the inline bootstrap and the desktop preview.
 */
export const HTML_RENDER_MEASURE_SOURCE = `(()=>{const r=document.documentElement;return Math.min(${HTML_RENDER_MAX_CONTENT_HEIGHT},Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height))})()`;

export interface HtmlRenderMeasurement {
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

/** A page's `height` message, or null when any field is missing, non-finite or out of range. */
export function readHtmlRenderMeasurement(value: unknown): HtmlRenderMeasurement | null {
  if (!value || typeof value !== "object") return null;
  const { height, viewportWidth, viewportHeight } = value as Record<string, unknown>;
  const valid = [height, viewportWidth, viewportHeight].every(
    (entry) =>
      typeof entry === "number" &&
      Number.isFinite(entry) &&
      entry >= 0 &&
      entry <= HTML_RENDER_MAX_CONTENT_HEIGHT,
  );
  return valid
    ? {
        height: height as number,
        viewportWidth: viewportWidth as number,
        viewportHeight: viewportHeight as number,
      }
    : null;
}

export type HtmlRenderSizingMode = "fit" | "capped" | "paused";
export interface HtmlRenderFitState {
  /** The inline frame height. */
  readonly height: number;
  readonly mode: HtmlRenderSizingMode;
  readonly width: number | null;
  /** Consecutive expanding rounds whose overflow keeps the same size or proportion. */
  readonly run: {
    readonly startHeight: number;
    readonly rounds: number;
    readonly excess: number;
    readonly ratio: number;
  } | null;
}

export const HTML_RENDER_LOOP_ROUNDS = 4;

export const initialHtmlRenderFit = (
  height: number,
  limit: number = HTML_RENDER_MAX_FIT_HEIGHT,
): HtmlRenderFitState => ({
  height: clampFit(height, limit),
  mode: "fit",
  width: null,
  run: null,
});

const clampFit = (height: number, limit: number) =>
  Math.max(HTML_RENDER_MIN_FIT_HEIGHT, Math.min(limit, Math.ceil(height)));

/**
 * Fits the inline frame to a measurement. A page whose height follows its frame
 * (`100vh` plus padding, percentage heights, `innerHeight` scripts) grows by
 * the same amount or proportion every time the frame grows; after
 * {@link HTML_RENDER_LOOP_ROUNDS} such rounds the height freezes where the run
 * started and sizing pauses until the width changes or the reader retries.
 * `limit` is the inline cap; full screen passes the content cap.
 */
export function nextHtmlRenderFit(
  state: HtmlRenderFitState,
  measurement: HtmlRenderMeasurement,
  limit: number = HTML_RENDER_MAX_FIT_HEIGHT,
): HtmlRenderFitState {
  const widthChanged = state.width !== null && state.width !== measurement.viewportWidth;
  if (state.mode === "paused" && !widthChanged) return state;
  const base: HtmlRenderFitState = widthChanged
    ? { ...state, mode: "fit", run: null, width: measurement.viewportWidth }
    : { ...state, width: measurement.viewportWidth };
  const content = Math.ceil(measurement.height);
  const height = clampFit(content, limit);
  const mode = content > limit ? "capped" : "fit";
  // Only a measurement taken at the height last applied completes a round.
  const completed = Math.abs(measurement.viewportHeight - base.height) <= 1;
  const expanding = completed && mode === "fit" && content > measurement.viewportHeight + 1;
  if (!expanding) {
    // A measurement from before the last resize landed neither ends nor extends a run.
    return { ...base, height, mode, run: completed ? null : base.run };
  }
  const excess = content - measurement.viewportHeight;
  const ratio = content / Math.max(1, measurement.viewportHeight);
  const previous = base.run;
  const continues =
    previous !== null &&
    (Math.abs(excess - previous.excess) <= 2 || Math.abs(ratio - previous.ratio) <= 0.01);
  const run = continues
    ? { ...previous, rounds: previous.rounds + 1, excess, ratio }
    : { startHeight: base.height, rounds: 1, excess, ratio };
  if (run.rounds >= HTML_RENDER_LOOP_ROUNDS)
    return { ...base, height: run.startHeight, mode: "paused", run: null };
  return { ...base, height, mode, run };
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
    const root=document.documentElement;
    let shortcuts=[],scroll=false;channel.port1.onmessage=e=>{if(e.data?.type==='shortcuts')shortcuts=e.data.value;if(e.data?.type==='sizing'){scroll=e.data.value==='scroll';if(scroll)root.style.setProperty('overflow','auto');else root.style.removeProperty('overflow');last='';invalidate()}if(e.data?.type==='theme'){const t=e.data.value,s=document.getElementById('f5-html-theme');if(s&&t){let css=':root{color-scheme:'+(t.appearance==='light'?'light':'dark')+';';for(const key in t.variables)if(/^--[a-z0-9-]+$/.test(key))css+=key+':'+String(t.variables[key]).replace(/[;{}<>]/g,'')+';';s.textContent=css+'}'}}};
    parent.postMessage({f5HtmlRender:__f5Bridge,type:'connect'},'*',[channel.port2]);
    let last='',timer=0,frame=0,backstop=0,ran=-1e9;
    const measure=()=>{cancelAnimationFrame(frame);clearTimeout(backstop);frame=0;backstop=0;ran=performance.now();const height=` +
    HTML_RENDER_MEASURE_SOURCE +
    String.raw`,key=height+','+innerWidth+','+innerHeight;if(key!==last){last=key;emit('height',{height,viewportWidth:innerWidth,viewportHeight:innerHeight})}};
    const invalidate=()=>{if(timer||frame)return;timer=setTimeout(()=>{timer=0;frame=requestAnimationFrame(measure);backstop=setTimeout(measure,100)},Math.max(0,50-(performance.now()-ran)))};
    addEventListener('load',invalidate,true);addEventListener('error',invalidate,true);addEventListener('resize',invalidate);
    addEventListener('DOMContentLoaded',()=>{const resize=new ResizeObserver(invalidate);resize.observe(root);if(document.body)resize.observe(document.body);const mutation=new MutationObserver(invalidate);mutation.observe(root,{subtree:true,childList:true,characterData:true,attributes:true});document.fonts?.ready.then(invalidate);document.fonts?.addEventListener('loadingdone',invalidate);addEventListener('pagehide',()=>{resize.disconnect();mutation.disconnect();clearTimeout(timer);clearTimeout(backstop);cancelAnimationFrame(frame);document.fonts?.removeEventListener('loadingdone',invalidate);removeEventListener('load',invalidate,true);removeEventListener('error',invalidate,true);removeEventListener('resize',invalidate)},{once:true});invalidate()},{once:true});
    document.addEventListener('click',e=>{if(!e.isTrusted)return;const a=e.composedPath().find(n=>n?.matches?.('a[href]'));if(a){prevent(e);try{const u=new URL(a.getAttribute('href'));if(/^https?:$/.test(u.protocol))emit('link',u.href)}catch{}return}const img=e.composedPath().find(n=>n?.tagName==='IMG');if(img&&!e.defaultPrevented)emit('image',{src:img.currentSrc||img.src,name:img.alt||'Rendered image'})},true);
    addEventListener('keydown',e=>{if(!e.isTrusted||read.isComposing(e))return;const key=read.key(e);if(key==='Escape'){prevent(e);emit('escape',null);return}const value={key,code:read.code(e),metaKey:read.metaKey(e),ctrlKey:read.ctrlKey(e),shiftKey:read.shiftKey(e),altKey:read.altKey(e),repeat:read.repeat(e)};if(shortcuts.some(s=>s.key===key.toLowerCase()&&s.metaKey===value.metaKey&&s.ctrlKey===value.ctrlKey&&s.shiftKey===value.shiftKey&&s.altKey===value.altKey)){prevent(e);emit('keydown',value)}},true);
    addEventListener('wheel',e=>{if(!e.isTrusted||e.ctrlKey)return;if(scroll){const s=document.scrollingElement||root,x=e.deltaX,y=e.deltaY;if((y<0&&s.scrollTop>0)||(y>0&&s.scrollTop+s.clientHeight<s.scrollHeight-1)||(x<0&&s.scrollLeft>0)||(x>0&&s.scrollLeft+s.clientWidth<s.scrollWidth-1))return}prevent(e);emit('wheel',{x:e.deltaX,y:e.deltaY,mode:e.deltaMode})},{passive:false});
  })();`;
  const base =
    "html{box-sizing:border-box;padding:8px;background:var(--background);color:var(--foreground);font-family:var(--font-sans,system-ui,sans-serif);font-size:14px;line-height:1.5;overflow:hidden}" +
    "body{margin:0}" +
    "code,kbd,pre,samp{font-family:var(--font-mono,ui-monospace,monospace)}" +
    ":focus-visible{outline:2px solid var(--ring)!important;outline-offset:-2px!important}" +
    "img:not(a img,button img){cursor:zoom-in}" +
    "img,svg,video{max-width:100%}";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${htmlRenderCsp(options.allowRemoteContent)}"><meta name="referrer" content="no-referrer"><style id="f5-html-theme">:root{color-scheme:${theme.appearance};${variables}}</style><style>${base}</style><script>${script}</script></head><body>${html}</body></html>`;
}
