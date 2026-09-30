import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
let passed = 0;
async function check(name: string, test: () => Promise<void>) { await test(); passed++; console.log(`PASS ${name}`); }
async function scalar<T = unknown>(sql: string, params: unknown[] = []): Promise<T> { return (await db.query<{ value: T }>(sql, params)).rows[0]?.value; }
const owner = randomUUID(), other = randomUUID(), project = randomUUID(), parent = randomUUID();
const first = randomUUID(), second = randomUUID(), future = randomUUID();
try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to service_role;");
    const setup = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
    for (const table of ["user_profiles", "projects", "conversations", "messages", "scheduled_tasks", "knowledge_documents"]) {
        const match = setup.match(new RegExp(String.raw`create table if not exists ${table} \([\s\S]*?\n\);`));
        assert.ok(match, `Base table ${table} must exist`);
        await db.exec(match[0]);
    }
    await db.exec("alter table conversations add column project_id uuid references projects(id); grant select,insert,update,delete on all tables in schema public to service_role;");
    const directory = new URL("./migrations/", import.meta.url);
    const files = (await readdir(directory)).filter(file => file.startsWith("v6-") && file.endsWith(".sql"));
    for (const file of files) await db.exec(await readFile(new URL(file, directory), "utf8"));
    await check("all V6 migrations execute and are rerunnable", async () => {
        for (const file of files) await db.exec(await readFile(new URL(file, directory), "utf8"));
    });
    await db.query("insert into user_profiles(id) values ($1),($2)", [owner, other]);
    await db.query("insert into projects(id,user_profile_id,name) values ($1,$2,'Fixture project')", [project, owner]);
    await db.query("insert into conversations(id,user_profile_id,project_id,title) values ($1,$2,$3,'Original')", [parent, owner, project]);
    for (const [index,id,role] of [[0,first,"user"],[1,second,"assistant"],[2,future,"user"]] as const) {
        await db.query("insert into messages(id,conversation_id,user_profile_id,role,content,created_at,metadata) values ($1,$2,$3,$4,$5,$6,$7)",
            [id,parent,owner,role,`message ${index}`,new Date(Date.UTC(2026,8,20,0,index)).toISOString(), JSON.stringify({ councilProposal:{ topic:"Do not copy execution" }, knowledgeOnly:true, replyTrace:{calls:[{purpose:"chat",status:"success",providerId:"gemini-free",modelId:"fixture"}]} })]);
    }
    await db.exec("set role service_role");
    let revision: string;
    await check("context snapshots require exact conversation owner", async () => {
        assert.equal(await scalar("select assistant_context_snapshot($1,'web',$2,'fixture') as value",[parent,other]), null);
        const snapshot = await scalar<{revision:string;messages:unknown[]}>("select assistant_context_snapshot($1,'web',$2,'fixture') as value",[parent,owner]);
        assert.equal(snapshot.messages.length,3); revision = snapshot.revision;
    });
    await check("summary generation and history revision fence stale writes", async () => {
        const summary = JSON.stringify({scope:"fixture",version:1,generation:1,text:"saved summary"});
        assert.equal(await scalar("select assistant_context_save($1,'fixture',$2,0,$3) as value",[parent,revision,summary]),true);
        assert.equal(await scalar("select assistant_context_save($1,'fixture',$2,0,$3) as value",[parent,revision,summary]),false);
        await db.query("update messages set content='changed content' where id=$1",[first]);
        assert.equal(await scalar("select assistant_context_save($1,'fixture',$2,1,$3) as value",[parent,revision,JSON.stringify({scope:"fixture",version:1,generation:2})]),false);
    });
    await check("reply trace CAS preserves metadata and does not invalidate summaries", async () => {
        const before = await scalar("select revision as value from assistant_context_revisions where conversation_id=$1",[parent]);
        const expected = await scalar("select metadata->'replyTrace' as value from messages where id=$1",[second]);
        assert.equal(await scalar("select assistant_reply_trace_save($1,$2,$3) as value",[second,JSON.stringify(expected),JSON.stringify({version:1,saved:true})]),true);
        assert.equal(await scalar("select assistant_reply_trace_save($1,$2,$3) as value",[second,JSON.stringify(expected),JSON.stringify({version:1,saved:false})]),false);
        assert.equal(await scalar("select metadata->'knowledgeOnly' as value from messages where id=$1",[second]),true);
        assert.equal(await scalar("select revision as value from assistant_context_revisions where conversation_id=$1",[parent]),before);
    });
    let child: string;
    await check("branch transaction copies only selected prefix and reuses request identity", async () => {
        const request = randomUUID();
        const fork = () => scalar<{id:string;copied_count:number}>("select assistant_fork_conversation($1,$2,$3,$4,null) as value",[parent,second,request,owner]);
        const result = await fork(); child = result.id;
        assert.equal(result.copied_count,2); assert.equal((await fork()).id,child);
        assert.equal(await scalar("select count(*)::int as value from messages where conversation_id=$1",[child]),2);
        assert.equal(await scalar("select count(*)::int as value from messages where conversation_id=$1 and metadata ? 'councilProposal'",[child]),0);
        assert.equal(await scalar("select count(*)::int as value from messages where conversation_id=$1",[parent]),3);
        await assert.rejects(scalar("select assistant_fork_conversation($1,$2,$3,$4,null) as value",[parent,future,request,owner]));
        await assert.rejects(scalar("select assistant_fork_conversation($1,$2,$3,$4,null) as value",[parent,second,randomUUID(),other]));
    });
    await check("related comparison is owned and lineage cannot change", async () => {
        const result = await scalar<{left:{messages:unknown[]};right:{messages:unknown[]}}>("select assistant_compare_conversations($1,$2,$3) as value",[parent,child,owner]);
        assert.equal(result.left.messages.length,3);assert.equal(result.right.messages.length,2);
        assert.equal(await scalar("select assistant_compare_conversations($1,$2,$3) as value",[parent,child,other]),null);
        await assert.rejects(db.query("update assistant_conversation_branches set parent_message_id=$2 where conversation_id=$1",[child,future]));
    });
    const task = randomUUID(), request = randomUUID();
    await db.query("insert into scheduled_tasks(id,user_profile_id,title,instruction,schedule_type,run_at,next_run_at) values ($1,$2,'Fixture task','Review source before send','once',now()-interval '1 minute',now()-interval '1 minute')",[task,owner]);
    const due = await scalar<Date>("select next_run_at as value from scheduled_tasks where id=$1",[task]);
    let run: string;
    await check("scheduled claim advances a one-off schedule atomically and starts once", async () => {
        const accepted = await scalar<{status:string;run:{id:string}}>("select assistant_claim_task_run($1,$2,'schedule',$3,$4,null) as value",[task,request,owner,due]);
        assert.equal(accepted.status,"accepted");run=accepted.run.id;
        assert.equal(await scalar("select enabled as value from scheduled_tasks where id=$1",[task]),false);
        assert.equal((await scalar<{status:string}>("select assistant_claim_task_run($1,$2,'manual',$3) as value",[task,request,owner])).status,"reused");
        assert.equal((await scalar<{status:string}>("select assistant_claim_task_run($1,$2,'manual',$3) as value",[task,randomUUID(),owner])).status,"active");
        assert.equal(await scalar("select assistant_start_task_run($1) as value",[run]),true);
        assert.equal(await scalar("select assistant_start_task_run($1) as value",[run]),false);
        assert.equal(await scalar("select assistant_delete_task($1,$2) as value",[task,owner]),false);
    });
    let approval: string, token: string;
    await check("approval proposal is immutable, deduplicated and excludes Council", async () => {
        const args=JSON.stringify({to:"fixture@example.invalid",body:"Synthetic draft"}), hash="a".repeat(64);
        const propose=()=>scalar<{id:string;status:string}>("select assistant_propose_action($1,'send_email',$2,$3,'quoted fixture evidence') as value",[run,args,hash]);
        const result=await propose(); approval=result.id;
        assert.equal(result.status,"pending");assert.equal((await propose()).id,approval);
        await assert.rejects(db.query("update assistant_action_approvals set args='{}' where id=$1",[approval]));
        await assert.rejects(scalar("select assistant_propose_action($1,'council_start','{}',$2,'') as value",[run,"b".repeat(64)]));
    });
    await check("owner-only approval can execute and finish exactly once", async () => {
        assert.equal(await scalar("select assistant_decide_action($1,$2,'approve') as value",[approval,other]),null);
        const accepted=await scalar<{claimed:boolean;approval:{execution_token:string}}>("select assistant_decide_action($1,$2,'approve') as value",[approval,owner]);
        assert.equal(accepted.claimed,true);token=accepted.approval.execution_token;
        assert.equal((await scalar<{claimed:boolean}>("select assistant_decide_action($1,$2,'approve') as value",[approval,owner])).claimed,false);
        assert.equal(await scalar("select assistant_finish_action($1,$2,'succeeded','confirmed') as value",[approval,randomUUID()]),false);
        assert.equal(await scalar("select assistant_finish_action($1,$2,'succeeded','confirmed') as value",[approval,token]),true);
        assert.equal(await scalar("select assistant_finish_action($1,$2,'succeeded','confirmed') as value",[approval,token]),false);
        await assert.rejects(db.query("update assistant_action_approvals set status='pending' where id=$1",[approval]));
    });
    await check("expired runs become interrupted before a new claim", async () => {
        await db.query("update assistant_task_runs set expires_at=now()-interval '1 minute' where id=$1",[run]);
        assert.equal(await scalar("select assistant_claim_task_delivery($1) as value",[run]),false);
        assert.equal(await scalar("select assistant_finish_task_run($1,'ok','late expired result') as value",[run]),false);
        const newer=await scalar<{status:string;run:{id:string}}>("select assistant_claim_task_run($1,$2,'manual',$3) as value",[task,randomUUID(),owner]);
        assert.equal(newer.status,"accepted");
        assert.equal(await scalar("select status as value from assistant_task_runs where id=$1",[run]),"interrupted");
        assert.equal(await scalar("select assistant_start_task_run($1) as value",[newer.run.id]),true);
        assert.equal(await scalar("select assistant_claim_task_delivery($1) as value",[newer.run.id]),true);
        assert.equal(await scalar("select assistant_claim_task_delivery($1) as value",[newer.run.id]),false);
        assert.equal(await scalar("select assistant_claim_task_delivery($1) as value",[run]),false);
        assert.equal(await scalar("select assistant_finish_task_run($1,'ok','new result') as value",[newer.run.id]),true);
        assert.equal(await scalar("select assistant_finish_task_run($1,'ok','late overwrite') as value",[run]),false);
        assert.equal(await scalar("select assistant_finish_task_run($1,'error','second overwrite') as value",[newer.run.id]),false);
        assert.equal(await scalar("select last_result as value from scheduled_tasks where id=$1",[task]),"new result");
    });
    await check("model-health SQL retains old success under a later 404", async () => {
        await db.query("insert into model_call_observations(id,provider_id,model_id,purpose,started_at,duration_ms,status,http_status,usage_completeness) values ($1,'fixture','model','chat',now()-interval '1 day',200,'success',200,'unavailable'),($2,'fixture','model','chat',now(),100,'unavailable',404,'unavailable')",[randomUUID(),randomUUID()]);
        const row=(await db.query<{latest_status:string;last_success_at:Date;total_calls:number}>("select * from assistant_model_health()")).rows[0];
        assert.equal(row.latest_status,"unavailable");assert.ok(row.last_success_at);assert.equal(Number(row.total_calls),2);
        await db.query("insert into model_call_observations(id,provider_id,model_id,purpose,started_at,duration_ms,status,http_status,usage_completeness) values ($1,'gemini','speech-fixture','speech',now(),20,'success',200,'unavailable')",[randomUUID()]);
        await assert.rejects(db.query("insert into model_call_observations(id,provider_id,model_id,purpose,started_at,duration_ms,status,http_status,usage_completeness) values ($1,'fixture','model','chat',now(),100,'retired',404,'unavailable')",[randomUUID()]));
    });
    const question=randomUUID(), source=randomUUID();
    const research=(action:string,payload:Record<string,unknown>,user=owner)=>scalar<Record<string,unknown>>("select assistant_research_mutate($1,$2,$3) as value",[user,action,JSON.stringify(payload)]);
    await check("research writes preserve owner, project and revision versions", async () => {
        const payload={id:question,projectId:project,title:"Evaluation methods",question:"Which method fits?",status:"active"};
        assert.equal((await research("create_question",payload)).version,1);
        assert.equal((await research("create_question",payload)).id,question);
        await assert.rejects(research("create_question",{...payload,id:randomUUID()},other));
        assert.equal((await research("update_question",{...payload,version:1,title:"Revised"})).version,2);
        assert.equal((await research("update_question",{...payload,version:1})).conflict,true);
    });
    await check("research evidence must match an accessible pinned source", async () => {
        await db.query("insert into knowledge_documents(id,path,title,content_hash) values ('fixture-doc','wiki/concepts/fixture.md','Fixture',$1)",["a".repeat(64)]);
        const payload={id:source,questionId:question,documentId:"fixture-doc",path:"wiki/concepts/fixture.md",commitSha:"b".repeat(40),contentHash:"a".repeat(64),title:"Fixture"};
        assert.equal((await research("add_source",payload)).id,source);
        const entry={id:randomUUID(),questionId:question,sourceId:source,kind:"claim",text:"Supported",evidence:{version:1,documentId:"fixture-doc",path:payload.path,commitSha:payload.commitSha,contentHash:payload.contentHash,quote:"exact",quoteHash:"c".repeat(64),startOffset:0,endOffset:5}};
        assert.equal((await research("create_entry",entry)).kind,"claim");
        await assert.rejects(research("create_entry",{...entry,id:randomUUID(),evidence:{...entry.evidence,commitSha:"f".repeat(40)}}));
        await assert.rejects(research("create_entry",{...entry,id:randomUUID(),kind:"interpretation"}));
        await db.query("update knowledge_documents set scope='session',project_id=null where id='fixture-doc'");
        await assert.rejects(research("add_source",{...payload,id:randomUUID()}));
        await db.query("update knowledge_documents set user_profile_id=$1 where id='fixture-doc'",[other]);
        await assert.rejects(research("add_source",{...payload,id:randomUUID()}));
    });
    const card=randomUUID(), review=randomUUID();
    const study=(action:string,payload:Record<string,unknown>,user=owner)=>scalar<Record<string,unknown>>("select assistant_study_save($1,$2,$3) as value",[user,action,JSON.stringify(payload)]);
    const evidence={version:1,quote:"An exact source passage",documentId:"fixture-doc",path:"wiki/concepts/fixture.md",commitSha:"b".repeat(40),contentHash:"a".repeat(64),quoteHash:"c".repeat(64),startOffset:0,endOffset:23};
    const cardBody={id:card,deck:"Fixture",kind:"recall",prompt:"Explain the passage",answer:"Source answer",evidence,schedule:{due:new Date(Date.now()-60000).toISOString()},requestHash:"d".repeat(64)};
    await check("study card creation replays safely and edits use owner and version", async()=>{
        assert.ok((await study("create",cardBody)).card);
        assert.ok((await study("create",cardBody)).card);
        assert.equal((await study("create",{...cardBody,requestHash:"e".repeat(64)})).error,"conflict");
        assert.equal((await study("edit",{...cardBody,version:1,active:true},other)).error,"missing");
        assert.equal((await study("edit",{...cardBody,version:99,active:true})).error,"conflict");
        await assert.rejects(db.query("update study_cards set evidence='{}' where id=$1",[card]));
    });
    await check("study reviews are atomic, replayable and capped by the owner day",async()=>{
        await scalar("select assistant_study_report($1) as value",[owner]);
        assert.ok((await study("settings",{version:1,dailyLimit:1,timezone:"Australia/Sydney"})).settings);
        const payload={id:review,cardId:card,version:1,requestHash:"f".repeat(64),rating:1,response:"My attempted explanation",reflection:"I missed the source qualification",schedule:{due:new Date(Date.now()+86400000).toISOString()},log:{rating:1}};
        const submit=(body:Record<string,unknown>,user=owner)=>scalar<{error?:string;reused?:boolean;review?:{prompt:string}}>("select assistant_study_review($1,$2) as value",[user,JSON.stringify(body)]);
        const first=await submit(payload);assert.equal(first.reused,false);assert.equal(first.review?.prompt,cardBody.prompt);
        assert.equal((await submit(payload)).reused,true);
        assert.equal((await submit({...payload,requestHash:"e".repeat(64)})).error,"conflict");
        assert.equal((await submit(payload,other)).error,"conflict");
        const secondCard=randomUUID();await study("create",{...cardBody,id:secondCard});
        assert.equal((await submit({...payload,id:randomUUID(),cardId:secondCard})).error,"daily_limit");
        const report=await scalar<{reviewed_today:number}>("select assistant_study_report($1) as value",[owner]);assert.equal(report.reviewed_today,1);
        await assert.rejects(db.query("update study_reviews set response='replacement' where id=$1",[review]));
        await assert.rejects(db.query("delete from study_reviews where id=$1",[review]));
    });
    await check("capture keys are scoped to profile and reject invalid payloads",async()=>{
        const id=randomUUID();
        await db.query("insert into capture_inbox(profile_id,id,source,source_hash) values ($1,$3,'{}',$4),($2,$3,'{}',$4)",[owner,other,id,"a".repeat(64)]);
        assert.equal(await scalar("select count(*)::int as value from capture_inbox where id=$1",[id]),2);
        const claim={path:"wiki/capture/fixture.md",contentHash:"b".repeat(64)};
        const reserve=(profile:string,body:unknown)=>scalar("select assistant_capture_claim($1,$2,$3) as value",[profile,id,JSON.stringify(body)]);
        assert.deepEqual(await reserve(owner,claim),claim);
        assert.deepEqual(await reserve(owner,{...claim,path:"wiki/capture/changed.md"}),claim);
        assert.equal(await scalar("select ingest_claim as value from capture_inbox where profile_id=$1 and id=$2",[other,id]),null);
        await assert.rejects(reserve(owner,{path:"",contentHash:"invalid"}));
        await assert.rejects(db.query("insert into capture_inbox(profile_id,id,source,source_hash) values ($1,$2,'[]',$3)",[owner,randomUUID(),"a".repeat(64)]));
    });
    await check("anonymous and signed-in client roles cannot call V6 privileged RPCs or read tables", async () => {
        for(const role of ["anon","authenticated"]) {
            await db.exec(`reset role; set role ${role}`);
            for (const sql of ["select * from study_reviews", "select * from study_cards", "select * from capture_inbox", "select assistant_capture_claim('00000000-0000-4000-8000-000000000000','00000000-0000-4000-8000-000000000000','{}')", "select assistant_study_report('00000000-0000-4000-8000-000000000000')", "select * from assistant_task_runs", "select * from research_questions", "select * from model_call_observations", "select * from assistant_conversation_summaries", "select * from assistant_conversation_branches", "select assistant_model_health()", "select assistant_start_task_run('00000000-0000-4000-8000-000000000000')", "select assistant_claim_task_delivery('00000000-0000-4000-8000-000000000000')", "select assistant_finish_task_run('00000000-0000-4000-8000-000000000000','ok','test')"])
                await assert.rejects(db.query(sql),/permission denied/);
        }
        await db.exec("reset role");
    });
    console.log(`${passed} local PostgreSQL migration groups passed (${files.length} migrations, in-memory PGlite, no hosted database).`);
} finally { await db.close(); }
