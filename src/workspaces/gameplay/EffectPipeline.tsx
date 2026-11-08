import type { EffectResource } from './effectResources'

export type EffectPass = { entry: string; inputs?: string[]; output?: string }
export type EffectTargets = Record<string, { scale?: number }>

/** Author a post-processing chain without editing its serialized representation. */
export function EffectPipeline({ resource, disabled, onChange }: {
  resource: EffectResource; disabled?: boolean; onChange: (resource: EffectResource) => void
}) {
  const targets = (resource.manifest.targets ?? {}) as EffectTargets
  const passes = (resource.manifest.passes ?? [{ entry: 'process' }]) as EffectPass[]
  const write = (nextTargets: EffectTargets, nextPasses: EffectPass[]) => onChange({ ...resource, manifest: {
    ...resource.manifest, targets: Object.keys(nextTargets).length ? nextTargets : undefined, passes: nextPasses,
  } })
  const change = (index: number, patch: Partial<EffectPass>) => write(targets, passes.map((p,i)=>i===index?{...p,...patch}:p))
  return <div className="effect-pipeline">
    <p>从上到下处理画面。中间步骤写入缓冲图，最后一步输出滤镜结果。入口函数仍在 GLSL 中实现。</p>
    <section><h3>中间缓冲图</h3>
      {Object.entries(targets).map(([name,target])=><div className="effect-pipeline-target" key={name}>
        <code>{name}</code><label>分辨率比例<input aria-label={`${name} 分辨率比例`} type="number" min=".0625" max="1" step=".0625" value={target.scale??1} disabled={disabled} onChange={e=>write({...targets,[name]:{...target,scale:e.target.value===''?NaN:Number(e.target.value)}},passes)}/></label>
        <button type="button" disabled={disabled||passes.some(p=>p.output===name||p.inputs?.includes(name))} onClick={()=>{const next={...targets};delete next[name];write(next,passes)}}>移除 {name}</button>
      </div>)}
      {!Object.keys(targets).length&&<p>当前直接处理画面，无中间缓冲。</p>}
      <button type="button" disabled={disabled||Object.keys(targets).length>=4} onClick={()=>{let name='buffer';for(let i=2;targets[name]||resource.manifest.params?.[name];i++)name='buffer_'+i;write({...targets,[name]:{scale:.5}},passes)}}>添加缓冲图</button>
    </section>
    <section><h3>处理顺序</h3><ol>
      {passes.map((pass,i)=><li key={i}>
        <header><strong>步骤 {i+1}</strong><span>{i===passes.length-1?'输出最终画面':'中间处理'}</span></header>
        <label>入口函数<input aria-label={`步骤 ${i+1} 入口函数`} value={pass.entry} disabled={disabled} onChange={e=>change(i,{entry:e.target.value})}/></label>
        <fieldset disabled={disabled}><legend>读取缓冲图</legend>{Object.keys(targets).map(name=><label key={name}><input type="checkbox" aria-label={`步骤 ${i+1} 读取 ${name}`} checked={pass.inputs?.includes(name)??false} disabled={disabled||pass.output===name} onChange={e=>change(i,{inputs:e.target.checked?[...pass.inputs??[],name]:(pass.inputs??[]).filter(n=>n!==name)})}/>{name}</label>)}{!Object.keys(targets).length&&<span>直接读取游戏画面</span>}</fieldset>
        {i<passes.length-1&&<label>写入缓冲图<select aria-label={`步骤 ${i+1} 输出`} value={pass.output??''} disabled={disabled} onChange={e=>change(i,{output:e.target.value,inputs:(pass.inputs??[]).filter(n=>n!==e.target.value)})}><option value="">选择输出</option>{Object.keys(targets).map(name=><option key={name}>{name}</option>)}</select></label>}
        <button type="button" disabled={disabled||passes.length===1} onClick={()=>{const next=passes.filter((_,at)=>at!==i).map(p=>({...p}));delete next[next.length-1].output;write(targets,next)}}>移除步骤 {i+1}</button>
      </li>)}
    </ol><button type="button" disabled={disabled||passes.length>=8||!Object.keys(targets).length} onClick={()=>{const output=Object.keys(targets)[0];write(targets,[...passes.slice(0,-1),{...passes[passes.length-1],output,inputs:(passes[passes.length-1].inputs??[]).filter(n=>n!==output)},{entry:'process',inputs:[output]}])}}>添加处理步骤</button></section>
  </div>
}
