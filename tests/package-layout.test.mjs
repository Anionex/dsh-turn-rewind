import assert from 'node:assert/strict'
import { access, readFile, readdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const workspace = await readFile(new URL('pnpm-workspace.yaml', root), 'utf8')

test('package is a portable, prebuilt DSH Profile Bundle', async () => {
  assert.equal(pkg.name, '@anionex/dsh-turn-rewind')
  assert.notEqual(pkg.private, true)
  assert.equal(pkg.repository?.url, 'git+https://github.com/Anionex/dsh-turn-rewind.git')
  assert.equal(pkg.bugs?.url, 'https://github.com/Anionex/dsh-turn-rewind/issues')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.deepEqual(pkg.dsh?.client, {
    platform: 'web',
    // Informational prefetch metadata (dsh-package-manifest: "not Cordis service
    // injection"): the packages that provide this client's services and slot —
    // slots ← dsh-client-ui-renderer, sessions ← dsh-api-session-controller,
    // conversation ← dsh-client-ui-conversation, settingsScope ←
    // dsh-client-ui-settings, settings.plugin.item ← dsh-client-ui-settings-plugins.
    // `@deepseek-ai/dsh-client-runtime` was last published as 0.1.1-rc.2 and appears
    // nowhere in DSH 0.1.5.
    inject: [
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-settings-plugins',
    ],
  })
  // Every runtime `require()` in lib/client.js (react, react/jsx-runtime, react-dom,
  // @deepseek-ai/dsh-client-ui-primitives) resolves from the platform seed table, so
  // the client declares no extra module request.
  assert.equal(pkg.dsh?.client?.external, undefined)
  assert.deepEqual(pkg.dsh?.compatibility, {
    dsh: '>=0.1.0-rc.8 <0.2.0',
    dshReleases: {
      '0.1.0-rc.8': 'compatible',
      '0.1.1-rc.1': 'compatible',
      '0.1.1-rc.2': 'compatible',
      '0.1.2-alpha.1': 'compatible',
      '0.1.2-alpha.3': 'compatible',
      '0.1.2-alpha.4': 'compatible',
      '0.1.2-alpha.5': 'compatible',
      '0.1.5-rc.1': 'compatible',
    },
    profiles: ['web'],
  })
  assert.equal(pkg.dshClient, undefined)
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.types, 'lib/types/index.d.ts')
  assert.ok(pkg.files.includes('lib'))
  assert.ok(pkg.files.includes('src'))
  assert.ok(pkg.files.includes('scripts'))
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  assert.equal(typeof pkg.scripts?.build, 'string')
  assert.equal(typeof pkg.scripts?.prepack, 'string')
  assert.equal(pkg.peerDependencies?.['@deepseek-ai/cordis'], '^4.0.1')
  // One clause per release line: semver only admits a prerelease when a comparator
  // with the same major.minor.patch also carries one, so `>=0.1.0-rc.8 <0.2.0` alone
  // silently refuses every later prerelease — 0.1.5-rc.1 included.
  const settingsRange = '>=0.1.0-rc.8 <0.2.0 || ^0.1.1-rc.1 || ^0.1.2-alpha.1 || ^0.1.5-rc.1'
  assert.equal(pkg.peerDependencies?.['@deepseek-ai/dsh-settings'], settingsRange)
  assert.equal(pkg.devDependencies?.['@deepseek-ai/dsh-settings'], settingsRange)
  assert.equal(pkg.peerDependencies?.['@deepseek-ai/dsh-client-runtime'], undefined)
  assert.equal(pkg.peerDependencies?.['@deepseek-ai/schemastery'], '^3.18.1')
  assert.equal(pkg.peerDependencies?.cordis, undefined)
  assert.match(workspace, /^packages:\n  - \.\n/mu)
  assert.match(workspace, /^nodeLinker: hoisted$/mu)
  assert.match(workspace, /^autoInstallPeers: false$/mu)

  await access(new URL(pkg.main, root))
  await access(new URL(pkg.types, root))
  await access(new URL(pkg.dsh.bundle.patch, root))
  // Every runtime entry point resolves under lib/ with its declaration under lib/types/:
  // a broken exports map breaks Profile Bundle installation before any code runs.
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    if (typeof value !== 'object' || value === null) continue
    assert.equal(typeof value.types, 'string', `exports["${key}"] must declare a types entry`)
    assert.equal(typeof value.default, 'string', `exports["${key}"] must declare a default entry`)
    assert.match(value.types, /^\.\/lib\/types\//u, `exports["${key}"].types must live under lib/types/`)
    assert.match(value.default, /^\.\/lib\//u, `exports["${key}"].default must live under lib/`)
    await access(new URL(value.types, root))
    await access(new URL(value.default, root))
  }
  assert.doesNotMatch(
    await readFile(new URL(pkg.main, root), 'utf8'),
    /from ['"](?:@deepseek-ai\/)?cordis['"]/u,
    'the prebuilt host entry must not require a checkout-local Cordis installation',
  )

  // DSH 0.1.5's dsh-settings exports only SettingsConflictError, SettingsProvider,
  // default, and redactSecrets: importing or calling the removed helpers anywhere in
  // the shipped tree (or its source) reintroduces the load-time failure that takes the
  // whole web profile down with `does not provide an export named
  // 'installSettingsSection'`. Doc comments may still name them; code may not.
  for (const directory of ['src', 'lib']) {
    for (const file of await readdir(new URL(directory, root))) {
      if (!/\.(?:ts|tsx|js)$/u.test(file) || file.endsWith('.map')) continue
      const source = await readFile(new URL(`${directory}/${file}`, root), 'utf8')
      assert.doesNotMatch(
        source,
        /\bimport\b[^\n]*\b(?:installSettingsSection|settingsNamespace)\b/u,
        `${directory}/${file} must not import a helper DSH 0.1.5 removed`,
      )
      assert.doesNotMatch(
        source,
        /\b(?:installSettingsSection|settingsNamespace)\s*\(/u,
        `${directory}/${file} must not call a helper DSH 0.1.5 removed`,
      )
    }
  }
  assert.doesNotMatch(
    await readFile(new URL('lib/settings.js', root), 'utf8'),
    /from ['"]@deepseek-ai\/dsh-settings['"]/u,
    'the settings module must carry no runtime import from dsh-settings',
  )

  for (const [name, specifier] of Object.entries(pkg.devDependencies ?? {})) {
    assert.equal(
      isAbsolute(specifier) || /^(?:file|link):/u.test(specifier) || /^[A-Za-z]:[\\/]/u.test(specifier),
      false,
      `devDependency ${name} must not use a machine-local path: ${specifier}`,
    )
  }
})
