/** All editor assets and workers come from the same C deployment, including offline LAN use. */
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === 'json') return new JsonWorker()
    if (['css','scss','less'].includes(label)) return new CssWorker()
    if (['html','handlebars','razor'].includes(label)) return new HtmlWorker()
    if (['typescript','javascript'].includes(label)) return new TsWorker()
    return new EditorWorker()
  },
}
loader.config({monaco})
