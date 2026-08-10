import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

test('package is a portable, prebuilt DSH Profile Bundle', async () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.deepEqual(pkg.dsh?.client, {
    platform: 'web',
    inject: [
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-conversation',
    ],
  })
  assert.equal(pkg.dshClient, undefined)
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.types, 'lib/types/index.d.ts')
  assert.ok(pkg.files.includes('lib'))
  assert.ok(pkg.files.includes('src'))
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  assert.equal(typeof pkg.scripts?.build, 'string')
  assert.equal(typeof pkg.scripts?.prepack, 'string')

  await access(new URL(pkg.main, root))
  await access(new URL(pkg.types, root))
  await access(new URL(pkg.dsh.bundle.patch, root))

  for (const [name, specifier] of Object.entries(pkg.devDependencies ?? {})) {
    assert.equal(
      isAbsolute(specifier) || /^(?:file|link):/u.test(specifier) || /^[A-Za-z]:[\\/]/u.test(specifier),
      false,
      `devDependency ${name} must not use a machine-local path: ${specifier}`,
    )
  }
})
