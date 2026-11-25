import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { bootstrapDownloads } from './lib/downloadsLive';
import './index.css';

// 内置下载量是构建时快照，这里异步补一次真实数据；失败静默，不阻塞首屏
bootstrapDownloads();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
