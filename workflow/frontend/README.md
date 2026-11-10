# 工作流前端

React + TypeScript + shadcn/ui（Radix）+ Tailwind CSS，通过 Vite 构建。

- App.tsx：团队筛选、看板、轮询、弹窗与全局状态。
- Detail.tsx：需求分析、任务计划、执行历史、验收、返修及通知。
- types.ts / api.ts：接口类型、JSON 请求与展示格式。
- components/ui：来自 shadcn 官方 new-york 注册表的组件源码，允许按本项目主题修改。
- style.css / base.css：柔和色板、圆角及响应式布局。

在 workflow 根目录运行 `npm install`、`npm run build`、`npm start`。构建产物位于 frontend/dist，不提交运行凭据或数据库。

shadcn/ui 源码采用 MIT 许可证，来源 https://ui.shadcn.com ，许可证 https://github.com/shadcn-ui/ui/blob/main/LICENSE.md 。Radix、React、Tailwind 和其他依赖遵循各自 npm 包附带的许可证。
