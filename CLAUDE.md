# CLAUDE.md

## 一、项目概述

账单汇总项目：聚合多数据源交易流水，完成清洗、归类、对账，服务分析与报表。
项目为个人维护，**禁止过度设计与复杂架构。**

当前仓库已迁移为**纯后端架构**（Fastify + Prisma），不再使用 Next.js 页面与 App Router。

## 二、语言与文档

- 代码标识符（变量/函数/类名）遵循最佳实践，使用英文
- 技术配置文件（JSON/YAML/TOML/CI 等），使用英文
- 仅在以下情况使用中文：
  - 全部对话、文档、说明、注释使用中文（简体）
  - 用户明确要求

## 三、编码规范

- **遵循 KISS**，优先简洁直观的实现
- 沿用现有后端结构：
  - 应用入口：`src/server/index.ts`
  - 应用组装：`src/server/app.ts`
  - 路由目录：`src/server/routes/*`
- 新增接口优先按业务域拆分到对应 route 文件，避免堆到单一文件

## 四、测试规范

- 测试框架：Vitest
- 测试目录：`src/__tests__/`
- 优先写 API 集成测试，避免浏览器端 E2E
- 运行方式：
  - `npm test`：通过 `scripts/run-tests-with-server.js` 启动/复用服务并执行测试
  - `npm run test:inner`：仅运行 Vitest
- 涉及数据库测试时，遵循现有测试脚本的测试库重置与安全限制（默认 `dev-test.db`）

## 五、常用脚本

- `npm run dev`：启动后端开发服务（`tsx watch src/server/index.ts`）
- `npm run build`：类型检查（`tsc --noEmit`）
- `npm run start`：启动后端服务

## 六、子代理

使用 Task 工具调用：

- **code-simplifier**：代码简化与重构
  触发：用户说“调用code-simplifier”或要求优化代码
  配置：`.claude/agents/code-simplifier.md`