import '@ant-design/v5-patch-for-react-19'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#197465',
          colorLink: '#197465',
          colorInfo: '#2e74fd',
          colorSuccess: '#2ead67',
          colorWarning: '#c98d58',
          colorError: '#e5483f',
          colorText: '#222222',
          colorTextSecondary: '#666666',
          colorTextTertiary: '#999999',
          colorTextQuaternary: '#c7c7c7',
          colorBorder: '#d9d9d9',
          colorBorderSecondary: '#e5e5e5',
          colorBgContainer: '#ffffff',
          colorBgLayout: '#f5f7fa',
          borderRadius: 4,
          borderRadiusXS: 2,
          borderRadiusSM: 4,
          borderRadiusLG: 8,
          fontSize: 14,
          lineHeight: 1.57,
          fontSizeHeading1: 36,
          fontSizeHeading2: 24,
          fontSizeHeading3: 18,
          fontSizeHeading4: 16,
          fontFamily: 'Roboto, -apple-system, BlinkMacSystemFont, "PingFang SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif',
          boxShadow: '0 6px 18px rgba(34, 34, 34, 0.08)',
          boxShadowSecondary: '0 12px 32px rgba(34, 34, 34, 0.12)',
        },
        components: {
          Button: {
            controlHeight: 32,
            controlHeightLG: 40,
            controlHeightSM: 28,
            borderRadius: 4,
            primaryShadow: '0 4px 12px rgba(25, 116, 101, 0.18)',
          },
          Card: { borderRadiusLG: 8, paddingLG: 24 },
          Input: { activeBorderColor: '#197465', hoverBorderColor: '#197465' },
          InputNumber: { activeBorderColor: '#197465', hoverBorderColor: '#197465' },
          Select: { activeBorderColor: '#197465', hoverBorderColor: '#197465', optionSelectedBg: '#e7f5f2' },
          Menu: {
            itemBorderRadius: 4,
            itemHeight: 40,
            itemMarginBlock: 4,
            itemSelectedBg: '#197465',
            itemSelectedColor: '#ffffff',
            itemHoverBg: '#e7f5f2',
            itemHoverColor: '#197465',
            subMenuItemBg: 'transparent',
            subMenuItemSelectedColor: '#197465',
          },
          Table: {
            headerBg: '#f5f7fa',
            headerColor: '#222222',
            headerSplitColor: '#e5e5e5',
            borderColor: '#e5e5e5',
            rowHoverBg: '#f2f9f8',
            rowSelectedBg: '#e7f5f2',
            rowSelectedHoverBg: '#d9efea',
            cellPaddingBlock: 12,
          },
          Tabs: {
            itemColor: '#666666',
            itemHoverColor: '#57ad9e',
            itemActiveColor: '#145f52',
            itemSelectedColor: '#197465',
            inkBarColor: '#197465',
            titleFontSize: 14,
            horizontalItemGutter: 28,
          },
          Pagination: {
            itemActiveBg: '#197465',
            itemBg: '#f5f7fa',
          },
          Modal: { borderRadiusLG: 12, titleFontSize: 18 },
          Tag: { defaultBg: '#f2f9f8', defaultColor: '#197465' },
        },
      }}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ConfigProvider>
  </React.StrictMode>,
)
