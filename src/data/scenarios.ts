/** 场景推荐问卷（F2）与工具对比（F3）的数据定义 */
export interface SceneQuestion {
  id: string;
  question: string;
  questionEn: string;
  options: { id: string; label: string; labelEn: string; icon: string; toolIds: string[] }[];
}

export const SCENE_QUESTIONS: SceneQuestion[] = [
  {
    id: 'role',
    question: '你主要用电脑做什么？',
    questionEn: 'What do you mainly use your PC for?',
    options: [
      { id: 'coding', label: '写程序', labelEn: 'Coding', icon: '💻', toolIds: ['vscode', 'git', 'ripgrep', 'lazygit', 'windows-terminal'] },
      { id: 'office', label: '办公文档', labelEn: 'Office work', icon: '📄', toolIds: ['joplin', 'bitwarden', 'sumatrapdf', 'quicklook'] },
      { id: 'creative', label: '设计创作', labelEn: 'Design & creative', icon: '🎨', toolIds: ['gimp', 'inkscape', 'blender', 'krita', 'obs'] },
      { id: 'media', label: '影音娱乐', labelEn: 'Media & entertainment', icon: '🎬', toolIds: ['vlc', 'lx-music', 'listen1', 'mpv', 'audacity'] },
    ],
  },
  {
    id: 'habit',
    question: '你更喜欢哪种使用方式？',
    questionEn: 'Which usage style do you prefer?',
    options: [
      { id: 'gui', label: '图形界面，点几下就好', labelEn: 'GUI, just click', icon: '🖱️', toolIds: [] },
      { id: 'cli', label: '命令行，效率优先', labelEn: 'CLI, efficiency first', icon: '⌨️', toolIds: ['ripgrep', 'fd', 'fzf', 'starship', 'lazygit'] },
      { id: 'both', label: '都要', labelEn: 'Both', icon: '⚡', toolIds: [] },
    ],
  },
  {
    id: 'priority',
    question: '你最在意什么？',
    questionEn: 'What matters most to you?',
    options: [
      { id: 'privacy', label: '隐私与安全', labelEn: 'Privacy & security', icon: '🔐', toolIds: ['bitwarden', 'keepassxc', 'veracrypt'] },
      { id: 'speed', label: '速度与轻量', labelEn: 'Speed & lightweight', icon: '🚀', toolIds: ['ripgrep', 'fd', 'quicklook', 'alacritty'] },
      { id: 'free', label: '完全免费开源', labelEn: 'Fully free & open source', icon: '🆓', toolIds: [] },
    ],
  },
];

/** 工具对比组（F3）：同 Category 下的同类开源工具 */
export const COMPARE_GROUPS: { id: string; title: string; titleEn: string; toolIds: string[]; aspects: string[] }[] = [
  {
    id: 'terminal', title: '终端模拟器', titleEn: 'Terminal Emulators',
    toolIds: ['windows-terminal', 'alacritty', 'wezterm'],
    aspects: ['GPU 加速', '多标签', '配置方式', '平台'],
  },
  {
    id: 'search', title: '搜索工具', titleEn: 'Search Tools',
    toolIds: ['ripgrep', 'fd', 'fzf'],
    aspects: ['用途', '速度', '正则支持', '生态集成'],
  },
  {
    id: 'music', title: '音乐播放器', titleEn: 'Music Players',
    toolIds: ['lx-music', 'yesplaymusic', 'listen1'],
    aspects: ['音源', '界面', '开源协议', '平台'],
  },
  {
    id: 'password', title: '密码管理', titleEn: 'Password Managers',
    toolIds: ['bitwarden', 'keepassxc'],
    aspects: ['存储方式', '同步', '开源协议', '平台'],
  },
  {
    id: 'editor', title: '代码编辑器', titleEn: 'Code Editors',
    toolIds: ['vscode', 'vscodium', 'zed'],
    aspects:['遥测', '插件生态', '开源协议', '性能'],
  },
];
