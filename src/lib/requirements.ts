import type { Tool } from '../data/tools';

/**
 * 推荐配置。
 *
 * 这批工具没有一个统一的 manifest 会写最低配置，winget 的清单里也没有这个字段，
 * 所以只能按分类给基线，再对几类特别吃硬件的工具单独抬一档（视频剪辑、3D、
 * 本地大模型、IDE）。界面上会标成「建议配置」而不是「官方最低配置」，
 * 免得用户拿它当厂商承诺。
 */
export interface Requirements {
  /** 内存 */
  ram: string;
  /** 磁盘（不含安装包本身之外的缓存） */
  disk: string;
  /** 其它要点，可能为空 */
  note: string;
}

const BASELINE: Requirements = { ram: '4 GB', disk: '500 MB', note: '' };

const BY_CATEGORY: Record<string, Requirements> = {
  dev: { ram: '8 GB', disk: '2 GB', note: 'SSD 更佳（索引与构建）' },
  design: { ram: '8 GB', disk: '2 GB', note: '独立显卡更佳' },
  media: { ram: '8 GB', disk: '1 GB', note: '播放 4K 需硬件解码' },
  game: { ram: '8 GB', disk: '2 GB', note: '需支持 Vulkan/D3D11 的显卡' },
  ai: { ram: '16 GB', disk: '10 GB', note: '建议有独立显卡（显存 6 GB 起）' },
  system: { ram: '4 GB', disk: '300 MB', note: '' },
  office: { ram: '4 GB', disk: '500 MB', note: '' },
  network: { ram: '4 GB', disk: '300 MB', note: '' },
  security: { ram: '4 GB', disk: '500 MB', note: '' },
  social: { ram: '4 GB', disk: '300 MB', note: '' },
  entertainment: { ram: '4 GB', disk: '500 MB', note: '' },
};

/** 命中这些关键词的工具普遍比同类更吃资源，单独抬一档 */
const HEAVY: { test: RegExp; req: Requirements }[] = [
  {
    test: /blender|freecad|krita|gimp|inkscape|openshot|shotcut|kdenlive|obs|audacity|handbrake|davinci/i,
    req: { ram: '16 GB', disk: '5 GB', note: '建议独立显卡 + SSD' },
  },
  {
    test: /ollama|lm studio|llama|stable diffusion|comfyui|whisper/i,
    req: { ram: '16 GB', disk: '20 GB', note: '模型文件另需数十 GB，建议独显' },
  },
  {
    test: /visual studio|intellij|android studio|unity|godot|rustrover|webstorm/i,
    req: { ram: '16 GB', disk: '10 GB', note: 'SSD 强烈建议（索引与构建缓存）' },
  },
];

export function requirementsOf(tool: Tool): Requirements {
  const hay = `${tool.id} ${tool.name} ${tool.wingetId} ${tool.tags.join(' ')}`;
  for (const h of HEAVY) {
    if (h.test.test(hay)) return h.req;
  }
  return BY_CATEGORY[tool.category] ?? BASELINE;
}
