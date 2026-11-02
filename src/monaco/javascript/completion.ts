import type * as Monaco from 'monaco-editor'

export type LanguageCompletion = {name:string;kind:string;sortText:string;insertText?:string;callable?:boolean;member?:boolean;parameterCount?:number}

/** Keep fields as fields; add call syntax only when accepting a callable suggestion. */
export function javascriptCompletion(monaco:typeof Monaco,model:Monaco.editor.ITextModel,position:Monaco.Position,entry:LanguageCompletion):Monaco.languages.CompletionItem {
  const word=model.getWordAtPosition(position)??model.getWordUntilPosition(position)
  const range=new monaco.Range(position.lineNumber,word.startColumn,position.lineNumber,word.endColumn)
  const callable=entry.callable??(entry.kind==='method'||entry.kind==='function')
  const kinds=monaco.languages.CompletionItemKind
  const fieldKinds:Record<string,Monaco.languages.CompletionItemKind>={property:kinds.Field,getter:kinds.Property,setter:kinds.Property,var:kinds.Variable,let:kinds.Variable,const:kinds.Constant,parameter:kinds.Variable,class:kinds.Class,interface:kinds.Interface,enum:kinds.Enum,module:kinds.Module,keyword:kinds.Keyword}
  const result:Monaco.languages.CompletionItem={label:entry.name,sortText:entry.sortText,insertText:entry.insertText??entry.name,kind:callable?(entry.member||entry.kind==='method'?kinds.Method:kinds.Function):fieldKinds[entry.kind]??kinds.Property,range}
  const following=model.getLineContent(position.lineNumber).slice(word.endColumn-1).trimStart()
  if(callable&&!following.startsWith('(')&&!result.insertText.includes('(')){
    if(entry.parameterCount===0)result.insertText+='()'
    else{
      result.insertText=result.insertText.replace(/[\\$}]/g,'\\$&')+'($0)'
      result.insertTextRules=monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
      result.command={id:'editor.action.triggerParameterHints',title:'参数提示'}
    }
  }
  return result
}
