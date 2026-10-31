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
 *
 * Without overflow, `scrollHeight` is only the frame height, so out-of-flow
 * content that exactly fills the frame would read as the root box's height and
 * the frame would shrink and grow forever. Then the lowest element bottom
 * counts too, cut off at any ancestor that clips its overflow. Fixed elements
 * and everything inside them follow the frame, so they are skipped. The walk
 * stops after {@link HTML_RENDER_MEASURE_ELEMENT_LIMIT} elements.
 */
export const HTML_RENDER_MEASURE_ELEMENT_LIMIT = 5000;
export const HTML_RENDER_MEASURE_SOURCE = `(()=>{const r=document.documentElement,c=r.clientHeight;if(r.scrollHeight>c)return Math.min(${HTML_RENDER_MAX_CONTENT_HEIGHT},Math.ceil(r.scrollHeight));let h=r.getBoundingClientRect().height,n=0;const walk=(p,clip)=>{for(const e of p.children){if(++n>${HTML_RENDER_MEASURE_ELEMENT_LIMIT})return;const s=getComputedStyle(e);if(s.position==='fixed')continue;const b=e.getBoundingClientRect().bottom+scrollY;h=Math.max(h,Math.min(b,clip));walk(e,s.overflowX!=='visible'||s.overflowY!=='visible'?Math.min(clip,b):clip)}};if(h<c-1)walk(r,Infinity);return Math.min(${HTML_RENDER_MAX_CONTENT_HEIGHT},Math.ceil(h))})()`;

export interface HtmlRenderMeasurement {
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** The page itself changed (DOM, a resource or fonts) since the last measurement. */
  readonly changed?: boolean;
}

/** A page's `height` message, or null when any field is missing, non-finite or out of range. */
export function readHtmlRenderMeasurement(value: unknown): HtmlRenderMeasurement | null {
  if (!value || typeof value !== "object") return null;
  const { height, viewportWidth, viewportHeight, changed } = value as Record<string, unknown>;
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
        changed: changed === true,
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
  /**
   * While paused, the page height expected at the frozen frame height: predicted
   * from the loop when it pauses, then as last measured there.
   */
  readonly pausedContent?: number | null;
  /**
   * While paused, whether the page changed since `pausedContent` was set, so a
   * change reported before the frozen height landed still counts. Unset until a
   * remounted page's first measurement, whose load is not a change.
   */
  readonly pausedChange?: boolean;
}

export const HTML_RENDER_LOOP_ROUNDS = 4;

export const initialHtmlRenderFit = (
  height: number,
  limit: number = HTML_RENDER_MAX_FIT_HEIGHT,
  paused?: { readonly width: number },
): HtmlRenderFitState => ({
  height: clampFit(height, limit),
  mode: paused ? "paused" : "fit",
  width: paused?.width ?? null,
  run: null,
  pausedContent: null,
});

const clampFit = (height: number, limit: number) =>
  Math.max(HTML_RENDER_MIN_FIT_HEIGHT, Math.min(limit, Math.ceil(height)));

/** Proportional growth counts only for real percentage heights, not a few pixels on a tall frame. */
const MIN_LOOP_RATIO = 1.05;

/**
 * Fits the inline frame to a measurement. A page whose height follows its frame
 * (`100vh` plus padding, percentage heights) grows by the same amount or
 * proportion every time the frame grows, with nothing else on the page
 * changing; after {@link HTML_RENDER_LOOP_ROUNDS} such rounds the height
 * freezes where the run started and sizing pauses. Rounds where the page itself
 * changed (an animation, rows on a timer, images decoding) never count, so
 * steady growth keeps fitting; a script that resizes content from the frame
 * height grows to `limit` instead.
 *
 * A paused page resumes when it changes or its width changes and its height
 * at the frozen frame differs from the last one there, or when the reader
 * retries. A drag-resize alone therefore keeps a frame-sized page paused.
 * `limit` is the inline cap; full screen passes the content cap.
 */
export function nextHtmlRenderFit(
  state: HtmlRenderFitState,
  measurement: HtmlRenderMeasurement,
  limit: number = HTML_RENDER_MAX_FIT_HEIGHT,
): HtmlRenderFitState {
  const content = Math.ceil(measurement.height);
  const widthChanged = state.width !== null && state.width !== measurement.viewportWidth;
  const expected = state.pausedContent ?? null;
  // A remounted page has no height to compare yet, so a new width measures it again.
  if (state.mode === "paused" && !(widthChanged && expected === null)) {
    if (state.width === null) return { ...state, width: measurement.viewportWidth };
    const tracking = state.pausedChange !== undefined;
    const change = state.pausedChange === true || (tracking && measurement.changed === true);
    // Only a measurement at the frozen height says how tall the page is now.
    if (Math.abs(measurement.viewportHeight - state.height) > 1)
      return change === state.pausedChange ? state : { ...state, pausedChange: change };
    const resumed =
      expected !== null && (change || widthChanged) && Math.abs(content - expected) > 1;
    if (!resumed)
      return expected === content && state.pausedChange === false && !widthChanged
        ? state
        : {
            ...state,
            width: measurement.viewportWidth,
            pausedContent: content,
            pausedChange: false,
          };
  }
  const base: HtmlRenderFitState = {
    height: state.height,
    mode: "fit",
    run: widthChanged || state.mode === "paused" ? null : state.run,
    width: measurement.viewportWidth,
    pausedContent: null,
  };
  const height = clampFit(content, limit);
  const mode = content > limit ? "capped" : "fit";
  // Only a measurement taken at the height last applied completes a round.
  const completed = Math.abs(measurement.viewportHeight - base.height) <= 1;
  const expanding = completed && mode === "fit" && content > measurement.viewportHeight + 1;
  if (!expanding || measurement.changed === true) {
    // A measurement from before the last resize landed neither ends nor extends a run.
    return { ...base, height, mode, run: completed ? null : base.run };
  }
  const excess = content - measurement.viewportHeight;
  const ratio = content / Math.max(1, measurement.viewportHeight);
  const previous = base.run;
  const sameExcess = previous !== null && Math.abs(excess - previous.excess) <= 2;
  const continues =
    sameExcess ||
    (previous !== null && ratio >= MIN_LOOP_RATIO && Math.abs(ratio - previous.ratio) <= 0.01);
  const run = continues
    ? { ...previous!, rounds: previous!.rounds + 1, excess, ratio }
    : { startHeight: base.height, rounds: 1, excess, ratio };
  if (run.rounds >= HTML_RENDER_LOOP_ROUNDS)
    return {
      ...base,
      height: run.startHeight,
      mode: "paused",
      run: null,
      // What the same loop measures at the frozen height; anything else is the page changing.
      pausedContent: sameExcess ? run.startHeight + excess : Math.ceil(run.startHeight * ratio),
      pausedChange: false,
    };
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
    let shortcuts=[],scroll=false,inner=false,mutation;channel.port1.onmessage=e=>{if(e.data?.type==='shortcuts')shortcuts=e.data.value;if(e.data?.type==='sizing'){const v=e.data.value;scroll=v==='scroll'||v==='scroll-inner';inner=v==='scroll-inner';if(scroll)root.style.setProperty('overflow','auto');else root.style.removeProperty('overflow');mutation?.takeRecords();last='';invalidate()}if(e.data?.type==='theme'){const t=e.data.value,s=document.getElementById('f5-html-theme');if(s&&t){let css=':root{color-scheme:'+(t.appearance==='light'?'light':'dark')+';';for(const key in t.variables)if(/^--[a-z0-9-]+$/.test(key))css+=key+':'+String(t.variables[key]).replace(/[;{}<>]/g,'')+';';s.textContent=css+'}'}}};
    parent.postMessage({f5HtmlRender:__f5Bridge,type:'connect'},'*',[channel.port2]);
    let last='',timer=0,frame=0,backstop=0,ran=-1e9,dirty=true;
    const measure=()=>{cancelAnimationFrame(frame);clearTimeout(backstop);frame=0;backstop=0;ran=performance.now();const height=` +
    HTML_RENDER_MEASURE_SOURCE +
    String.raw`,key=height+','+innerWidth+','+innerHeight,changed=dirty;dirty=false;if(key!==last){last=key;emit('height',{height,viewportWidth:innerWidth,viewportHeight:innerHeight,changed})}};
    const invalidate=()=>{if(timer||frame)return;timer=setTimeout(()=>{timer=0;frame=requestAnimationFrame(measure);backstop=setTimeout(measure,100)},Math.max(0,50-(performance.now()-ran)))};
    const touch=()=>{dirty=true;invalidate()};
    addEventListener('load',touch,true);addEventListener('error',touch,true);addEventListener('resize',invalidate);
    addEventListener('DOMContentLoaded',()=>{const resize=new ResizeObserver(invalidate);resize.observe(root);if(document.body)resize.observe(document.body);mutation=new MutationObserver(touch);mutation.observe(root,{subtree:true,childList:true,characterData:true,attributes:true});document.fonts?.ready.then(touch);document.fonts?.addEventListener('loadingdone',touch);addEventListener('pagehide',()=>{resize.disconnect();mutation.disconnect();clearTimeout(timer);clearTimeout(backstop);cancelAnimationFrame(frame);document.fonts?.removeEventListener('loadingdone',touch);removeEventListener('load',touch,true);removeEventListener('error',touch,true);removeEventListener('resize',invalidate)},{once:true});invalidate()},{once:true});
    document.addEventListener('click',e=>{if(!e.isTrusted)return;const a=e.composedPath().find(n=>n?.matches?.('a[href]'));if(a){prevent(e);try{const u=new URL(a.getAttribute('href'));if(/^https?:$/.test(u.protocol))emit('link',u.href)}catch{}return}const img=e.composedPath().find(n=>n?.tagName==='IMG');if(img&&!e.defaultPrevented)emit('image',{src:img.currentSrc||img.src,name:img.alt||'Rendered image'})},true);
    addEventListener('keydown',e=>{if(!e.isTrusted||read.isComposing(e))return;const key=read.key(e);if(key==='Escape'){prevent(e);emit('escape',null);return}const value={key,code:read.code(e),metaKey:read.metaKey(e),ctrlKey:read.ctrlKey(e),shiftKey:read.shiftKey(e),altKey:read.altKey(e),repeat:read.repeat(e)};if(shortcuts.some(s=>s.key===key.toLowerCase()&&s.metaKey===value.metaKey&&s.ctrlKey===value.ctrlKey&&s.shiftKey===value.shiftKey&&s.altKey===value.altKey)){prevent(e);emit('keydown',value)}},true);
    addEventListener('wheel',e=>{if(!e.isTrusted||e.ctrlKey)return;if(inner){const s=document.scrollingElement||root,x=e.deltaX,y=e.deltaY;if((y<0&&s.scrollTop>0)||(y>0&&s.scrollTop+s.clientHeight<s.scrollHeight-1)||(x<0&&s.scrollLeft>0)||(x>0&&s.scrollLeft+s.clientWidth<s.scrollWidth-1))return}prevent(e);emit('wheel',{x:e.deltaX,y:e.deltaY,mode:e.deltaMode})},{passive:false});
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
