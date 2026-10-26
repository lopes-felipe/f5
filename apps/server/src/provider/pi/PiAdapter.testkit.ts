import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { writeCliScript } from "../../testUtils/cli.ts";
import type { makePiAdapter } from "../Layers/PiAdapter.ts";

const source = String.raw`
const fs=require('node:fs');
const trace=record=>fs.appendFileSync(process.env.F5_PI_TRACE,JSON.stringify(record)+'\n');
trace({type:'spawn',pid:process.pid,args:process.argv.slice(2),readOnly:process.env.F5_PI_READ_ONLY==='1',hasMcp:!!process.env.F5_PI_MCP_BEARER_TOKEN});
if(process.argv.includes('--version')){process.stdout.write('0.80.5');process.exit(0);}
const emit=record=>process.stdout.write(JSON.stringify(record)+'\n');
const reply=(record,data)=>emit({type:'response',id:record.id,command:record.type,success:true,data});
let model={provider:'one',id:'shared'}, sessionFile=process.env.F5_PI_SESSION, leafId=null, entries=[], pending='', awaitingModel, wakeScheduled=false;
process.stdin.on('data',chunk=>{pending+=chunk.toString('utf8');for(;;){const end=pending.indexOf('\n');if(end<0)break;const record=JSON.parse(pending.slice(0,end));pending=pending.slice(end+1);trace(record);
switch(record.type){
case 'get_state':if(process.env.F5_PI_CASE==='fork-state-failure'&&sessionFile.endsWith('.fork')){emit({type:'response',id:record.id,command:record.type,success:false});break;}reply(record,{model:process.env.F5_PI_CASE==='wrong-model-readback'?{provider:'one',id:'shared'}:model,thinkingLevel:'high',sessionFile,isStreaming:false,isCompacting:false,pendingMessageCount:0});break;
case 'get_available_models':reply(record,{models:[{...model,reasoning:true}]});break;
case 'get_commands':if(process.env.F5_PI_CASE!=='hang-start')reply(record,{commands:[{name:'reload',source:'extension'}]});break;
case 'get_entries':reply(record,{leafId,entries});break;
case 'get_messages':{
 const byId=new Map(entries.map(entry=>[entry.id,entry]));const branch=[];let current=leafId;
 while(current){const entry=byId.get(current);if(!entry)break;branch.push(entry.message);current=entry.parentId;}
 reply(record,{messages:branch.reverse()});break;
}
case 'fork':{
 const entry=entries.find(entry=>entry.id===record.entryId);
 if(!entry){emit({type:'response',id:record.id,command:record.type,success:false});break;}
 if(process.env.F5_PI_CASE!=='fork-wrong-boundary')leafId=entry.parentId;
 sessionFile+='.fork';reply(record,{cancelled:false});break;
}
case 'switch_session':sessionFile=record.sessionPath;reply(record,{});break;
case 'set_model':
 model={provider:record.provider,id:record.modelId};
 if(process.env.F5_PI_CASE==='start-dialog'&&!awaitingModel){awaitingModel=record;emit({type:'extension_ui_request',id:'configure-confirm',method:'confirm',title:'Allow configuration?',message:'Use this model?',timeout:2000});}
 else reply(record,{});break;
case 'extension_ui_response':if(awaitingModel){reply(awaitingModel,{});awaitingModel=null;}break;
case 'prompt':{
 const mode=process.env.F5_PI_CASE;
 if(mode==='flood'){
  reply(record,{});
  // Saturate the adapter's injected output buffer, staying below the RPC frame budget.
  for(let emitted=0;emitted<32;emitted++)emit({type:'extension_ui_request',method:'notify',message:'Native notification'});
  trace({type:'flood-done'});break;
 }
 if(mode==='crash'){process.exit(23);break;}
 if(mode==='reject'){emit({type:'response',id:record.id,command:'prompt',success:false,error:'PRIVATE_FAILURE'});break;}
 if(mode==='streaming'&&record.streamingBehavior!=='steer'){emit({type:'agent_start'});emit({type:'response',id:record.id,command:'prompt',success:false,error:"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."});break;}
 if(record.message.startsWith('/reload')){reply(record,{});break;}
 const userId='u'+entries.length, assistantId='a'+entries.length;
 entries.push({id:userId,parentId:leafId,type:'message',message:{role:'user',content:record.message}});
 entries.push({id:assistantId,parentId:userId,type:'message',message:{role:'assistant',content:[{type:'text',text:'Pi reply'}]}});leafId=assistantId;
 if((mode==='native-rewind'&&entries.length>=4)||(mode==='native-rewind-deep'&&entries.length>=6))leafId=entries[0].id;
 if(mode==='native-switch'&&entries.length>=4)sessionFile+='.switched';
 emit({type:'agent_start'});emit({type:'message_start',message:{role:'assistant'}});
 if(mode!=='final-only')emit({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'Pi reply'}});
 emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Pi reply'}],stopReason:'stop'}});
 if(mode==='tool'){
  emit({type:'tool_execution_start',toolCallId:'call',toolName:'bash',args:{command:'exit 2'}});
  const toolEnd={type:'tool_execution_end',toolCallId:'call',toolName:'bash',isError:false,result:{content:[{type:'image',mimeType:'image/png',data:'aGVsbG8='},{type:'text',text:'Done'}],details:{exitCode:2},structuredContent:{count:3}}};
  emit(toolEnd);emit(toolEnd);
 }
 emit({type:'agent_settled',aborted:mode==='abort'});reply(record,{});
 if(mode==='wake'&&!wakeScheduled){wakeScheduled=true;setTimeout(()=>{
  const id='wake'+entries.length;
  entries.push({id,parentId:leafId,type:'message',message:{role:'assistant',content:[{type:'text',text:'Native reply'}]}});leafId=id;
  emit({type:'agent_start'});emit({type:'message_start',message:{role:'assistant'}});
  emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Native reply'}],stopReason:'stop'}});
  emit({type:'agent_settled'});
 },60);}
 break;
}
default:reply(record,{});
}}});
`;
export const threadId = ThreadId.makeUnsafe("pi-adapter-thread");
export const fixture = async (
  test: (input: {
    settings: { enabled: boolean; binaryPath: string; launchArgs: string; customModels: [] };
    options: Parameters<typeof makePiAdapter>[1];
    trace: () => Promise<Record<string, unknown>[]>;
  }) => Promise<void>,
) => {
  const cwd = await mkdtemp(join(tmpdir(), "f5-pi-adapter-"));
  const log = join(cwd, "trace.jsonl");
  const binaryPath = writeCliScript(join(cwd, "pi"), source);
  try {
    await test({
      settings: { enabled: true, binaryPath, launchArgs: "", customModels: [] },
      options: {
        instanceId: ProviderInstanceId.make("pi-test"),
        environment: {
          PATH: process.env.PATH,
          F5_PI_TRACE: log,
          F5_PI_SESSION: join(cwd, "session.jsonl"),
        },
        cacheDir: join(cwd, "cache"),
      },
      trace: async () =>
        (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>),
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};
