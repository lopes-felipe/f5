import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, type Layer } from "effect";
import { writeCliScript } from "../../testUtils/cli.ts";
import type { PiLaunchSettings } from "./PiMetadata.ts";
const source = String.raw`
const fs=require('node:fs');
const trace=entry=>fs.appendFileSync(process.env.F5_PI_TRACE,JSON.stringify(entry)+'\n');
trace({type:'spawn',args:process.argv.slice(2),cwd:process.cwd(),pid:process.pid,privateEnvironment:!!process.env.F5_PI_MCP_BEARER_TOKEN});
if(process.argv.includes('--version')){process.stdout.write(process.env.F5_PI_VERSION||'0.80.5');process.exit(0);}
const emit=record=>process.stdout.write(JSON.stringify(record)+'\n');
const reply=(record,data)=>emit({type:'response',id:record.id,command:record.type,success:true,data});
let pending='';
process.stdin.on('data',chunk=>{pending+=chunk.toString('utf8');for(;;){const end=pending.indexOf('\n');if(end<0)break;const record=JSON.parse(pending.slice(0,end));pending=pending.slice(end+1);trace(record);
 if(record.type==='get_state')reply(record,{model:{provider:'one',id:'shared'},thinkingLevel:'high'});
 else if(record.type==='get_available_models')reply(record,{models:[{provider:'one',id:'shared',reasoning:true},{provider:'two',id:'shared',reasoning:true}]});
 else if(record.type==='get_commands'){
  if(process.env.F5_PI_CASE==='catalog-failure')emit({type:'response',id:record.id,success:false,error:'PRIVATE_FAILURE'});
  else reply(record,{commands:[{source:'skill',name:'skill:review',location:'project'}]});
 } else if(record.type==='prompt'){
  const mode=process.env.F5_PI_CASE;
  if(mode==='tool')emit({type:'tool_execution_start',toolName:'bash'});
  const text=mode==='oversize'?'x'.repeat(600*1024):mode==='invalid-json'?'PRIVATE_FAILURE':JSON.stringify({title:'Inspect Pi metadata',needsRefinement:false});
  emit({type:'message_start',message:{role:'assistant'}});
  emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:text}});
  emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason:mode==='error'?'error':'stop'}});
  if(mode==='retry'){
   emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason:'error'}});
   emit({type:'auto_retry_end',success:true});
  }
  emit({type:'agent_settled',aborted:mode==='abort'});
 } else reply(record,{});
}});
`;
export const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof NodeServices.layer>>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
export const fixture = async (
  test: (
    settings: PiLaunchSettings,
    environment: NodeJS.ProcessEnv,
    trace: () => Promise<Record<string, unknown>[]>,
  ) => Promise<void>,
) => {
  const cwd = await mkdtemp(join(tmpdir(), "f5-pi-metadata-test-"));
  const script = writeCliScript(join(cwd, "pi"), source);
  const log = join(cwd, "trace.jsonl");
  try {
    await test(
      {
        binaryPath: script,
        launchArgs: "--extension /never-loaded.ts --tools bash",
      },
      { PATH: process.env.PATH, F5_PI_TRACE: log, F5_PI_MCP_BEARER_TOKEN: "must-be-scrubbed" },
      async () =>
        (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};
