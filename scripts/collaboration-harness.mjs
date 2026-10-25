import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { rememberTestAccount, testAccount } from './test-accounts.mjs'

export const progress = {format:'hanshu.progress',version:1,id:'progress-test',name:'name',description:'description',authorNotes:'',tags:[],completion:'all',goals:[],visibility:[],acceptance:[],abandonable:true,autoStartWhenAcceptable:false,repeat:{kind:'once',hours:24},rewardKits:[]}
export async function harness(web = false) {
  const options={...(typeof web==='object'?web:{web})}
  if(options.web && options.localProjects===undefined)options.localProjects=true
  const host=options.host??'127.0.0.1'
  const root=options.root??await mkdtemp(join(tmpdir(),'hanshu-project-test-'))
  const fixtures={
    'project.json':JSON.stringify({version:1,id:'shared-test-project',name:'统一工程验收'}),
    'src/hanshu/story.hs':'标题：协作测试\n\n第一场\n\n',
    'src/quest/example.quest':JSON.stringify(progress),
    'src/script/common/example.py':'print("server-owned file")\n',
    'meta/docs/notes.md':'# 工程笔记\n',
    'assets/zh_cn/lang_quest/example.lang':JSON.stringify({name:'共同进度',description:'由同一工程服务管理'}),
    '.hanshu/skinmanager/library.json':JSON.stringify({schemaVersion:5,revision:1,folders:[],entries:[]}),
  }
  for(const [path,content]of Object.entries(fixtures)){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),content)}
  const binary=resolve('src-tauri/target/debug',process.platform==='win32'?'project-server.exe':'project-server')
  let child; let base
  async function start(port=0){
    child=spawn(binary,['--project',root,'--listen',`${host}:${port}`,...(options.origins??[]).flatMap(origin=>['--origin',origin]),...options.localProjects?['--local-projects','true']:[],...options.web?['--web-root',resolve('dist')]:[]],{stdio:['ignore','pipe','pipe'],windowsHide:true})
    let output='';let errors=''
    base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('S startup timed out')),15000);child.stdout.on('data',c=>{output+=c;const match=/HanShu S: (http:\/\/[^\s]+)/.exec(output);if(match){clearTimeout(timer);resolve(match[1])}});child.stderr.on('data',c=>{errors+=c});child.on('error',reject);child.once('exit',code=>{clearTimeout(timer);reject(new Error(`S exit ${code}: ${errors}`))})})
  }
  async function stop(){if(!child||child.exitCode!==null)return;child.kill();await new Promise(r=>child.once('exit',r))}
  async function api(token,path,method='GET',body,status=200,origin){
    let fixturePassword
    if(path==='/api/sessions'&&body?.credential){const account=testAccount(body.credential);path=account.local?'/api/local-session':'/api/sessions';body=account.local?body:{username:account.username,password:account.password,clientName:body.clientName}}
    if(path==='/api/subjects'&&method==='POST'){fixturePassword=randomUUID();body={username:`test_${randomUUID().replaceAll('-','').slice(0,16)}`,nickname:body.name,kind:body.kind,password:fixturePassword,role:body.role};path='/api/accounts'}
    else if(path.startsWith('/api/subjects/'))path=path.replace('/api/subjects/','/api/accounts/')
    const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...token?{Authorization:`Bearer ${token}`}:{},...origin?{Origin:origin}:{}},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});let value=await response.json().catch(()=>null);assert.equal(response.status,status,`${method} ${path}: ${value?.code??response.status}`)
    if(fixturePassword&&value?.user){rememberTestAccount(fixturePassword,{username:value.user.username,password:fixturePassword});value={subject:{...value.user,name:value.user.nickname},credential:fixturePassword}}
    return value
  }
  async function login(key,name){return api('','/api/sessions','POST',{credential:key,clientName:name})}
  async function files(token){return api(token,'/api/files')}
  async function prepare(token,edits){
    const tree=await files(token)
    const plan=await api(token,'/api/files/plan','POST',{operations:edits.map(e=>({op:e.op??'write',path:e.path,destination:e.destination??null}))})
    const leases=await api(token,'/api/files/leases','POST',{paths:plan.leasePaths})
    const changes=edits.map(e=>({op:e.op??'write',path:e.path,version:tree.entries.find(f=>f.path===e.path)?.version??null,content:e.content===undefined?null:Buffer.from(e.content).toString('base64'),destination:e.destination??null,destinationVersion:tree.entries.find(f=>f.path===e.destination)?.version??null,leaseId:leases.find(l=>l.resourceId===`file:${e.path}`).id,...e.version!==undefined?{version:e.version}:{}}))
    return {transactionId:randomUUID(),changes}
  }
  async function commit(token,edits,status=200){
    const request=await prepare(token,edits)
    const receipt=await api(token,'/api/files/commit','POST',request)
    assert.equal(receipt.status,status===200?'committed':'rejected')
    if(status!==200)assert.equal(receipt.error?.code,({400:'invalid',403:'forbidden',409:'conflict',423:'locked'})[status])
    return receipt
  }
  async function release(token){const s=await api(token,'/api/project');for(const l of s.leases.filter(l=>l.sessionId===s.session.id))await api(token,'/api/files/leases','DELETE',{path:l.resourceId.slice(5),leaseId:l.id})}
  await start()
  const credential=await readFile(join(root,'.hanshu/service/owner-key'),'utf8')
  rememberTestAccount(credential,{username:'Admin',local:true})
  return {root,fixtures,get base(){return base},credential,start,stop,api,login,files,prepare,commit,release}
}
