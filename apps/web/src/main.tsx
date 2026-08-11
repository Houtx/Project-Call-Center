import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { AuthProvider } from './auth/AuthContext';
import App from './App';
import { RouterProvider } from './router';
import './styles.css';

dayjs.locale('zh-cn');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#087f7a',
          colorInfo: '#087f7a',
          colorSuccess: '#2f855a',
          colorWarning: '#b7791f',
          colorError: '#c2413a',
          borderRadius: 6,
          fontFamily: "Inter, 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
          colorText: '#1b2733',
          colorTextSecondary: '#657483',
          colorBgLayout: '#f3f6f7',
        },
        components: {
          Button: { controlHeight: 36 },
          Input: { controlHeight: 36 },
          Select: { controlHeight: 36 },
          Table: { headerBg: '#f7f9fa', headerColor: '#4b5b68', cellPaddingBlock: 12 },
          Card: { borderRadiusLG: 8 },
        },
      }}
    >
      <AntApp>
        <RouterProvider>
          <AuthProvider><App /></AuthProvider>
        </RouterProvider>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
