/** 轻量 i18n：中英双语，无外部依赖 */
export type Lang = 'zh' | 'en';

export const STRINGS = {
  zh: {
    workspace: '工作区', categories: '分类', featured: '精选', all: '全部工具', installed: '已安装',
    checkUpdate: '检查更新', checking: '检查中…', previewMode: '浏览器预览模式', desktopMode: '桌面应用模式 · winget 可用',
    tools: '款工具', installedCount: '已装', search: '搜索工具、场景或标签…',
    quickBundles: '快速套装', bundleHint: '不知道装什么？从场景开始', installing: '正在安装…',
    batchUninstall: '批量卸载全部', noInstalled: '还没安装任何工具，去「精选」逛逛吧',
    noResult: '没有找到匹配的工具，换个关键词试试',
    install: '一键安装', uninstall: '卸载', detail: '详情',
    stars: 'Star', updated: '最近更新', source: '来源透明', verified: '已验证开源',
    repo: '源码仓库', license: '许可证', openSource: '开源', packageId: '包 ID', homepage: '主页',
    scenarios: '适用场景', info: '工具信息', licenseFilter: '许可证', allLicenses: '全部协议',
    installPreview: '安装预览', confirmInstall: '确认安装', cancel: '取消', done: '完成',
    uninstallConfirm: '确认卸载', uninstallHint: '此操作将通过 winget 移除软件', uninstalling: '正在卸载…',
    keepConfig: '保留配置文件', cleanConfig: '同时清理配置目录（不可恢复）',
    installLocation: '安装位置', installLocationHint: '留空使用默认路径（如 D:\\Program Files\\App）', installLocationTip: '部分安装器（MSI）不支持自定义位置，会自动回退到默认路径', browse: '选择目录',
    configBackup: '配置备份', configRestore: '配置还原', sceneGuide: '场景向导', compare: '工具对比',
    submit: '提交工具', theme: '主题', lang: '语言', dark: '深色', light: '浅色',
    configTip: '开源工具配置均为文本文件，备份后可一键还原到新电脑',
    exportConfig: '导出配置备份', importConfig: '导入配置还原', noConfig: '当前没有可备份的配置',
    sceneTitle: '你主要用电脑做什么？', sceneHint: '选择场景，我们帮你挑出合适的开源工具',
    sceneNext: '看看推荐', sceneBack: '返回', sceneDone: '去安装',
    compareTitle: '同类工具对比', compareHint: '选择一个分类，横向比较同类开源工具',
    noCompare: '该分类暂无可比对的同类工具', submitTitle: '提交开源工具',
    submitHint: '生成符合收录规范的 manifest，复制后到 GitHub 建 Issue 提交',
    submitOk: '已生成 manifest 片段，复制后到 GitHub 仓库新建 Issue 粘贴即可',
    openApp: '打开', downloads: '下载量', networkProxy: '网络代理',
  },
  en: {
    workspace: 'Workspace', categories: 'Categories', featured: 'Featured', all: 'All Tools', installed: 'Installed',
    checkUpdate: 'Check Updates', checking: 'Checking…', previewMode: 'Browser Preview', desktopMode: 'Desktop Mode · winget ready',
    tools: 'tools', installedCount: 'Installed', search: 'Search tools, scenarios or tags…',
    quickBundles: 'Quick Bundles', bundleHint: 'Not sure what to install? Start here', installing: 'Installing…',
    batchUninstall: 'Uninstall All', noInstalled: 'Nothing installed yet. Explore Featured.',
    noResult: 'No matching tools. Try another keyword.',
    install: 'Install', uninstall: 'Uninstall', detail: 'Details',
    stars: 'Stars', updated: 'Last Update', source: 'Transparent', verified: 'Verified Open Source',
    repo: 'Repository', license: 'License', openSource: 'Open Source', packageId: 'Package ID', homepage: 'Homepage',
    scenarios: 'Use Cases', info: 'Tool Info', licenseFilter: 'License', allLicenses: 'All Licenses',
    installPreview: 'Install Preview', confirmInstall: 'Confirm Install', cancel: 'Cancel', done: 'Done',
    uninstallConfirm: 'Confirm Uninstall', uninstallHint: 'This will remove the software via winget', uninstalling: 'Uninstalling…',
    keepConfig: 'Keep config files', cleanConfig: 'Also clean config directory (irreversible)',
    installLocation: 'Install location', installLocationHint: 'Leave empty for default (e.g. C:\\Program Files\\App)', installLocationTip: 'Some installers (MSI) do not support custom locations and will fall back to default', browse: 'Browse',
    configBackup: 'Config Backup', configRestore: 'Config Restore', sceneGuide: 'Scenario Guide', compare: 'Compare Tools',
    submit: 'Submit Tool', theme: 'Theme', lang: 'Language', dark: 'Dark', light: 'Light',
    configTip: 'Open-source configs are text files. Back up and restore to a new PC in one click',
    exportConfig: 'Export Config Backup', importConfig: 'Import & Restore', noConfig: 'No config available to back up',
    sceneTitle: 'What do you mainly use your PC for?', sceneHint: 'Pick a scenario and we will recommend open-source tools',
    sceneNext: 'Show Recommendations', sceneBack: 'Back', sceneDone: 'Install Now',
    compareTitle: 'Compare Similar Tools', compareHint: 'Pick a category to compare open-source alternatives',
    noCompare: 'No comparable tools in this category', submitTitle: 'Submit Open-Source Tool',
    submitHint: 'Generates a manifest that follows the inclusion rules — paste it into a GitHub issue',
    submitOk: 'Manifest generated. Paste it into a new issue on the GitHub repo.',
    openApp: 'Open', downloads: 'Downloads', networkProxy: 'Network proxy',
  },
} as const;

export type StringKey = keyof typeof STRINGS.zh;

export function t(lang: Lang, key: StringKey): string {
  return STRINGS[lang][key];
}
