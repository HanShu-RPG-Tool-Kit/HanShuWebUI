/** Tests importing bundled goal scripts need Vite's import.meta.glob transform, not a CDN runner. */
import { createServer } from 'vite'
const path=process.argv[2]
if(!/^scripts\/verify-[a-z-]+\.ts$/.test(path??''))throw new Error('Expected a repository verification script')
const server=await createServer({server:{middlewareMode:true},appType:'custom',optimizeDeps:{noDiscovery:true,include:[]}})
try {await server.ssrLoadModule(`/${path}`)} finally {await server.close()}
