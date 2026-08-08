# DSH Change Ledger

[English](README.md)

为 DeepSeek Harness 提供**持久、可检查、可安全恢复**的工作树变更集。

它给 DSH Session 增加一条明确的安全边界：

```text
创建恢复点
    ↓
Agent / 用户 / 外部程序修改工作树
    ↓
检查逐路径变化
    ↓
规划全部或部分恢复
    ↓
回填短期确认码 + 通过 DSH 人工批准
    ↓
先建救援点 → 恢复 → 哈希验证
```

插件**不会**自动 commit、stash、reset、切分支、修改 Git index，也不会替用户判断某项改动“应该回滚”。

## 为什么它不是一个 Diff 按钮

普通 Git 面板可以展示当前 diff，但不拥有完整、持久的恢复生命周期。Change Ledger 独立负责：

- 内容寻址的恢复点 manifest；
- Git worktree、HEAD、分支和进行中 Git 操作的状态围栏；
- 从审阅到执行之间的 stale plan 检测；
- 短期确认码与 DSH 人工批准双门槛；
- 每次恢复前自动建立救援点；
- 恢复后的内容哈希验证；
- 恢复失败后的自动回滚；
- DSH 重启时对未完成操作日志进行对账；
- 可供其他插件依赖的 `ctx.changeLedger` 公共服务。

持久格式见 [docs/FORMAT.md](docs/FORMAT.md)，安全与故障模型见 [SECURITY.md](SECURITY.md)。

## 安全契约

- **只做显式操作：**工具说明要求模型仅在用户明确提出时创建恢复点。
- **先读后写：**`change_ledger_plan_restore` 只生成短期计划和确认码，不修改文件。
- **人工门禁：**`change_ledger_apply_restore` 与 `change_ledger_delete` 在执行前固定返回 DSH `ask`；无人值守的 `approval: never` 配置会 fail closed。
- **先救援再修改：**恢复任何文件前，先持久化当前 eligible tree 的救援点。
- **不静默漏文件：**遇到 submodule、sparse checkout、超限文件、总量超限或特殊文件类型时，创建恢复点直接失败。
- **不允许路径逃逸：**所有持久路径必须是规范的工作树相对路径；恢复拒绝穿过 symlink 父目录，也拒绝覆盖非空目录。
- **不覆盖审阅后的新变化：**执行时重新检查所选路径，以及审阅过的 HEAD、分支和 Git 操作状态；任何相关变化都会使计划失效。
- **不碰 Git 控制面：**index、分支、HEAD、stash 和 commit 均保持原样。

## 支持范围

`0.1` 只支持普通 Git worktree：

- tracked 文件，包括恢复点创建时已经缺失的 tracked 路径；
- 未被 `.gitignore` 或 Git 标准 excludes 忽略的 untracked 文件；
- 文本和二进制普通文件；
- 符号链接；
- 可执行位等可移植权限位。

下列对象会被拒绝或明确排除：

- sparse checkout；
- submodule gitlink（应分别进入每个 submodule 建恢复点）；
- ignored 文件；
- socket、设备、FIFO 等特殊文件；
- 扩展属性、ACL、所有者、时间戳和 hard-link 拓扑；
- Git index 和仓库元数据；
- 非 Git 目录。

如果 ignored 或其他未受管理的文件占据了待恢复路径，插件会拒绝恢复，不会递归删除它。

## 安装

```sh
pnpm install --frozen-lockfile
pnpm run check

dsh plugin --profile web add /path/to/dsh-change-ledger
dsh plugin --profile headless add /path/to/dsh-change-ledger

dsh --profile web --dump-config | grep change-ledger
```

修改 Profile Bundle 后需要重启对应 DSH 进程。

本仓库是标准 DSH Profile Bundle：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 直接挂载 `@dsh-external/change-ledger`，不修改 DSH 主仓库。

当 Profile 同时提供 DSH Agent 服务时，插件会在每个已完成 Turn 后同步占用 Agent 的 idle maintenance 边界，先完成隐藏检查点，再允许排队输入启动下一轮。Web Profile 还会提供同源 `/change-ledger/rewind` 接口，用于返回有界预览并生成普通的短期、会话绑定恢复计划。Turn 完成只会捕获状态，绝不会自动恢复代码。

## 使用流程

在 Web Profile 中，每个已落定的 Assistant Turn 都会通过官方 `conversation.chat.turnTail` 扩展点显示一个紧凑的**回退**入口。打开后才按需读取检查点，展示有界的逐路径变化，阻止 HEAD 或 Git 操作漂移，并要求用户明确勾选确认后才恢复代码；当前这一模式保持对话位置不变。

可以直接向 Agent 提出：

```text
创建一个名为“重构鉴权前”的 Change Ledger 恢复点。

检查恢复点 rp_...，展示前 100 条变化。

规划只恢复 rp_... 中的 src/auth.ts 和 tests/auth.test.ts。

使用确认码 RESTORE-... 执行 plan_...。
```

最后一步仍会弹出 DSH 标准人工批准框。拿到计划确认码不等于绕过批准。

## 工具

| 工具 | 是否修改 | 用途 |
| --- | --- | --- |
| `change_ledger_create` | 只写状态目录 | 创建用户恢复点。 |
| `change_ledger_list` | 否 | 分页列出恢复点；默认隐藏自动救援点。 |
| `change_ledger_inspect` | 否 | 分页查看当前工作树相对恢复点的变化。 |
| `change_ledger_plan_restore` | 只写内存计划 | 选择精确路径并生成短期确认码。 |
| `change_ledger_apply_restore` | 工作树 | 经批准后建立救援点、恢复并验证。 |
| `change_ledger_delete` | 状态目录 | 经批准后删除恢复点并回收无引用 blob。 |
| `change_ledger_recovery_list` | 否 | 分页查看中断操作及其救援点。 |

模型可见的列表、检查、故障恢复、计划和执行结果均有分页或截断上限；同进程服务 API 会向可信插件返回完整结构化数据。

## 配置

在 Profile 的 patch 层覆盖：

```yaml
- id: change-ledger
  config:
    storageDir: ~/.dsh/change-ledger/v1
    maxRestorePoints: 50
    maxTurnCheckpointsPerSession: 30
    maxFiles: 20000
    maxFileBytes: 16777216
    maxSnapshotBytes: 536870912
    planTtlMs: 900000
    staleLockMs: 30000
```

所有容量与用户恢复点数量限制都采用 fail loud。自动 Turn 检查点使用独立的每会话保留窗口，并且只清理自己最旧的检查点；用户和救援恢复点永远不会被静默删除。未配置时，`storageDir` 使用 `$DSH_HOME/change-ledger/v1`，未设置 `DSH_HOME` 时回退到 `~/.dsh/change-ledger/v1`；它不得与被管理 worktree 重叠。

## 故障恢复

任何路径写入前，插件都会先创建救援点和持久 operation journal。如果 DSH 在非终态操作期间退出，下次启动会把该操作标记为 `interrupted`；如果另一个仍存活的 DSH 进程持有工作树锁，则不会误判其操作。

使用 `change_ledger_recovery_list` 找到 `rescuePointId`，检查该救援点，然后针对 operation 中的路径走正常的 plan/apply 流程。救援点在被显式删除前始终是普通、可检查的恢复点。

## 公共服务

其他 Cordis 插件可以注入 `changeLedger`，直接调用结构化 API：

```ts
export const inject = ['changeLedger']

export async function apply(ctx: Context) {
  const point = await ctx.changeLedger.create({
    cwd: '/absolute/git/worktree',
    sessionId: 'session-id',
    label: 'before refactor',
  })
  // point.id 是持久恢复点 ID。
}
```

完整格式类型从 `@dsh-external/change-ledger/format` 导出；可信集成和测试可以从 `@dsh-external/change-ledger/core` 使用独立 Engine。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm run check
```

测试会创建真实的临时 Git 仓库，覆盖全部/部分恢复、stale plan、ignored 路径冲突拒绝、HEAD 变化、救援回滚、崩溃对账、活动锁保护、持久状态完整性、symlink、容量限制、sparse checkout、submodule、删除和 blob GC。

## 许可证

BSD-3-Clause，见 [LICENSE](LICENSE)。
