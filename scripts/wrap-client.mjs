import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const built = new URL('../.client-build/index.js', import.meta.url)
const builtMap = new URL('../.client-build/index.js.map', import.meta.url)
const lib = new URL('../lib/', import.meta.url)
const source = (await readFile(built, 'utf8')).replace(/\n?\/\/# sourceMappingURL=.*\n?$/, '\n')
const sourceMap = JSON.parse(await readFile(builtMap, 'utf8'))
sourceMap.file = 'client.js'
sourceMap.sources = sourceMap.sources.map(sourcePath => `../src/client/${sourcePath.replace(/^\.\.\//, '')}`)
const banner = 'window.__ModuleLoader__.load({ id: "@dsh-external/turn-rewind", factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;\n'
const footer = '\nreturn module.exports; } });\n//# sourceMappingURL=client.js.map\n'

await mkdir(lib, { recursive: true })
await writeFile(join(fileURLToPath(lib), 'client.js'), `${banner}${source}${footer}`)
await writeFile(join(fileURLToPath(lib), 'client.js.map'), `${JSON.stringify(sourceMap)}\n`)
await rm(new URL('../.client-build/', import.meta.url), { recursive: true, force: true })
