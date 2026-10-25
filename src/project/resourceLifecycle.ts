/** Client editor lifecycle; S still owns all structural changes. */
export type SourceChange = {path:string;destination:string|null}
export type ResourceEditorHooks = {
  prepare(): Promise<string | void>
  cancel(): void
  committed(destination:string|null): void | Promise<void>
  missing(): void
}
type Editor = {path:string;hooks:ResourceEditorHooks}
type Transition = {editors:Editor[];id?:number}
const contains=(parent:string,path:string)=>parent===path||path.startsWith(`${parent}/`)

export class ResourceLifecycle {
  private editors=new Set<Editor>()
  private pending=new Set<Transition>()
  register(path:string,hooks:ResourceEditorHooks):()=>void {
    const editor={path,hooks};this.editors.add(editor)
    return ()=>{this.editors.delete(editor)}
  }
  async prepare(changes:SourceChange[]) {
    const editors=[...this.editors].filter(editor=>changes.some(change=>contains(change.path,editor.path)))
    if(editors.some(editor=>[...this.pending].some(pending=>pending.editors.includes(editor))))throw new Error('资源结构操作尚未完成，请先确认原提交')
    const transition:Transition={editors};if(editors.length)this.pending.add(transition)
    try {
      const contents=await Promise.all(editors.map(async editor=>({path:editor.path,content:await editor.hooks.prepare()})))
      return {
        contents,
        submitted:(id:number)=>{transition.id=id},
        cancel:()=>this.cancel(transition),
      }
    }catch(error){this.cancel(transition);throw error}
  }
  private cancel(transition:Transition){
    if(!this.pending.delete(transition))return
    for(const editor of transition.editors)if(this.editors.has(editor))editor.hooks.cancel()
  }
  settle(records:readonly {id:number;phase:string}[]){
    for(const transition of this.pending){
      if(transition.id===undefined)continue
      const record=records.find(record=>record.id===transition.id)
      if(record&&['failed','conflict'].includes(record.phase))this.cancel(transition)
    }
  }
  async committed(edits:readonly {op:string;path:string;destination?:string}[]){
    for(const editor of [...this.editors]){
      const edit=edits.find(edit=>['move','remove'].includes(edit.op)&&contains(edit.path,editor.path))
      if(!edit)continue
      const destination=edit.op==='move'&&edit.destination?edit.destination+editor.path.slice(edit.path.length):null
      if(destination)editor.path=destination;else this.editors.delete(editor)
      for(const transition of this.pending){
        transition.editors=transition.editors.filter(item=>item!==editor)
        if(!transition.editors.length)this.pending.delete(transition)
      }
      await editor.hooks.committed(destination)
    }
  }
  observe(paths:ReadonlySet<string>){
    for(const editor of [...this.editors]){
      if(paths.has(editor.path)||[...this.pending].some(pending=>pending.editors.includes(editor)))continue
      this.editors.delete(editor);editor.hooks.missing()
    }
  }
}
