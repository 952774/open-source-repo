/** 字节数转人话：winget 报的是安装器体积，动辄几百 MB 到几 GB */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  // 小于 10 的保留一位小数，否则取整——"1.4 GB" 比 "1.44 GB" 好读
  const text = v < 10 && i > 0 ? v.toFixed(1) : Math.round(v).toString();
  return `${text} ${units[i]}`;
}
