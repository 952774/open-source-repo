# 更新日志

本项目遵循语义化版本。清单（tools.ts）的增删不计入版本号，随发布一起更新。

## v1.3.1 — 2026-11-25

这一版只修三处「看起来没反应」的问题，其中两处是上一版埋的。

### 修：安装包体积一直显示「未知」

详情页的「安装包体积」从来都是「未知」。原因不在取大小的逻辑，而在取不到解析输入：
ToolArk 用 `CREATE_NO_WINDOW` 起 PowerShell，没有控制台时 PowerShell 会把
`[Console]::OutputEncoding` 退成 **gb2312**、`$OutputEncoding` 退成 **us-ascii**。
winget 吐的是 UTF-8 字节，走管道时被按 GBK 解码，「安装程序 URL」就成了
`瀹夎绋嬪簭 URL`，中文正则永远匹配不上。

现在不再让 PowerShell 接管 winget 的 stdout：重定向到临时文件，再用
`[IO.File]::ReadAllText($tmp, UTF8)` 读原始字节，正则改成 `(?m)^\s*(?:安装程序|Installer)\s*(?:URL|Url)\s*[:：]\s*(\S+)`
（锚定行首，免得把「发布服务器 URL」当成安装器地址）。实测：Git 66.9 MB、
OpenShot 248 MB、7-Zip 2.0 MB、Windows Terminal 23.8 MB、uv 15.6 MB，全部命中。

### 修：MSIX 应用包既打不开也卸不掉

TranslucentTB 装完点「打开」提示定位失败，点清理又提示「没找到残留注册表条目」。
它 `winget show` 的安装程序类型是 `msix`——装进 `C:\Program Files\WindowsApps`，
既不写 ARP 三根注册表，也不在 App Paths 里，原来的三级定位（注册表 → InstallLocation
递归 → App Paths）全都够不着，于是被当成"注册表残留"，而残留清理又只认注册表，
形成死循环。

新增第四条定位路径 `4) AppX / MSIX 兜底`：`Get-AppxPackage` 按包名匹配，从
`AppxManifest.xml` 里取 `<Application Id="...">`，拼成
`shell:AppsFolder\<PackageFamilyName>!<AppId>` 交给 `explorer.exe` 启动。
卸载侧新增 `appx_uninstall.ps1`（`Remove-AppxPackage`），`purge_stale` 与
`uninstall_tool` 在 winget 通道失败后都会先试它；`force_uninstall.ps1` 也加了
「2b. MSIX / AppX 应用包」一步。缓存版本提到 v4，让 v3 里那些 `exe=null` 的
旧条目一次作废。

### 修：没装的软件显示成「夸克」

排查上面那条时发现：查 TranslucentTB 返回的 displayName 是「夸克」。
根因是 PowerShell 的作用域——`Where-Object` 脚本块里赋值不会创建局部变量，
而是直接写到当前作用域。退化匹配块里用 `$dn` 当临时变量，把外层 `$dn` 污染了，
最后留下的是 ARP 遍历的最后一轮值。临时变量改名 `$dnNorm`，并在块后显式
`$dn = $null`。

### 加：强力卸载前先确认

上一版的「强力卸载」点了直接执行——结束进程、删注册表、删目录、删快捷方式
一口气做完，点错了没法撤回。现在先弹确认框，把要做的那五步逐条列出来，
并显示安装目录，用户看清了再点「确认强力卸载」。

## v1.3.0 — 2026-11-25

这一版是安装流程的整体重做：安装不再占着模态框，进度搬到常驻底栏，可以暂停、继续、取消，
而最要命的一条——**装别的软件会把 ToolArk 自己删掉**——也在这里堵住了。

### 修：安装失败后 ToolArk 自己消失了（最严重）

现象：在 ToolArk 里装 OpenShot，装完 `E:\AI软件测试\toolark.exe` 和 `toolark_lib.dll`
都不见了，只剩一堆 OpenShot 的文件；但注册表里 ToolArk 还标着 1.2.3 已安装。

原因：`E:\AI软件测试\` 同时是 ToolArk 自己的安装目录，又是 ToolArk 的默认安装位置。
winget 调起 OpenShot 的 Inno Setup 安装器后，安装器把这个目录当成"自己的地盘"，
清理旧版本时按自己的文件清单删了一遍——ToolArk 的两个文件就在清单之外，被一起清掉了。

现在装任何东西之前先过四道检查：目标目录等于或位于 ToolArk 自己所在目录 → 拒绝；
目标目录里已经有 `toolark.exe` / `toolark_lib.dll` → 拒绝；命中系统目录
（`C:\Windows`、`Program Files`、`ProgramData`、`Users`、盘根）→ 拒绝并要求建专属子目录；
其余情况允许但留日志。安装完成后还会回查一次自己的文件是否还在，不在就在结果里警告。

### 新增：后台下载队列

安装从模态框里搬出来，进入右下角的「正在下载」面板（`.dock`）。加进队列就能继续挑别的软件，
面板显示每个包的圆环进度、当前阶段（下载 / 安装）、暂停与取消按钮。

队列是**串行**的：winget 对 msiexec 是独占的，并发装两个会直接报 `0x800700aa`（资源忙）。
暂停中的项也不会让队列往下走——暂停只是冻结进程，文件锁和独占还握着，此时开下一个必炸。

### 新增：macOS 圆环进度

`ProgressRing` 用 SVG 画，`stroke-dasharray` + `stroke-dashoffset` 走 CSS 过渡，
不占主线程也不吃 GPU。折叠头是 30px 的总进度环，列表每项 34px；暂停时环变灰并显示 ❚❚，
完成显示 ✓，失败显示 !。

### 新增：暂停 / 继续 / 取消安装

暂停不是挂起 winget 一个进程——真正在下载和解包的是它拉起的 msiexec / Inno Setup / NSIS。
`proc_ctl.ps1` 用 `NtSuspendProcess` 冻结**整棵进程树**（按 `ParentProcessId` 做 BFS，
上限 512 个），继续时 `NtResumeProcess` 原样放开，已下载的字节全部保留。

取消走 `kill` 动作，倒序终止（先子孙后父，否则父一死子进程会被系统重新挂载就找不到了）。
之后还会 `sweep` 一遍孤儿安装进程——只认 `msiexec` / `setup` / `install` / `unins000` /
`winget` / `dpinst` 这几个名字，且父进程已不在的才算，绝不按"占用高"去猜，那会误杀用户自己的程序。
最后清掉 winget 的 Temp 目录里下了一半的安装包。

### 新增：强力卸载 + 清理注册表

「本机软件」每行多了「强力卸载」按钮，走五步：结束占用进程 → 调卸载器（msiexec 补
`/qn /norestart`，exe 补 `/S`）→ 清 ARP 三个根（HKLM、WOW6432Node、HKCU）里 DisplayName
或 InstallLocation 对得上的条目 → 删残留目录（仅当递归两层内没有 `*.exe`）→ 清开始菜单与
桌面快捷方式。每步的执行结果都会回显，删了几项注册表也写清楚。

另有「清理下载缓存」按钮，扫 `%LOCALAPPDATA%\Packages\Microsoft.DesktopAppInstaller_*`
下的 `LocalState\Temp`，只删安装包不动已装软件。

### 新增：详情页显示安装包体积与建议配置

`winget show` 不给体积，后端对安装器 URL 发 `HEAD` 取 `Content-Length`（失败再用
`Range: bytes=0-0` 解 `Content-Range`），先查本地 winget 缓存命中就直接读文件大小。
实测 OpenShot 248 MB、Git 66.9 MB。建议配置按分类给基线，命中 `blender` / `ollama` /
`visual studio` 这类重负载关键词时抬档。

### 新增：快速套装二级菜单

点套装不再直接全装，而是弹出面板列出包含的软件，默认勾选未安装的那些，可以全选 / 全不选 /
逐个挑，底部按钮显示「加入队列（n）」。

### 新增：首次启动进场景向导，可跳过

第一次打开先走三题问卷（用途 / 习惯 / 优先），选完给推荐清单。每屏右下角都有
「跳过，我自己挑 →」，不想答就直接回主列表。`firstRunDone` 存进设置，只拦一次。

### 清理

删掉 21 个已无引用的 CSS 类（`.drawer` 系列 16 处、`.glass`、`.foot-controls`、
`.detail-section`、`.highlight-*`、`.related-grid`、`.shot-grid`、`.verified-badge`、
`.dsec`、`.btn-install`、`.btn-launch` 等），以及 `.progress` 无限跑马灯。
修掉两个用了不存在变量的地方：圆环的 `var(--danger)` / `var(--ok)`（实际定义的是
`--red` / `--green`，写错会让整圈变成透明）、套装「已安装」标签的 `var(--ok)`。

### 测试

`cargo test --lib` 9 passed；`npm test` 17 passed。`embedded_scripts_contain_cjk`
从只查 2 个脚本扩到全部 7 个——这几个脚本靠 `winget show` 的中文输出做正则匹配，
中文一旦被删干净，BOM 兜底就没人验证了。

## v1.2.3 — 2026-11-25

上一版把分类折叠了，但侧栏底部还是被挤出去——这一版把导航区和底部区拆开，设置入口彻底固定。

### 修：侧栏底部的「设置」和「检查更新」仍然看不到

v1.2.2 折叠了分类，可侧栏整体是 `overflow-y: auto`，导航内容一长，`.sidebar-foot`
（设置、检查更新、版本号）还是被推到滚动区外面。900px 高的窗口里，用户翻到最底也只能
看到「提交工具」，找不到设置入口。

现在把侧栏拆成两段：`.sidebar-scroll` 承载全部导航（品牌、榜单入口、工作区、分类、
工具组）并独立滚动，`.sidebar-foot` 留在外面固定不动，「设置」按钮移到这一区的顶部，
「检查更新」紧随其后，版本号在最下面。窗口再矮，设置和版本号也一直在。

## v1.2.2 — 2026-11-25

自查一轮，修的是「按钮还是对不齐」「点了没反应」这类看着小、实际天天碰到的毛病。

### 修：设置页和网络错误卡里的按钮被拉成整行宽

`src/index.css` 里还留着三处旧按钮定义，其中 `.btn-primary` / `.btn-danger` 带 `flex: 1;
padding: 12px`。后面的统一 token 节虽然改了尺寸，但 `flex: 1` 没被覆盖，于是只要按钮
在 flex 容器里（设置页的「同步代理 / 恢复直连」、网络引导卡的「一键同步代理」）就会
各自撑满一行，两个按钮上下堆叠、宽度还不一致。旧定义已整块删除。

另外删掉 `.btn-get { min-width: 108px }` —— 它让详情页的「获取」比旁边的「打开」宽一截，
和 App Store 那种等宽胶囊正好相反。重复声明的 `.modal-actions` 也一并合并到一处。

### 修：点侧栏不会退出详情页

详情页打开时点任意侧栏项（比如「已安装」），视图状态变了但详情页还压在上面，看起来
像点了没反应。现在切视图和切二级页面都会先清掉当前选中的工具。

### 修：许可证筛选会留下空列表

在「全部」里筛了 MIT，再切到某个分类，如果该分类下没有 MIT 工具就得到一个空列表，
而筛选条上还亮着 MIT，用户完全看不出是筛选造成的。现在切换视图或改搜索词时自动重置
回「全部协议」。

### 修：提示条只能手点关闭

批量卸载、检查更新这类操作的提示会一直压在右下角，直到手动点掉。现在成功类 4 秒、
报错类 8 秒自动消失（报错留久一点，方便看清原因）。

### 界面：侧栏分类可折叠

11 个分类平铺下来，把「工具 / 应用」两组连同设置入口挤到了可视区外，900px 高的窗口
里根本看不到设置。现在默认显示前 6 个分类，下面给一个「更多分类（5）」按钮展开。

## v1.2.1 — 2026-11-25

- 卡片底部的「已安装」标签删掉：右侧已经有「卸载」按钮，重复表达同一件事，
  而且在三列布局下会把标签挤到第二行，让同一排卡片高度不一致。
- `.section-head` 允许折行，并让第一个按钮靠右：窄窗口下「批量卸载 / 检查更新 /
  全部更新」三个按钮不再把标题挤出容器。

## v1.2.0 — 2026-11-25

这一版把「打不开 / 卸不掉」两个真实故障从根上治了，并按 macOS App Store 的排版重做了界面。

### 修：程序文件已被删、注册表还留着的残留条目

用户的 Upscayl 卸载时报 `0x800401f5 : Application not found`，打开时报「未能定位启动程序」。
查下来是真实场景：`E:\AI软件测试\Upscayl.exe` 早已不存在（全盘搜索无结果），但卸载注册表
`2e801529-9c6a-5917-960e-278558728760` 里还留着 DisplayName / DisplayIcon / UninstallString，
winget 因此仍报告 `Upscayl 2.15.0` 已安装，一卸载就去调那个不存在的卸载器。

- `open_tool` 现在区分四种失败并给出可操作的处置：找不到安装记录 / 注册表指向的目录里没有程序文件 /
  缓存的 exe 路径已失效（顺手清掉这条缓存）/ 进程启动失败。前三种都带 `stale` 标记，
  前端据此弹「一键清理残留」，而不是只甩一句错误。
- `uninstall_tool` 命中 `0x800401f5`、`Application not found`、`应用程序未找到`、`0x80070002`
  时自动转入残留清理：删掉对应 ARP 条目与空目录，并从「已安装」列表移除，返回成功而不是报错。
- 新增 `purge_stale` 命令与 `purge_stale.ps1`：只删「DisplayName 匹配且 DisplayIcon 指向的 exe
  确实不存在」的条目；目录要递归两层都找不到任何 exe 才删（宁可留垃圾，不误删用户文件）。

### 新增：扫描本机已安装的软件

- 新增 `scan_local_apps` 命令与 `scan_local.ps1`：扫三根 Uninstall（machine / machine-x86 / user）
  加两级 App Paths，剔除更新补丁、运行库、系统组件，本机实测得到 100 条。
- 扫到的软件会通过 `localMatch.ts` 与清单里的 288 款做匹配（名称全等 100 分 / 去版本号后全等 80 分 /
  词边界前缀 60 分 / 安装目录末段兜底），命中的直接计入「已安装」——不再出现「我明明装了，
  ToolArk 还显示未安装」。`stale` 的残留条目不算已安装，否则用户看到已安装却打不开。
- 新增「本机软件」视图：全部 / 开源收录 / 安装残留三个筛选，可搜索、可跳详情、可一键清理。

### 界面：按 macOS App Store 重排

- 卡片改成三段式（图标 + 名称 + 副标题 / 描述两行 / 底部标签与操作），去掉顶部液体反光、
  投影和 hover 位移；「获取」改成 App Store 那种胶囊按钮，「打开」与「获取」共用同一尺寸。
- 侧栏收窄到 248px，选中项从大面积渐变填充改成 11% 品牌色底 + 品牌色文字，删掉左侧指示条；
  榜单入口从紫色渐变横幅改成安静的浅色卡。
- 顶栏改成工具条：搜索框缩到 320px 靠右，统计信息移到左侧。
- 详情页、设置页、排行榜、场景向导统一：一层描边、无玻璃、无投影；分组标题不再全大写 + 大字距
  （中文被强行拉宽很难看）。
- 按钮体系统一：新增 `--btn-h / --btn-h-sm / --btn-px / --btn-fs / --btn-r / --btn-r-pill` token，
  把所有按钮类收敛到同一套尺寸与形状，删掉 `.btn-install`、`.btn-launch`、`.detail-hint`
  这些已经没人引用的死样式。

## v1.1.2 — 2026-11-25

- 安装位置核对的第三个盲区：缓存。`lookup_app` 的命中判定只要求 exe 存在，
  v1.0.2 及更早版本写下的 `app-paths.v2.json` 条目没有 `installLocation` 字段
  （升级后反序列化是 `None`），于是升级到 1.1.x 的用户做安装位置核对时
  永远拿到「无法确认是否采用了你选择的路径」——缓存太老，回读值进不来。
  把缓存文件名从 `v2` 升到 `v3`：一次改名，所有旧条目作废，强制重扫注册表。

## v1.1.1 — 2026-11-25

- 榜单重算的依赖项写错了：`RankView` 的 `useMemo` 依赖了`已刷新条数`，第二次刷新拿到的新值
  条数不变时不会触发重排。改成依赖单调递增的数据版本号（`downloadsVersion()`），任何一次
  合并都会重排。`useTools` 的分类视图排序同理。

## v1.1.0 — 2026-11-25

三个长期被「看起来能用」掩盖的问题：安装位置是猜的、安装过程停不下来、下载榜数据是死的。

- **安装位置不再是猜的**。原来靠 winget 的退出码推断：返回 0 就当 `--location` 生效了，
  于是「已装到自定义位置 D:\Apps\Foo」这句话在大量 MSI 上是假的——它们静默忽略
  `--location` 仍返回 0，用户以为装到 D 盘，实际躺在 C 盘。现在安装结束后从卸载注册表
  回读 `InstallLocation`（`app_lookup.ps1` 新增该字段，Rust 侧 `AppTarget.install_location`），
  拿真值和用户请求的路径做归一化比对（忽略大小写、尾部分隔符），三种结论各不相同：
  一致 → `已装到自定义位置 …`；不一致 → `该安装器忽略了你指定的目录，实际装在 …`；
  回读不到 → 如实说 `无法确认是否采用了你选择的路径`，绝不臆断。比对逻辑抽成
  `describe_location()` 纯函数，配 6 条断言覆盖全部组合。安装日志同时记下
  `请求=… 实际=… used_location=…`，以后用户报「装错盘」能直接查。
- **安装可以中途取消**。此前一旦开始就没有出口：某个包卡在 GitHub Release 上反复重试时，
  除了结束 ToolArk 进程别无他法（连带把已排队的东西全丢掉）。新增 `RunRegistry`
  按 tool_id 记住 winget 子进程 PID，`cancel_install` 命令用 `taskkill /T /F` 连同
  安装器的孙进程（msiexec）一起结束——只杀 winget 会留下孤儿安装进程继续写盘。
  取消后不会静默成功：`run_winget_stream` 直接按失败返回，`install_tool` 走回滚卸载，
  错误信息是「已取消 X 的安装，残留已清理」，而不是把 winget 的堆栈糊到用户脸上。
  每次安装开始前清掉同 ID 的旧取消标记，避免上一次的取消误伤这一次。
  前端在进度条下加了「取消安装」按钮，点击后置灰显示「正在取消…」。
- **下载榜会自己更新**。`downloads.ts` 是构建时快照，装完就不动了，榜单会慢慢失真。
  新增 `src/lib/downloadsLive.ts`：启动 8 秒后（避开首屏与 winget 扫描）异步拉一次
  `api.github.com/repos/{owner}/{repo}/releases`，累加 `assets[].download_count`，
  合并进内存并通知 UI 重排。三个克制的地方——只刷下载量前 48 个仓库（未认证限流
  60 次/小时，288 个全刷会 403）、并发上限 6、整体 30 秒超时；成功结果写 localStorage
  并按 12 小时 TTL 复用，冷启动先用缓存点亮再判断要不要真拉。全程静默失败：
  拿不到数据就继续用内置快照，不弹任何提示。`downloadsOf()` 与排行榜文案的数据时间
  都改读可变状态，榜单页会显示「已后台刷新 N 款」。

## v1.0.2 — 2026-11-25

修 v1.0.1 装到真机上才暴露的三个运行期 bug。这三个都是「单元测试全绿、真实环境才崩」的类型，
所以这一版补的测试都直接喂真实输出。

- **已安装状态一直是空的**。`winget list` 的真实输出只有「名称 / ID / 版本 / 可用」四列，
  没有 Source 列，而解析器强制要求行尾是 `winget`/`msstore` → 每一行都被丢弃，日志里只有
  `[scan] winget list 解析出 0 个包`。改为「从右往左找包 ID」并兼容带 Source 列的旧格式，
  实测能解析出 70 个真实包。新增两条回归测试，一条喂真实四列中文输出，一条守「名称里带点
  不能被误认成 ID」（`7-Zip 24.09` 对 `7zip.7zip`）。
- **程序定位会选错 exe**。原来按体积挑主程序，`Git` 被定位到 `git-lfs.exe`（比 `git.exe` 大）。
  改为「文件名与应用名/显示名/安装目录名归一化比对」打分，明确的附属程序名（`lfs`、`daemon`、
  `service`、`cli`、`crashpad`、`updater`）扣分；`DisplayIcon` 不再盲信（Git 的 DisplayIcon
  指向的就是 `git-lfs.exe`）。同时加两阶段深度搜索，浅搜（Depth 2）没命中文件名再深搜
  （Depth 4）——Epic Games Launcher 的主 exe 埋在 `Launcher\Portal\Binaries\Win64` 下。
- **PS1 助手脚本在真机解析失败**。`materialize_script` 写的是无 BOM 的 UTF-8，
  Windows PowerShell 5.1 在无 BOM 时按系统 ANSI（简中为 GBK）解码，脚本里的中文注释被拆成
  非法字节 → 花括号配对失衡，报 `表达式或语句中包含意外的标记"}"`，桌面快捷方式与「打开」
  按钮全部失效。改为落盘时写 UTF-8 BOM。新增 `script_bytes_starts_with_utf8_bom` 与
  `embedded_scripts_contain_cjk` 两条测试守住这个前提。
- 应用路径缓存文件名带版本号（`app-paths.v2.json`）：上一版把 Git 缓存成了 `git-lfs.exe`，
  不清缓存的话升级后仍然打开错程序。
- `InstalledPackage` 派生 `Debug`，测试断言失败时能直接打印实际解析结果。

## v1.0.1 — 2026-11-25

补齐 v1.0.0 遗留的预览图缺口。

- **288 款工具全部有预览图**。v1.0.0 里 4 个工具的代码不在 GitHub（Inkscape、MKVToolNix、PuTTY 在
  GitLab 或自建 Git，EmulationStation DE 在 GitLab），README 抓图脚本够不到，详情页会落到「暂未内置截图」
  占位。改用官方页面与自由授权截图补齐：Inkscape / MKVToolNix 取 Wikimedia Commons，
  EmulationStation DE 取官方文档 CDN，PuTTY 取已验证可访问的一张。
- `tauri.conf.json` 的 CSP `img-src` 放行 `upload.wikimedia.org` 与 `cdn.es-de.org`，否则新图会被拦。
- 新增 `scripts/selfcheck.py`：一条命令核对 i18n key 完整性、排序口径、下载量与截图覆盖率、
  三处版本号一致性、CSP 与插件配置。CI 与本地都能跑。
- 修正 `selfcheck.py` 的工具计数：套装（BUNDLES）没有 `wingetId`，不该算进工具总数。

## v1.0.0 — 2026-11-24

首个正式版。相较 v0.9.0 的改动全部围绕「用户能不能信这个工具」展开。

### 榜单口径修正

- **下载榜取代星标榜**。`src/lib/search.ts` 新增 `rankByDownloads()`，排序键改为
  `src/data/downloads.ts` 里的 GitHub Release 资产累计下载量（`assets[].download_count` 求和），
  star 只作为并列时的兜底。新增 `scripts/fetch_downloads.py` 生成该快照，
  `npm run fetch-downloads` 可随时刷新。
- 排行榜默认标签从「热门」改为「📥 下载榜」，并删掉了原来那句
  「星标比任何"下载量"都透明」的说明——那句话是在为用户没要的指标找理由。
- 界面上的每张卡片、详情页、对比表都显示真实下载量（`formatDownloads`：1.2k / 2.4M）。

### 已安装状态改为可信

- 新增 `scan_installed` 命令，跑 `winget list --source winget` 并解析真实包列表；
  前端 `useTools.ts` 的 `calibrate()` 把本地记录与真实包列表取交集。
  以前只读本地 `installed.json`，用户自己用 winget 装的工具永远显示「未安装」，
  手动卸载的又一直显示「已安装」。
- 新增 `parse_package_table()` 解析器：不按固定列宽切分（中文双宽字符会让列错位），
  改为「从右往左」定位包 ID、名称与版本。附 4 个单元测试。
- 本地记录改为 `persist_installed` 命令写入，逐项 `validate_id` 过滤后去重。

### 安装后自动建桌面快捷方式 + 应用页「打开」按钮

- 安装成功后自动定位真实可执行文件（三级回退：卸载注册表项的 `DisplayIcon` →
  `InstallLocation` 递归找主 exe → `App Paths`），并在桌面创建 `.lnk`。
  两个 PowerShell 助手脚本用 `include_str!` 编进二进制，运行时释放到
  `app_data_dir/scripts/`，不会出现「exe 与脚本版本不一致」。
- 工具卡片与详情页新增「▶ 打开应用」按钮（`open_tool` 命令，DETACHED_PROCESS 启动，
  不占用应用进程）。定位结果缓存在 `app-paths.json`，exe 不存在时自动重查。

### 网络失败可自救

- 新增 `analyzeNetworkError()`：识别 `0x80072efd` / `12029` / `0x80072ee7` / `12007` /
  `0x80072ee2` / `12002` 等错误码，判定为「winget 走 WinHTTP 通道，不读浏览器代理」。
- 安装失败时不再只显示一行红字，而是弹出网络卡片，给出一键
  「把系统代理同步到 WinHTTP」（`sync_winhttp_proxy`，UAC 提权执行 `netsh`）、
  「恢复直连」（`reset_winhttp_proxy`）、「反馈问题」三个动作。
- 设置页新增「网络代理」区块，显示 `系统代理（WinINET）` 与 `WinHTTP` 当前值。

### 工程与安全

- `tauri.conf.json` 的 `csp` 从 `null` 改为白名单策略（脚本仅 `'self'`，
  图片放行 `cdn.simpleicons.org` / `raw.githubusercontent.com`，`frame-src 'none'`）。
- `capabilities/default.json` 删掉三条已失效的 `shell:allow-*` 权限；
  `Cargo.toml` 移除 `tauri-plugin-shell`，改用 `tauri-plugin-single-instance`
  （多实例会并发写 `installed.json` 互相覆盖）。
- release 构建开启 `lto = true` / `codegen-units = 1` / `strip = true`。
- 新增日志落盘：`%APPDATA%\com.toolark.app\logs\day-<n>.log`，保留 7 天；
  设置页可「查看最近日志」与「导出诊断包」（含版本、winget 版本、代理状态、日志）。
- 新增测试：`src/lib/search.test.ts`（11 个前端用例，`node --test` 直跑 TS）、
  `src-tauri/src/lib.rs` 的 4 个 Rust 用例。
- CI：`build.yml` 与 `health-check.yml` 从 `ubuntu-latest` 换到 `windows-latest`，
  否则 `scripts/health_check.py:185` 的 `sys.platform != "win32"` 判断会让 winget 校验
  永远跳过（历史报告里就是 `winget 0/250`）。新增 `cargo fmt --check`、`cargo test --lib`
  与 MSI 打包 smoke job。
- 补齐 `LICENSE`（MIT）、`SECURITY.md`。

### 修掉的 bug

- 对比页 `<td>tool.stars</td>` / `<td>tool.lastUpdate</td>` 漏花括号，
  页面上直接渲染出 `tool.stars` 字面量。
- 设置页「关于」硬编码 `v0.4.0`，改为读 `package.json`。
- `parseStars()` 遇到缺失的 `stars` 字段抛 `TypeError`，改为容忍 `undefined`。
- `scripts/fetch_downloads.py` 用 `repo.rstrip(".git")` 剥后缀，`rstrip` 按字符集剥离，
  把 `lazygit` 截成 `lazy`、`git` 截成空串，导致 35 个仓库 404。改用后缀判断。
- 侧栏语言/主题按钮的 props 早已没有渲染，仍一路传参；`mode-badge` 靠 DOM
  `textContent` 篡改文案。两处都改成正常的 React 数据流。

### 尚未做

- MSI 与 exe 仍未代码签名（`Get-AuthenticodeSignature` → `NotSigned`），
  首次安装会弹 SmartScreen「未知发布者」。签名需要代码签名证书，不在本次范围。
