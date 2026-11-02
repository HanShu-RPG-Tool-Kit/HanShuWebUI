/** Java namespaces are an implementation detail of the virtual type library. */
export function readableJavaTypes(text:string):string {
  return text.replace(/\bjvm_[A-Za-z0-9_]+(?:\.([A-Za-z_$][\w$]*))?/g,(encoded:string,symbol:string|undefined)=>{
    if(symbol)return symbol
    // Decode in one pass: an escaped underscore must not become a separator.
    const name=encoded.slice(4).replace(/__|_d_|_s_/g,part=>part==='__'?'_':part==='_d_'?'.':'$')
    return name.split(/[.$]/).at(-1)??name
  })
}
